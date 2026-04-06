const { v4: uuidv4 } = require('uuid');
const { query } = require('../db/connection');
const { calculateMatchScore } = require('./scorer');
const { explainMatch } = require('./explainer');
const { generateMatchNarrative, batchGenerateNarratives } = require('./narrative');
const { normalizeName } = require('../entities/extract');

const MATCH_STATUS_VALUES = new Set([
  'suggested',
  'reviewed',
  'contacted',
  'in_negotiation',
  'passed',
  'closed',
  'archived',
  'candidate',
  'accepted',
  'rejected'
]);

function toNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function cleanStringArray(values = []) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values.filter((value) => typeof value === 'string' && value.trim() !== '');
}

function normalizeBuyer(row) {
  return {
    id: row.id,
    entity_id: row.entity_id,
    entity_name: row.entity_name,
    entity_type: row.entity_type,
    target_property_types: row.preferred_property_types || [],
    target_markets: row.target_markets || [],
    target_cities: row.target_cities || [],
    target_zip_codes: row.target_zip_codes || [],
    min_price: row.min_price == null ? null : Number(row.min_price),
    max_price: row.max_price == null ? null : Number(row.max_price),
    min_sq_feet: row.min_sq_feet == null ? null : Number(row.min_sq_feet),
    max_sq_feet: row.max_sq_feet == null ? null : Number(row.max_sq_feet),
    min_lot_size: row.min_lot_size == null ? null : Number(row.min_lot_size),
    max_lot_size: row.max_lot_size == null ? null : Number(row.max_lot_size),
    min_units: row.min_units,
    max_units: row.max_units,
    min_cap_rate: row.min_cap_rate == null ? null : Number(row.min_cap_rate),
    investment_strategy: row.investment_strategy,
    financing_preference: row.financing_preference,
    typical_close_timeline: row.typical_close_timeline,
    urgency: row.urgency,
    requires_foreclosure: row.requires_foreclosure,
    sensibilities: row.sensibilities,
    notes: row.notes,
    status: row.status,
    active: row.active
  };
}

function normalizeSellerAndProperty(row) {
  return {
    seller: {
      id: row.seller_profile_id,
      entity_id: row.seller_entity_id,
      entity_name: row.seller_entity_name,
      entity_type: row.seller_entity_type,
      distress_level: row.distress_level,
      motivation: row.motivation,
      timeline: row.timeline,
      foreclosure_stage: row.foreclosure_stage,
      lender_status: row.lender_status,
      sensibilities: row.sensibilities,
      status: row.seller_status,
      active: row.seller_active
    },
    property: {
      id: row.property_id,
      apn: row.apn,
      address: row.address,
      city: row.city,
      state: row.state,
      zip: row.zip,
      property_type: row.property_type,
      sq_feet: row.sq_feet == null ? null : Number(row.sq_feet),
      lot_size: row.lot_size == null ? null : Number(row.lot_size),
      assessed_value: row.assessed_value == null ? null : Number(row.assessed_value),
      units: row.units,
      foreclosure: row.foreclosure,
      owner_name: row.owner_name,
      trustee_name: row.trustee_name,
      owner_entity_id: row.owner_entity_id,
      trustee_entity_id: row.trustee_entity_id,
      lender_entity_id: row.lender_entity_id,
      default_date: row.default_date,
      default_amount: row.default_amount == null ? null : Number(row.default_amount),
      loan_amount: row.loan_amount == null ? null : Number(row.loan_amount),
      ltv: row.ltv == null ? null : Number(row.ltv),
      equity_amount: row.equity_amount == null ? null : Number(row.equity_amount),
      equity_percent: row.equity_percent == null ? null : Number(row.equity_percent),
      asking_price: row.asking_price == null ? null : Number(row.asking_price),
      minimum_acceptable: row.minimum_acceptable == null ? null : Number(row.minimum_acceptable)
    }
  };
}

async function getActiveBuyers(filter = {}) {
  const result = await query(
    `
      SELECT
        bp.*,
        e.name AS entity_name,
        e.entity_type
      FROM buyer_profiles bp
      JOIN entities e ON e.id = bp.entity_id
      WHERE bp.active = TRUE
        AND ($1::uuid IS NULL OR bp.id = $1)
        AND ($2::uuid IS NULL OR bp.entity_id = $2)
      ORDER BY bp.updated_at DESC, e.name ASC
    `,
    [filter.buyer_profile_id || null, filter.entity_id || null]
  );

  return result.rows.map(normalizeBuyer);
}

