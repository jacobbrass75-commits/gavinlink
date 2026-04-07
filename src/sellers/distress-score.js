const { v4: uuidv4 } = require('uuid');
const { query } = require('../db/connection');
const { normalizeName, classifyEntityType } = require('../entities/extract');
const { classifyForeclosureStage } = require('./foreclosure-stage');

function toNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value === 1;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }

  return false;
}

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function parseDate(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeOwnerEntityType(entityType) {
  if (entityType === 'lender' || entityType === 'trustee') {
    return 'unknown';
  }

  return entityType || 'unknown';
}

function getEffectiveLtv(property) {
  const explicitLtv = toNumber(property?.ltv);

  if (explicitLtv != null) {
    return explicitLtv;
  }

  const assessedValue = toNumber(property?.assessed_value);
  const loanAmount = toNumber(property?.loan_amount);

  if (assessedValue && loanAmount != null) {
    return (loanAmount / assessedValue) * 100;
  }

  return null;
}

function getDefaultRatio(property) {
  const assessedValue = toNumber(property?.assessed_value);
  const defaultAmount = toNumber(property?.default_amount);

  if (!assessedValue || defaultAmount == null) {
    return null;
  }

  return defaultAmount / assessedValue;
}

function getEffectiveEquityPercent(property) {
  const rawEquityPercent = toNumber(property?.equity_percent);

  if (rawEquityPercent != null) {
    return rawEquityPercent <= 1 ? rawEquityPercent * 100 : rawEquityPercent;
  }

  const assessedValue = toNumber(property?.assessed_value);
  const equityAmount = toNumber(property?.equity_amount);

  if (!assessedValue || equityAmount == null) {
    return null;
  }

  return (equityAmount / assessedValue) * 100;
}

function getDaysSinceDefault(property) {
  const effectiveDefaultDate = parseDate(property?.default_date || property?.titlepro_recording_date);

  if (!effectiveDefaultDate) {
    return null;
  }

  const diffMs = Date.now() - effectiveDefaultDate.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function computeEstimatedEquity(property) {
  const directEquity = toNumber(property?.equity_amount);

  if (directEquity != null) {
    return directEquity;
  }

  const assessedValue = toNumber(property?.assessed_value);
  const loanAmount = toNumber(property?.loan_amount);

  if (assessedValue != null && loanAmount != null) {
    return assessedValue - loanAmount;
  }

  const effectiveEquityPercent = getEffectiveEquityPercent(property);

  if (assessedValue != null && effectiveEquityPercent != null) {
    return assessedValue * (effectiveEquityPercent / 100);
  }

  return null;
}

function getDefaultTimeline(stage, distressLevel) {
  if (stage === 'auction_pending' || stage === 'reo' || distressLevel >= 4) {
    return 'urgent';
  }

  if (stage === 'notice_of_sale') {
    return '30_days';
  }

  if (stage === 'notice_of_default') {
    return '60_days';
  }

  if (stage === 'pre_foreclosure') {
    return '90_days';
  }

  return 'flexible';
}

function clampScore(value) {
  return Math.max(1, Math.min(5, Math.round(value)));
}

function getDistressAssessment(property, context = {}) {
  let points = 0;
  const flags = [];
  const assessedValue = toNumber(property?.assessed_value, 0);
  const ltv = getEffectiveLtv(property);
  const defaultRatio = getDefaultRatio(property);
  const effectiveEquityPercent = getEffectiveEquityPercent(property);
  const daysSinceDefault = getDaysSinceDefault(property);
  const ownerForeclosureCount = Number(context.owner_foreclosure_count || 0);

  if (toBoolean(property?.foreclosure)) {
    points += 1;
    flags.push('foreclosure');
  }

  if (ltv != null && ltv > 80) {
    points += 1;
    flags.push('high_ltv');
  }

  if (defaultRatio != null && defaultRatio > 0.1) {
    points += 1;
    flags.push('large_default');
  }

  if (toBoolean(property?.owner_occupied)) {
    points += 1;
    flags.push('owner_occupied');
  }

  if (daysSinceDefault != null && daysSinceDefault > 180) {
    points += 1;
    flags.push('stale_default');
  }

  if (effectiveEquityPercent != null && effectiveEquityPercent < 20) {
    points += 0.5;
    flags.push('low_equity');
  }

  if (ownerForeclosureCount >= 2) {
    points += 0.5;
    flags.push('portfolio_distress');
  }

  if (points <= 1 && toBoolean(property?.foreclosure)) {
    if (cleanText(property?.trustee_phone)) {
      points += 0.5;
      flags.push('active_trustee_contact');
    }

    if (assessedValue >= 10000000) {
      points += 0.5;
      flags.push('high_value_asset');
    }

    if (toNumber(property?.sq_feet, 0) >= 50000 || toNumber(property?.units, 0) >= 50) {
      points += 0.5;
      flags.push('large_asset');
    }
  }

  return {
    score: clampScore(points || 1),
    raw_points: points || 1,
    flags
  };
}

function calculateDistressScore(property, context = {}) {
  return getDistressAssessment(property, context).score;
}

async function findOrCreateOwnerEntity(property) {
  if (property?.owner_entity_id) {
    return property.owner_entity_id;
  }

  const ownerName = cleanText(property?.owner_name);

  if (!ownerName) {
    return null;
  }

  const normalizedName = normalizeName(ownerName);
  const entityType = normalizeOwnerEntityType(classifyEntityType(ownerName, 'owner_name'));
  const existingResult = await query(
    `
      SELECT id
      FROM entities
      WHERE normalized_name = $1
        AND entity_type = $2
      LIMIT 1
    `,
    [normalizedName, entityType]
  );

  if (existingResult.rows[0]) {
    return existingResult.rows[0].id;
  }

  const id = uuidv4();
  await query(
    `
      INSERT INTO entities (
        id,
        name,
        normalized_name,
        entity_type,
        source,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (normalized_name, entity_type)
      DO UPDATE SET updated_at = NOW()
    `,
    [id, ownerName, normalizedName, entityType, 'seller_intelligence', JSON.stringify({ tags: ['seller'] })]
  );

  const entityResult = await query(
    `
      SELECT id
      FROM entities
      WHERE normalized_name = $1
        AND entity_type = $2
      LIMIT 1
    `,
    [normalizedName, entityType]
  );

  const entityId = entityResult.rows[0]?.id || id;

  await query(
    `
      UPDATE properties
      SET owner_entity_id = $2,
          updated_at = NOW()
      WHERE id = $1
        AND owner_entity_id IS NULL
    `,
    [property.id, entityId]
  );

  return entityId;
}

async function getOwnerForeclosureCounts() {
  const result = await query(
    `
      SELECT owner_entity_id, COUNT(*)::int AS count
      FROM properties
      WHERE foreclosure = TRUE
        AND owner_entity_id IS NOT NULL
      GROUP BY owner_entity_id
    `
  );

  return new Map(result.rows.map((row) => [row.owner_entity_id, row.count]));
}

async function batchScoreProperties(options = {}) {
  const limit = Math.max(Number(options.limit) || 0, 0);
  const rescore = Boolean(options.rescore);
  const ownerForeclosureCounts = await getOwnerForeclosureCounts();
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const propertiesResult = await query(
    `
      SELECT
        p.*,
        sp.id AS seller_profile_id,
        sp.distress_level AS existing_distress_level,
        sp.motivation AS existing_motivation,
        sp.timeline AS existing_timeline,
        sp.lender_status AS existing_lender_status,
        sp.status AS existing_status,
        sp.source AS existing_source
      FROM properties p
      LEFT JOIN seller_profiles sp ON sp.property_id = p.id
      ORDER BY p.created_at ASC, p.apn ASC
      LIMIT $1
    `,
    [limit > 0 ? limit : 1000000]
  );

  let scored = 0;
  let skipped = 0;

  for (const property of propertiesResult.rows) {
    if (!rescore && property.seller_profile_id && property.existing_distress_level != null) {
      skipped += 1;
      continue;
    }

    const ownerEntityId = await findOrCreateOwnerEntity(property);
    const ownerForeclosureCount = ownerForeclosureCounts.get(ownerEntityId) || 0;
    const assessment = getDistressAssessment(property, {
      owner_foreclosure_count: ownerForeclosureCount
    });
    const stage = classifyForeclosureStage(property);
    const timeline = getDefaultTimeline(stage, assessment.score);
    const lenderStatus = property.foreclosure && (property.trustee_entity_id || property.lender_entity_id || property.trustee_name)
      ? 'pursuing_foreclosure'
      : 'unknown';
    const outstandingDebt = toNumber(property.default_amount, toNumber(property.loan_amount));
    const estimatedEquity = computeEstimatedEquity(property);

    await query(
      `
        INSERT INTO seller_profiles (
          id,
          entity_id,
          property_id,
          status,
          active,
          source,
          motivation,
          distress_level,
          timeline,
          foreclosure_stage,
          outstanding_debt,
          estimated_equity,
          lender_status,
          distress_flags,
          scored_at
        )
        VALUES (
          $1, $2, $3, 'monitoring', TRUE, 'seller_intelligence', $4, $5, $6, $7, $8, $9, $10,
          $11::text[], NOW()
        )
        ON CONFLICT (property_id)
        DO UPDATE SET
          entity_id = COALESCE(EXCLUDED.entity_id, seller_profiles.entity_id),
          distress_level = EXCLUDED.distress_level,
          foreclosure_stage = EXCLUDED.foreclosure_stage,
          outstanding_debt = EXCLUDED.outstanding_debt,
          estimated_equity = EXCLUDED.estimated_equity,
          distress_flags = EXCLUDED.distress_flags,
          active = TRUE,
          scored_at = NOW(),
          updated_at = NOW(),
          status = CASE
            WHEN seller_profiles.status = 'unknown' THEN 'monitoring'
            ELSE seller_profiles.status
          END,
          motivation = COALESCE(seller_profiles.motivation, EXCLUDED.motivation),
          timeline = COALESCE(seller_profiles.timeline, EXCLUDED.timeline),
          lender_status = COALESCE(seller_profiles.lender_status, EXCLUDED.lender_status)
      `,
      [
        property.seller_profile_id || uuidv4(),
        ownerEntityId,
        property.id,
        property.foreclosure ? 'foreclosure' : 'unknown',
        assessment.score,
        timeline,
        stage,
        outstandingDebt,
        estimatedEquity,
        lenderStatus,
        assessment.flags
      ]
    );

    scored += 1;
    distribution[assessment.score] += 1;
  }

  return {
    scored,
    skipped,
    distribution
  };
}

module.exports = {
  calculateDistressScore,
  batchScoreProperties,
  getDistressAssessment
};
