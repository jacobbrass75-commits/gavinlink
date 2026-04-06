const { v4: uuidv4 } = require('uuid');
const { query } = require('../db/connection');
const { normalizeName, classifyEntityType } = require('../entities/extract');
const { classifyForeclosureStage } = require('./foreclosure-stage');
const { getDistressAssessment } = require('./distress-score');

const DEFAULT_SORTS = {
  distress_level:
    'COALESCE(sp.distress_level, 0) DESC, p.assessed_value DESC NULLS LAST, p.address ASC',
  assessed_value:
    'p.assessed_value DESC NULLS LAST, COALESCE(sp.distress_level, 0) DESC, p.address ASC',
  default_date:
    'p.default_date DESC NULLS LAST, COALESCE(sp.distress_level, 0) DESC, p.address ASC'
};

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function nullableNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function appendSensibility(existingValue, nextValue) {
  const cleanNext = cleanText(nextValue, null);

  if (!cleanNext) {
    return existingValue || null;
  }

  if (!existingValue) {
    return cleanNext;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  return `${existingValue}\n\n[${stamp}] ${cleanNext}`;
}

function normalizeOwnerEntityType(entityType) {
  if (entityType === 'lender' || entityType === 'trustee') {
    return 'unknown';
  }

  return entityType || 'unknown';
}

function computeEstimatedEquity(row) {
  const direct = nullableNumber(row.equity_amount);

  if (direct != null) {
    return direct;
  }

  const assessedValue = nullableNumber(row.assessed_value);
  const loanAmount = nullableNumber(row.loan_amount);

  if (assessedValue != null && loanAmount != null) {
    return assessedValue - loanAmount;
  }

  const equityPercent = nullableNumber(row.equity_percent);

  if (assessedValue != null && equityPercent != null) {
    const normalizedPercent = equityPercent <= 1 ? equityPercent * 100 : equityPercent;
    return assessedValue * (normalizedPercent / 100);
  }

  return null;
}

function deriveTimeline(stage, distressLevel) {
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

async function getOwnerForeclosureCount(entityId) {
  if (!entityId) {
    return 0;
  }

  const result = await query(
    `
      SELECT COUNT(*)::int AS count
      FROM properties
      WHERE owner_entity_id = $1
        AND foreclosure = TRUE
    `,
    [entityId]
  );

  return result.rows[0].count;
}

async function getPropertyRow(propertyId) {
  const result = await query(
    `
      SELECT *
      FROM properties
      WHERE id = $1
    `,
    [propertyId]
  );

  return result.rows[0] || null;
}

async function findOrCreateOwnerEntity(name) {
  const cleanName = cleanText(name, null);

  if (!cleanName) {
    return null;
  }

  const normalizedName = normalizeName(cleanName);
  const entityType = normalizeOwnerEntityType(classifyEntityType(cleanName, 'owner_name'));
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
    [id, cleanName, normalizedName, entityType, 'seller_intelligence', JSON.stringify({ tags: ['seller'] })]
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

  return entityResult.rows[0]?.id || id;
}

async function resolveEntityId(propertyRow, explicitEntityId = null) {
  if (explicitEntityId) {
    return explicitEntityId;
  }

  if (propertyRow?.owner_entity_id) {
    return propertyRow.owner_entity_id;
  }

  const entityId = await findOrCreateOwnerEntity(propertyRow?.owner_name);

  if (entityId && propertyRow?.id) {
    await query(
      `
        UPDATE properties
        SET owner_entity_id = $2,
            updated_at = NOW()
        WHERE id = $1
          AND owner_entity_id IS NULL
      `,
      [propertyRow.id, entityId]
    );
  }

  return entityId;
}

const SELLER_PROFILE_SELECT = `
  SELECT
    sp.*,
    e.name AS entity_name,
    e.entity_type,
    p.apn AS property_apn,
    p.address AS property_address,
    p.city AS property_city,
    p.state AS property_state,
    p.zip AS property_zip,
    p.property_type,
    p.assessed_value,
    p.default_date,
    p.default_amount,
    p.foreclosure,
    p.owner_name,
    p.trustee_name
  FROM seller_profiles sp
  JOIN properties p ON p.id = sp.property_id
  LEFT JOIN entities e ON e.id = sp.entity_id
`;

function toApiProfile(row) {
  if (!row) {
    return null;
  }

  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};

  return {
    id: row.id,
    property_id: row.property_id,
    entity_id: row.entity_id,
    entity_name: row.entity_name,
    entity_type: row.entity_type,
    property_apn: row.property_apn,
    property_address: row.property_address,
    property_city: row.property_city,
    property_state: row.property_state,
    property_zip: row.property_zip,
    property_type: row.property_type,
    assessed_value: row.assessed_value == null ? null : Number(row.assessed_value),
    default_date: row.default_date,
    default_amount: row.default_amount == null ? null : Number(row.default_amount),
    foreclosure: row.foreclosure,
    distress_level: row.distress_level,
    ai_distress_level: metadata.ai_distress_level ?? null,
    motivation: row.motivation,
    foreclosure_stage: row.foreclosure_stage,
    timeline: row.timeline,
    lender_status: row.lender_status,
    outstanding_debt: row.outstanding_debt == null ? null : Number(row.outstanding_debt),
    estimated_equity: row.estimated_equity == null ? null : Number(row.estimated_equity),
    asking_price: row.asking_price == null ? null : Number(row.asking_price),
    minimum_acceptable: row.minimum_acceptable == null ? null : Number(row.minimum_acceptable),
    legal_issues: row.legal_issues,
    sensibilities: row.sensibilities,
    notes: row.notes,
    distress_flags: row.distress_flags || [],
    approach_suggestions: row.approach_suggestions || [],
    ai_reasoning: row.ai_reasoning,
    status: row.status,
    active: row.active,
    scored_at: row.scored_at,
    inferred_at: row.inferred_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function getSellerProfileRow(id) {
  const result = await query(
    `
      ${SELLER_PROFILE_SELECT}
      WHERE sp.id = $1
    `,
    [id]
  );

  return result.rows[0] || null;
}

async function getSellerProfileRowByProperty(propertyId) {
  const result = await query(
    `
      ${SELLER_PROFILE_SELECT}
      WHERE sp.property_id = $1
    `,
    [propertyId]
  );

  return result.rows[0] || null;
}

async function createSellerProfile(data) {
  const propertyRow = await getPropertyRow(data.property_id);

  if (!propertyRow) {
    throw new Error('Property not found');
  }

  const existing = await getSellerProfileByProperty(data.property_id);

  if (existing) {
    return existing;
  }

  const entityId = await resolveEntityId(propertyRow, data.entity_id);

  if (!entityId) {
    throw new Error('Unable to resolve seller entity');
  }

  const ownerForeclosureCount = await getOwnerForeclosureCount(entityId);
  const assessment = getDistressAssessment(propertyRow, {
    owner_foreclosure_count: ownerForeclosureCount
  });
  const distressLevel = nullableNumber(data.distress_level, assessment.score);
  const stage = cleanText(data.foreclosure_stage, classifyForeclosureStage(propertyRow));
  const timeline = cleanText(data.timeline, deriveTimeline(stage, distressLevel));
  const outstandingDebt = nullableNumber(
    data.outstanding_debt,
    nullableNumber(propertyRow.default_amount, nullableNumber(propertyRow.loan_amount))
  );
  const estimatedEquity = nullableNumber(data.estimated_equity, computeEstimatedEquity(propertyRow));
  const lenderStatus = cleanText(
    data.lender_status,
    propertyRow.foreclosure && (propertyRow.trustee_entity_id || propertyRow.lender_entity_id || propertyRow.trustee_name)
      ? 'pursuing_foreclosure'
      : 'unknown'
  );

  const id = uuidv4();
  await query(
    `
      INSERT INTO seller_profiles (
        id,
        entity_id,
        property_id,
        status,
        active,
        motivation,
        distress_level,
        timeline,
        foreclosure_stage,
        outstanding_debt,
        estimated_equity,
        asking_price,
        minimum_acceptable,
        lender_status,
        legal_issues,
        sensibilities,
        notes,
        distress_flags,
        source,
        scored_at
      )
      VALUES (
        $1, $2, $3, $4, TRUE, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
        $17::text[], $18, NOW()
      )
    `,
    [
      id,
      entityId,
      propertyRow.id,
      cleanText(data.status, 'monitoring'),
      cleanText(data.motivation, propertyRow.foreclosure ? 'foreclosure' : 'unknown'),
      distressLevel,
      timeline,
      stage,
      outstandingDebt,
      estimatedEquity,
      nullableNumber(data.asking_price),
      nullableNumber(data.minimum_acceptable),
      lenderStatus,
      cleanText(data.legal_issues),
      cleanText(data.sensibilities),
      cleanText(data.notes),
      Array.isArray(data.distress_flags) ? data.distress_flags : assessment.flags,
      cleanText(data.source, 'seller_intelligence')
    ]
  );

  return getSellerProfile(id);
}

async function getSellerProfile(id) {
  return toApiProfile(await getSellerProfileRow(id));
}

async function getSellerProfileByProperty(propertyId) {
  return toApiProfile(await getSellerProfileRowByProperty(propertyId));
}

async function updateSellerProfile(id, updates) {
  const current = await getSellerProfileRow(id);

  if (!current) {
    throw new Error('Seller profile not found');
  }

  await query(
    `
      UPDATE seller_profiles
      SET
        entity_id = $2,
        status = $3,
        active = $4,
        motivation = $5,
        distress_level = $6,
        timeline = $7,
        foreclosure_stage = $8,
        outstanding_debt = $9,
        estimated_equity = $10,
        asking_price = $11,
        minimum_acceptable = $12,
        lender_status = $13,
        legal_issues = $14,
        sensibilities = $15,
        notes = $16,
        approach_suggestions = $17::text[],
        ai_reasoning = $18,
        updated_at = NOW()
      WHERE id = $1
    `,
    [
      id,
      updates.entity_id || current.entity_id,
      cleanText(updates.status, current.status),
      updates.active === undefined ? current.active : Boolean(updates.active),
      cleanText(updates.motivation, current.motivation),
      nullableNumber(
        updates.distress_level,
        current.distress_level == null ? null : Number(current.distress_level)
      ),
      cleanText(updates.timeline, current.timeline),
      cleanText(updates.foreclosure_stage, current.foreclosure_stage),
      nullableNumber(
        updates.outstanding_debt,
        current.outstanding_debt == null ? null : Number(current.outstanding_debt)
      ),
      nullableNumber(
        updates.estimated_equity,
        current.estimated_equity == null ? null : Number(current.estimated_equity)
      ),
      nullableNumber(
        updates.asking_price,
        current.asking_price == null ? null : Number(current.asking_price)
      ),
      nullableNumber(
        updates.minimum_acceptable,
        current.minimum_acceptable == null ? null : Number(current.minimum_acceptable)
      ),
      cleanText(updates.lender_status, current.lender_status),
      cleanText(updates.legal_issues, current.legal_issues),
      appendSensibility(current.sensibilities, updates.sensibilities),
      cleanText(updates.notes, current.notes),
      Array.isArray(updates.approach_suggestions)
        ? updates.approach_suggestions.map((value) => cleanText(value, null)).filter(Boolean)
        : current.approach_suggestions || [],
      cleanText(updates.ai_reasoning, current.ai_reasoning)
    ]
  );

  return getSellerProfile(id);
}

async function listSellerProfiles(filters = {}) {
  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 100);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  const minDistress = nullableNumber(filters.min_distress);
  const maxDistress = nullableNumber(filters.max_distress);
  const motivation = cleanText(filters.motivation);
  const foreclosureStage = cleanText(filters.foreclosure_stage);
  const city = cleanText(filters.city);
  const propertyType = cleanText(filters.property_type);
  const sortClause = DEFAULT_SORTS[filters.sort_by] || DEFAULT_SORTS.distress_level;

  const countResult = await query(
    `
      SELECT COUNT(*)::int AS count
      FROM seller_profiles sp
      JOIN properties p ON p.id = sp.property_id
      WHERE sp.active = TRUE
        AND ($1::int IS NULL OR sp.distress_level >= $1)
        AND ($2::int IS NULL OR sp.distress_level <= $2)
        AND ($3::text IS NULL OR sp.motivation = $3)
        AND ($4::text IS NULL OR sp.foreclosure_stage = $4)
        AND ($5::text IS NULL OR p.city = $5)
        AND ($6::text IS NULL OR p.property_type = $6)
    `,
    [minDistress, maxDistress, motivation, foreclosureStage, city, propertyType]
  );
  const rowsResult = await query(
    `
      ${SELLER_PROFILE_SELECT}
      WHERE sp.active = TRUE
        AND ($1::int IS NULL OR sp.distress_level >= $1)
        AND ($2::int IS NULL OR sp.distress_level <= $2)
        AND ($3::text IS NULL OR sp.motivation = $3)
        AND ($4::text IS NULL OR sp.foreclosure_stage = $4)
        AND ($5::text IS NULL OR p.city = $5)
        AND ($6::text IS NULL OR p.property_type = $6)
      ORDER BY ${sortClause}
      LIMIT $7
      OFFSET $8
    `,
    [minDistress, maxDistress, motivation, foreclosureStage, city, propertyType, limit, offset]
  );

  return {
    profiles: rowsResult.rows.map((row) => toApiProfile(row)),
    total: countResult.rows[0].count
  };
}

async function searchSellerProfiles(searchQuery) {
  const q = cleanText(searchQuery);

  if (!q) {
    return [];
  }

  const normalized = normalizeName(q);
  const result = await query(
    `
      ${SELLER_PROFILE_SELECT},
      GREATEST(
        similarity(COALESCE(e.normalized_name, ''), $1),
        CASE
          WHEN COALESCE(p.address, '') ILIKE $2 THEN 0.8
          WHEN COALESCE(p.apn, '') ILIKE $2 THEN 0.8
          WHEN COALESCE(p.city, '') ILIKE $2 THEN 0.6
          ELSE 0
        END
      ) AS score
      WHERE sp.active = TRUE
        AND (
          COALESCE(e.normalized_name, '') % $1
          OR COALESCE(e.normalized_name, '') LIKE $3
          OR COALESCE(p.address, '') ILIKE $2
          OR COALESCE(p.apn, '') ILIKE $2
          OR COALESCE(p.city, '') ILIKE $2
        )
      ORDER BY score DESC, COALESCE(sp.distress_level, 0) DESC, p.address ASC
      LIMIT 50
    `,
    [normalized, `%${q}%`, `%${normalized}%`]
  );

  return result.rows.map((row) => toApiProfile(row));
}

async function autoGenerateSellerProfiles() {
  const rowsResult = await query(
    `
      SELECT p.id, sp.id AS seller_profile_id
      FROM properties p
      LEFT JOIN seller_profiles sp ON sp.property_id = p.id
      WHERE p.foreclosure = TRUE
      ORDER BY p.created_at ASC, p.apn ASC
    `
  );

  let created = 0;
  let existing = 0;

  for (const row of rowsResult.rows) {
    if (row.seller_profile_id) {
      existing += 1;
      continue;
    }

    await createSellerProfile({ property_id: row.id, source: 'auto_generated' });
    created += 1;
  }

  return {
    created,
    existing
  };
}

async function getSellerDistribution() {
  const totalPropertiesResult = await query('SELECT COUNT(*)::int AS count FROM properties');
  const rowsResult = await query(
    `
      SELECT distress_level, foreclosure_stage, motivation
      FROM seller_profiles
      WHERE active = TRUE
    `
  );
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const byStage = {};
  const byMotivation = {};

  for (const row of rowsResult.rows) {
    if (row.distress_level != null) {
      distribution[row.distress_level] += 1;
    }

    if (row.foreclosure_stage) {
      byStage[row.foreclosure_stage] = (byStage[row.foreclosure_stage] || 0) + 1;
    }

    if (row.motivation) {
      byMotivation[row.motivation] = (byMotivation[row.motivation] || 0) + 1;
    }
  }

  return {
    total_properties: totalPropertiesResult.rows[0].count,
    scored: Object.values(distribution).reduce((sum, value) => sum + value, 0),
    distribution,
    by_stage: byStage,
    by_motivation: byMotivation
  };
}

module.exports = {
  createSellerProfile,
  getSellerProfile,
  getSellerProfileByProperty,
  updateSellerProfile,
  listSellerProfiles,
  searchSellerProfiles,
  autoGenerateSellerProfiles,
  getSellerDistribution
};