async function getActiveSellers(filter = {}) {
  const result = await query(
    `
      SELECT
        sp.id AS seller_profile_id,
        sp.entity_id AS seller_entity_id,
        seller_entity.name AS seller_entity_name,
        seller_entity.entity_type AS seller_entity_type,
        sp.distress_level,
        sp.motivation,
        sp.timeline,
        sp.foreclosure_stage,
        sp.lender_status,
        sp.sensibilities,
        sp.status AS seller_status,
        sp.active AS seller_active,
        sp.asking_price,
        sp.minimum_acceptable,
        p.id AS property_id,
        p.apn,
        p.address,
        p.city,
        p.state,
        p.zip,
        p.property_type,
        p.sq_feet,
        p.lot_size,
        p.assessed_value,
        p.units,
        p.foreclosure,
        p.owner_name,
        p.trustee_name,
        p.owner_entity_id,
        p.trustee_entity_id,
        p.lender_entity_id,
        p.default_date,
        p.default_amount,
        p.loan_amount,
        p.ltv,
        p.equity_amount,
        p.equity_percent
      FROM seller_profiles sp
      JOIN properties p ON p.id = sp.property_id
      LEFT JOIN entities seller_entity ON seller_entity.id = sp.entity_id
      WHERE sp.active = TRUE
        AND ($1::uuid IS NULL OR sp.property_id = $1)
      ORDER BY sp.updated_at DESC, p.address ASC NULLS LAST, p.apn ASC
    `,
    [filter.property_id || null]
  );

  return result.rows.map(normalizeSellerAndProperty);
}

function buildDistribution(matches) {
  const distribution = {
    '0-24': 0,
    '25-49': 0,
    '50-74': 0,
    '75-100': 0
  };

  for (const match of matches) {
    const score = Number(match.score || 0);

    if (score < 25) {
      distribution['0-24'] += 1;
    } else if (score < 50) {
      distribution['25-49'] += 1;
    } else if (score < 75) {
      distribution['50-74'] += 1;
    } else {
      distribution['75-100'] += 1;
    }
  }

  return distribution;
}

async function persistMatch(matchData) {
  const breakdownJson = JSON.stringify(matchData.breakdown);
  const reasoning = cleanStringArray(matchData.reasons).join(' | ');
  const result = await query(
    `
      INSERT INTO matches (
        id,
        buyer_profile_id,
        seller_profile_id,
        property_id,
        score,
        status,
        reasoning,
        factor_scores,
        score_breakdown,
        generated_by,
        last_scored_at
      )
      VALUES (
        $1, $2, $3, $4, $5, 'suggested', $6, $7::jsonb, $8::jsonb, 'matching_engine', NOW()
      )
      ON CONFLICT (buyer_profile_id, property_id)
      DO UPDATE SET
        seller_profile_id = EXCLUDED.seller_profile_id,
        score = EXCLUDED.score,
        reasoning = EXCLUDED.reasoning,
        factor_scores = EXCLUDED.factor_scores,
        score_breakdown = EXCLUDED.score_breakdown,
        generated_by = EXCLUDED.generated_by,
        last_scored_at = NOW(),
        updated_at = NOW()
      RETURNING id, narrative, status, narrative_generated_at, created_at, updated_at, (xmax = 0) AS inserted
    `,
    [
      matchData.id || uuidv4(),
      matchData.buyer_profile_id,
      matchData.seller_profile_id,
      matchData.property_id,
      matchData.score,
      reasoning,
      breakdownJson,
      breakdownJson
    ]
  );

  return result.rows[0];
}

function createTopMatchSummary(match) {
  return {
    id: match.id || null,
    buyer_profile_id: match.buyer?.id || null,
    buyer_name: match.buyer?.entity_name || null,
    seller_profile_id: match.seller?.id || null,
    seller_name: match.seller?.entity_name || null,
    property_id: match.property?.id || null,
    property_address: match.property?.address || match.property?.apn || null,
    score: match.score
  };
}

async function scorePair(buyer, seller, property, options = {}) {
  const scoreResult = await calculateMatchScore(buyer, seller, property, {
    skipKnowledge: Boolean(options.skipKnowledge)
  });
  const reasons = explainMatch({
    buyer,
    seller,
    property,
    breakdown: scoreResult.breakdown
  });

  return {
    id: null,
    buyer_profile_id: buyer.id,
    seller_profile_id: seller.id,
    property_id: property.id,
    buyer,
    seller,
    property,
    score: scoreResult.score,
    breakdown: scoreResult.breakdown,
    reasons,
    status: 'suggested',
    narrative: null
  };
}

async function maybeGenerateNarrative(match, options = {}) {
  if (!options.generateNarratives || Number(match.score || 0) < 75 || !match.id) {
    return match;
  }

  const narrative = await generateMatchNarrative(match, match.buyer, match.seller, match.property);

  await query(
    `
      UPDATE matches
      SET narrative = $2::jsonb,
          narrative_generated_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `,
    [match.id, JSON.stringify(narrative)]
  );

  return {
    ...match,
    narrative
  };
}

async function evaluateMatches(buyers, sellers, options = {}) {
  const minScore = Math.max(Number(options.minScore) || 50, 0);
  const dryRun = Boolean(options.dryRun);
  const skipKnowledge = options.skipKnowledge === undefined ? dryRun : Boolean(options.skipKnowledge);
  let matchesCreated = 0;
  let matchesUpdated = 0;
  const savedMatches = [];

  for (const buyer of buyers) {
    for (const candidate of sellers) {
      const property = candidate.property;
      const seller = candidate.seller;

      if (buyer.requires_foreclosure && property.foreclosure !== true) {
        continue;
      }

      const scored = await scorePair(buyer, seller, property, { skipKnowledge });

      if (scored.score < minScore) {
        continue;
      }

      if (dryRun) {
        savedMatches.push(scored);
        continue;
      }

      const persisted = await persistMatch(scored);
      const withId = {
        ...scored,
        id: persisted.id,
        status: persisted.status,
        narrative: persisted.narrative || null,
        created_at: persisted.created_at,
        updated_at: persisted.updated_at
      };

      if (persisted.inserted) {
        matchesCreated += 1;
      } else {
        matchesUpdated += 1;
      }

      savedMatches.push(await maybeGenerateNarrative(withId, options));
    }
  }

  savedMatches.sort((left, right) => right.score - left.score);

  return {
    matches: savedMatches,
    matchesCreated,
    matchesUpdated
  };
}

function hydrateMatchRow(row) {
  if (!row) {
    return null;
  }

  const breakdown = row.score_breakdown || row.factor_scores || {};
  const buyer = {
    id: row.buyer_profile_id,
    entity_id: row.buyer_entity_id,
    entity_name: row.buyer_entity_name,
    entity_type: row.buyer_entity_type,
    target_property_types: row.preferred_property_types || [],
    target_cities: row.target_cities || [],
    target_zip_codes: row.target_zip_codes || [],
    min_price: row.buyer_min_price == null ? null : Number(row.buyer_min_price),
    max_price: row.buyer_max_price == null ? null : Number(row.buyer_max_price),
    min_sq_feet: row.buyer_min_sq_feet == null ? null : Number(row.buyer_min_sq_feet),
    max_sq_feet: row.buyer_max_sq_feet == null ? null : Number(row.buyer_max_sq_feet),
    investment_strategy: row.investment_strategy,
    urgency: row.urgency,
    sensibilities: row.buyer_sensibilities
  };
  const seller = {
    id: row.seller_profile_id,
    entity_id: row.seller_entity_id,
    entity_name: row.seller_entity_name,
    entity_type: row.seller_entity_type,
    distress_level: row.distress_level,
    motivation: row.motivation,
    timeline: row.timeline,
    foreclosure_stage: row.foreclosure_stage,
    lender_status: row.lender_status,
    sensibilities: row.seller_sensibilities
  };
  const property = {
    id: row.property_id,
    apn: row.apn,
    address: row.address,
    city: row.city,
    state: row.state,
    zip: row.zip,
    property_type: row.property_type,
    sq_feet: row.sq_feet == null ? null : Number(row.sq_feet),
    lot_size: row.lot_size == null ? null : Number(row.lot_size),
    assessed_value: row.assessed_value == null ? null : Number(row.assessed_value),
    foreclosure: row.foreclosure,
    asking_price: row.asking_price == null ? null : Number(row.asking_price),
    minimum_acceptable: row.minimum_acceptable == null ? null : Number(row.minimum_acceptable)
  };

  return {
    id: row.id,
    buyer,
    seller,
    property,
    score: Number(row.score),
    breakdown,
    reasons: explainMatch({ buyer, seller, property, breakdown }),
    narrative: row.narrative || null,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    narrative_generated_at: row.narrative_generated_at,
    last_scored_at: row.last_scored_at
  };
}

const MATCH_ROW_SELECT = `
  SELECT
    m.*,
    bp.id AS buyer_profile_id,
    bp.entity_id AS buyer_entity_id,
    bp.preferred_property_types,
    bp.target_cities,
    bp.target_zip_codes,
    bp.min_price AS buyer_min_price,
    bp.max_price AS buyer_max_price,
    bp.min_sq_feet AS buyer_min_sq_feet,
    bp.max_sq_feet AS buyer_max_sq_feet,
    bp.investment_strategy,
    bp.urgency,
    bp.sensibilities AS buyer_sensibilities,
    buyer_entity.name AS buyer_entity_name,
    buyer_entity.entity_type AS buyer_entity_type,
    sp.id AS seller_profile_id,
    sp.entity_id AS seller_entity_id,
    sp.distress_level,
    sp.motivation,
    sp.timeline,
    sp.foreclosure_stage,
    sp.lender_status,
    sp.sensibilities AS seller_sensibilities,
    seller_entity.name AS seller_entity_name,
    seller_entity.entity_type AS seller_entity_type,
    p.id AS property_id,
    p.apn,
    p.address,
    p.city,
    p.state,
    p.zip,
    p.property_type,
    p.sq_feet,
    p.lot_size,
    p.assessed_value,
    p.foreclosure,
    sp.asking_price,
    sp.minimum_acceptable
  FROM matches m
  JOIN buyer_profiles bp ON bp.id = m.buyer_profile_id
  JOIN entities buyer_entity ON buyer_entity.id = bp.entity_id
  JOIN seller_profiles sp ON sp.id = m.seller_profile_id
  LEFT JOIN entities seller_entity ON seller_entity.id = sp.entity_id
  JOIN properties p ON p.id = m.property_id
`;

async function listMatches(filters = {}) {
  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 100);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  const sortBy = cleanText(filters.sort_by, 'score');
  const sortClause =
    sortBy === 'updated_at'
      ? 'm.updated_at DESC, m.score DESC'
      : sortBy === 'created_at'
        ? 'm.created_at DESC, m.score DESC'
        : 'm.score DESC, m.updated_at DESC';
  const countResult = await query(
    `
      SELECT COUNT(*)::int AS count
      FROM matches m
      WHERE ($1::uuid IS NULL OR m.buyer_profile_id = $1)
        AND ($2::uuid IS NULL OR m.property_id = $2)
        AND ($3::text IS NULL OR m.status = $3)
        AND ($4::numeric IS NULL OR m.score >= $4)
    `,
    [filters.buyer_profile_id || null, filters.property_id || null, filters.status || null, toNumber(filters.min_score)]
  );
  const rowsResult = await query(
    `
      ${MATCH_ROW_SELECT}
      WHERE ($1::uuid IS NULL OR m.buyer_profile_id = $1)
        AND ($2::uuid IS NULL OR m.property_id = $2)
        AND ($3::text IS NULL OR m.status = $3)
        AND ($4::numeric IS NULL OR m.score >= $4)
      ORDER BY ${sortClause}
      LIMIT $5
      OFFSET $6
    `,
    [filters.buyer_profile_id || null, filters.property_id || null, filters.status || null, toNumber(filters.min_score), limit, offset]
  );

  return {
    results: rowsResult.rows.map(hydrateMatchRow),
    total: countResult.rows[0].count
  };
}

async function getMatch(id) {
  const result = await query(
    `
      ${MATCH_ROW_SELECT}
      WHERE m.id = $1
      LIMIT 1
    `,
    [id]
  );

  return hydrateMatchRow(result.rows[0] || null);
}

async function updateMatchStatus(id, status) {
  const normalizedStatus = cleanText(status, null);

  if (!normalizedStatus || !MATCH_STATUS_VALUES.has(normalizedStatus)) {
    throw new Error('Invalid match status');
  }

  await query(
    `
      UPDATE matches
      SET status = $2,
          updated_at = NOW()
      WHERE id = $1
    `,
    [id, normalizedStatus]
  );

  return getMatch(id);
}

async function generateNarrativeForMatch(id) {
  const match = await getMatch(id);

  if (!match) {
    throw new Error('Match not found');
  }

  if (match.score < 75) {
    throw new Error('Narratives are only generated for matches scoring 75 or higher');
  }

  const narrative = await generateMatchNarrative(match, match.buyer, match.seller, match.property);

  await query(
    `
      UPDATE matches
      SET narrative = $2::jsonb,
          narrative_generated_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `,
    [id, JSON.stringify(narrative)]
  );

  return getMatch(id);
}

async function runFullMatching(options = {}) {
  const buyers = await getActiveBuyers();
  const sellers = await getActiveSellers();
  const evaluated = await evaluateMatches(buyers, sellers, options);

  if (!options.dryRun && options.generateNarratives) {
    await batchGenerateNarratives({
      minScore: Math.max(Number(options.narrativeMinScore) || 75, 0),
      limit: Math.min(Math.max(Number(options.narrativeLimit) || 10, 1), 100)
    });
  }

  return {
    buyers_processed: buyers.length,
    matches_created: evaluated.matchesCreated,
    matches_updated: evaluated.matchesUpdated,
    high_score_matches: evaluated.matches.filter((match) => match.score >= 75).length,
    distribution: buildDistribution(evaluated.matches),
    top_matches: evaluated.matches.slice(0, 10).map(createTopMatchSummary)
  };
}

async function runMatchingForBuyer(buyerEntityId, options = {}) {
  const buyers = await getActiveBuyers({ entity_id: buyerEntityId });

  if (buyers.length === 0) {
    return [];
  }

  const sellers = await getActiveSellers();
  const evaluated = await evaluateMatches([buyers[0]], sellers, options);
  return evaluated.matches.sort((left, right) => right.score - left.score);
}

async function runMatchingForProperty(propertyId, options = {}) {
  const buyers = await getActiveBuyers();
  const sellers = await getActiveSellers({ property_id: propertyId });

  if (sellers.length === 0) {
    return [];
  }

  const evaluated = await evaluateMatches(buyers, sellers, options);
  return evaluated.matches.sort((left, right) => right.score - left.score);
}

async function getTopMatches(options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 100);
  const status = cleanText(options.status, 'suggested');
  const rowsResult = await query(
    `
      ${MATCH_ROW_SELECT}
      WHERE ($1::text IS NULL OR m.status = $1)
      ORDER BY m.score DESC, m.updated_at DESC
      LIMIT $2
    `,
    [status, limit]
  );

  return rowsResult.rows.map(hydrateMatchRow);
}

async function getMatchDistribution() {
  const result = await query(
    `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE score < 25)::int AS bucket_0_24,
        COUNT(*) FILTER (WHERE score >= 25 AND score < 50)::int AS bucket_25_49,
        COUNT(*) FILTER (WHERE score >= 50 AND score < 75)::int AS bucket_50_74,
        COUNT(*) FILTER (WHERE score >= 75)::int AS bucket_75_100
      FROM matches
    `
  );
  const statusResult = await query(
    `
      SELECT status, COUNT(*)::int AS count
      FROM matches
      GROUP BY status
      ORDER BY status ASC
    `
  );
  const row = result.rows[0];

  return {
    total_matches: row.total,
    distribution: {
      '0-24': row.bucket_0_24,
      '25-49': row.bucket_25_49,
      '50-74': row.bucket_50_74,
      '75-100': row.bucket_75_100
    },
    by_status: Object.fromEntries(statusResult.rows.map((statusRow) => [statusRow.status, statusRow.count]))
  };
}

async function lookupIdentifier(identifier) {
  const normalized = normalizeName(identifier);
  const buyerResult = await query(
    `
      SELECT bp.entity_id
      FROM buyer_profiles bp
      JOIN entities e ON e.id = bp.entity_id
      WHERE bp.active = TRUE
        AND (
          e.normalized_name = $1
          OR e.normalized_name % $1
          OR e.name ILIKE $2
          OR bp.id = $3::uuid
        )
      ORDER BY similarity(e.normalized_name, $1) DESC, e.name ASC
      LIMIT 1
    `,
    [normalized, `%${identifier}%`, /^[0-9a-f-]{36}$/i.test(String(identifier || '')) ? identifier : null]
  );

  if (buyerResult.rows[0]) {
    return {
      kind: 'buyer',
      entity_id: buyerResult.rows[0].entity_id
    };
  }

  const propertyResult = await query(
    `
      SELECT id
      FROM properties
      WHERE apn = $1
         OR id = $2::uuid
         OR COALESCE(address, '') ILIKE $3
         OR similarity(COALESCE(address, ''), $1) >= 0.35
      ORDER BY
        CASE WHEN apn = $1 THEN 1 ELSE 2 END,
        similarity(COALESCE(address, ''), $1) DESC,
        address ASC
      LIMIT 1
    `,
    [identifier, /^[0-9a-f-]{36}$/i.test(String(identifier || '')) ? identifier : null, `%${identifier}%`]
  );

  if (propertyResult.rows[0]) {
    return {
      kind: 'property',
      property_id: propertyResult.rows[0].id
    };
  }

  return null;
}

module.exports = {
  runFullMatching,
  runMatchingForBuyer,
  runMatchingForProperty,
  getTopMatches,
  listMatches,
  getMatch,
  updateMatchStatus,
  generateNarrativeForMatch,
  getMatchDistribution,
  lookupIdentifier
};
