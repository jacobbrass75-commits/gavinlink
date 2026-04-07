const { v4: uuidv4 } = require('uuid');
const { query } = require('../db/connection');
const { normalizeName, classifyEntityType } = require('../entities/extract');
const { getPortfolio } = require('../entities/cluster');
const { buildContainsPattern } = require('../utils/sql');

const SEARCHABLE_ENTITY_TYPES = ['person', 'llc', 'corporation', 'trust', 'partnership', 'unknown'];

function uniqueStrings(values = [], existingValues = []) {
  const seen = new Set();
  const output = [];

  for (const value of [...existingValues, ...values]) {
    if (typeof value !== 'string') {
      continue;
    }

    const trimmed = value.trim();

    if (trimmed === '') {
      continue;
    }

    const key = trimmed.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(trimmed);
  }

  return output;
}

function nullableNumber(value, fallback = null) {
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

function inferBuyerEntityType(name) {
  const inferred = classifyEntityType(name);

  if (inferred === 'lender' || inferred === 'trustee' || inferred === 'unknown') {
    return 'person';
  }

  return inferred;
}

async function findMatchingEntity(entityName) {
  const normalized = normalizeName(entityName);

  if (!normalized) {
    return null;
  }

  const result = await query(
    `
      SELECT
        id,
        name,
        entity_type,
        similarity(normalized_name, $1) AS score
      FROM entities
      WHERE entity_type = ANY($2::text[])
        AND (
          normalized_name % $1
          OR normalized_name LIKE $3 ESCAPE '\\'
        )
      ORDER BY score DESC, name ASC
      LIMIT 1
    `,
    [normalized, SEARCHABLE_ENTITY_TYPES, buildContainsPattern(normalized)]
  );
  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return Number(row.score) >= 0.7 ? row : null;
}

async function findOrCreateEntity(entityName) {
  const cleanName = cleanText(entityName, null);

  if (!cleanName) {
    throw new Error('entity_name is required');
  }

  const existing = await findMatchingEntity(cleanName);

  if (existing) {
    await query(
      `
        UPDATE entities
        SET metadata = metadata || $2::jsonb,
            updated_at = NOW()
        WHERE id = $1
      `,
      [existing.id, JSON.stringify({ tags: ['buyer'] })]
    );

    return existing;
  }

  const id = uuidv4();
  const entityType = inferBuyerEntityType(cleanName);
  const result = await query(
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
      RETURNING id, name, entity_type
    `,
    [
      id,
      cleanName,
      normalizeName(cleanName),
      entityType,
      'buyers',
      JSON.stringify({ tags: ['buyer'] })
    ]
  );

  return result.rows[0];
}

function toApiProfile(row, portfolio = null) {
  if (!row) {
    return null;
  }

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
    active: row.active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    portfolio
  };
}

async function getBuyerProfileRow(id) {
  const result = await query(
    `
      SELECT
        bp.*,
        e.name AS entity_name,
        e.entity_type
      FROM buyer_profiles bp
      JOIN entities e ON e.id = bp.entity_id
      WHERE bp.id = $1
    `,
    [id]
  );

  return result.rows[0] || null;
}

async function createBuyerProfile(data) {
  const entity = await findOrCreateEntity(data.entity_name);
  const existingProfile = await getBuyerProfileByEntity(entity.id);

  if (existingProfile) {
    return existingProfile;
  }

  const id = uuidv4();

  await query(
    `
      INSERT INTO buyer_profiles (
        id,
        entity_id,
        status,
        active,
        preferred_property_types,
        target_markets,
        target_cities,
        target_zip_codes,
        min_price,
        max_price,
        min_sq_feet,
        max_sq_feet,
        min_lot_size,
        max_lot_size,
        min_units,
        max_units,
        min_cap_rate,
        investment_strategy,
        financing_preference,
        typical_close_timeline,
        urgency,
        requires_foreclosure,
        sensibilities,
        notes
      )
      VALUES (
        $1, $2, 'active', TRUE, $3::text[], $4::text[], $5::text[], $6::text[],
        $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
      )
    `,
    [
      id,
      entity.id,
      uniqueStrings(data.target_property_types),
      uniqueStrings(data.target_markets),
      uniqueStrings(data.target_cities),
      uniqueStrings(data.target_zip_codes),
      nullableNumber(data.min_price),
      nullableNumber(data.max_price),
      nullableNumber(data.min_sq_feet),
      nullableNumber(data.max_sq_feet),
      nullableNumber(data.min_lot_size),
      nullableNumber(data.max_lot_size),
      nullableNumber(data.min_units),
      nullableNumber(data.max_units),
      nullableNumber(data.min_cap_rate),
      cleanText(data.investment_strategy),
      cleanText(data.financing_preference),
      cleanText(data.typical_close_timeline),
      cleanText(data.urgency),
      Boolean(data.requires_foreclosure),
      cleanText(data.sensibilities),
      cleanText(data.notes)
    ]
  );

  return getBuyerProfile(id);
}

async function getBuyerProfile(id) {
  const row = await getBuyerProfileRow(id);

  if (!row) {
    return null;
  }

  const portfolio = await getPortfolio(row.entity_id);
  return toApiProfile(row, portfolio);
}

async function getBuyerProfileByEntity(entityId) {
  const result = await query(
    `
      SELECT
        bp.*,
        e.name AS entity_name,
        e.entity_type
      FROM buyer_profiles bp
      JOIN entities e ON e.id = bp.entity_id
      WHERE bp.entity_id = $1
    `,
    [entityId]
  );
  const row = result.rows[0];

  if (!row) {
    return null;
  }

  const portfolio = await getPortfolio(row.entity_id);
  return toApiProfile(row, portfolio);
}

async function updateBuyerProfile(id, updates) {
  const current = await getBuyerProfileRow(id);

  if (!current) {
    throw new Error('Buyer profile not found');
  }

  const entityId = updates.entity_name
    ? (await findOrCreateEntity(updates.entity_name)).id
    : current.entity_id;

  await query(
    `
      UPDATE buyer_profiles
      SET
        entity_id = $2,
        preferred_property_types = $3::text[],
        target_markets = $4::text[],
        target_cities = $5::text[],
        target_zip_codes = $6::text[],
        min_price = $7,
        max_price = $8,
        min_sq_feet = $9,
        max_sq_feet = $10,
        min_lot_size = $11,
        max_lot_size = $12,
        min_units = $13,
        max_units = $14,
        min_cap_rate = $15,
        investment_strategy = $16,
        financing_preference = $17,
        typical_close_timeline = $18,
        urgency = $19,
        requires_foreclosure = $20,
        sensibilities = $21,
        notes = $22,
        active = $23,
        status = $24,
        updated_at = NOW()
      WHERE id = $1
    `,
    [
      id,
      entityId,
      uniqueStrings(updates.target_property_types, current.preferred_property_types),
      uniqueStrings(updates.target_markets, current.target_markets),
      uniqueStrings(updates.target_cities, current.target_cities),
      uniqueStrings(updates.target_zip_codes, current.target_zip_codes),
      nullableNumber(updates.min_price, current.min_price == null ? null : Number(current.min_price)),
      nullableNumber(updates.max_price, current.max_price == null ? null : Number(current.max_price)),
      nullableNumber(updates.min_sq_feet, current.min_sq_feet == null ? null : Number(current.min_sq_feet)),
      nullableNumber(updates.max_sq_feet, current.max_sq_feet == null ? null : Number(current.max_sq_feet)),
      nullableNumber(updates.min_lot_size, current.min_lot_size == null ? null : Number(current.min_lot_size)),
      nullableNumber(updates.max_lot_size, current.max_lot_size == null ? null : Number(current.max_lot_size)),
      nullableNumber(updates.min_units, current.min_units),
      nullableNumber(updates.max_units, current.max_units),
      nullableNumber(updates.min_cap_rate, current.min_cap_rate == null ? null : Number(current.min_cap_rate)),
      cleanText(updates.investment_strategy, current.investment_strategy),
      cleanText(updates.financing_preference, current.financing_preference),
      cleanText(updates.typical_close_timeline, current.typical_close_timeline),
      cleanText(updates.urgency, current.urgency),
      updates.requires_foreclosure === undefined ? current.requires_foreclosure : Boolean(updates.requires_foreclosure),
      appendSensibility(current.sensibilities, updates.sensibilities),
      cleanText(updates.notes, current.notes),
      updates.active === undefined ? current.active : Boolean(updates.active),
      cleanText(
        updates.status,
        updates.active === false ? 'archived' : current.status
      )
    ]
  );

  return getBuyerProfile(id);
}

async function listBuyerProfiles(filters = {}) {
  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 100);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  const propertyType = cleanText(filters.property_type);
  const city = cleanText(filters.city);
  const strategy = cleanText(filters.strategy);
  const urgency = cleanText(filters.urgency);
  const countResult = await query(
    `
      SELECT COUNT(*)::int AS count
      FROM buyer_profiles bp
      WHERE bp.active = TRUE
        AND ($1::text IS NULL OR $1 = ANY(bp.preferred_property_types))
        AND ($2::text IS NULL OR $2 = ANY(bp.target_cities))
        AND ($3::text IS NULL OR bp.investment_strategy = $3)
        AND ($4::text IS NULL OR bp.urgency = $4)
    `,
    [propertyType, city, strategy, urgency]
  );
  const rowsResult = await query(
    `
      SELECT
        bp.*,
        e.name AS entity_name,
        e.entity_type
      FROM buyer_profiles bp
      JOIN entities e ON e.id = bp.entity_id
      WHERE bp.active = TRUE
        AND ($1::text IS NULL OR $1 = ANY(bp.preferred_property_types))
        AND ($2::text IS NULL OR $2 = ANY(bp.target_cities))
        AND ($3::text IS NULL OR bp.investment_strategy = $3)
        AND ($4::text IS NULL OR bp.urgency = $4)
      ORDER BY bp.updated_at DESC, e.name ASC
      LIMIT $5
      OFFSET $6
    `,
    [propertyType, city, strategy, urgency, limit, offset]
  );

  return {
    profiles: rowsResult.rows.map((row) => toApiProfile(row)),
    total: countResult.rows[0].count
  };
}

async function searchBuyerProfiles(searchQuery) {
  const q = cleanText(searchQuery);

  if (!q) {
    return [];
  }

  const normalized = normalizeName(q);
  const searchPattern = buildContainsPattern(q);
  const result = await query(
    `
      SELECT
        bp.*,
        e.name AS entity_name,
        e.entity_type,
        GREATEST(
          similarity(e.normalized_name, $1),
          CASE
            WHEN array_to_string(bp.preferred_property_types, ' ') ILIKE $2 ESCAPE '\\' THEN 0.8
            WHEN array_to_string(bp.target_cities, ' ') ILIKE $2 ESCAPE '\\' THEN 0.8
            WHEN COALESCE(bp.investment_strategy, '') ILIKE $2 ESCAPE '\\' THEN 0.8
            WHEN COALESCE(bp.sensibilities, '') ILIKE $2 ESCAPE '\\' THEN 0.7
            WHEN COALESCE(bp.notes, '') ILIKE $2 ESCAPE '\\' THEN 0.7
            ELSE 0
          END
        ) AS score
      FROM buyer_profiles bp
      JOIN entities e ON e.id = bp.entity_id
      WHERE bp.active = TRUE
        AND (
          e.normalized_name % $1
          OR e.normalized_name LIKE $2 ESCAPE '\\'
          OR array_to_string(bp.preferred_property_types, ' ') ILIKE $2 ESCAPE '\\'
          OR array_to_string(bp.target_cities, ' ') ILIKE $2 ESCAPE '\\'
          OR array_to_string(bp.target_zip_codes, ' ') ILIKE $2 ESCAPE '\\'
          OR COALESCE(bp.investment_strategy, '') ILIKE $2 ESCAPE '\\'
          OR COALESCE(bp.financing_preference, '') ILIKE $2 ESCAPE '\\'
          OR COALESCE(bp.typical_close_timeline, '') ILIKE $2 ESCAPE '\\'
          OR COALESCE(bp.urgency, '') ILIKE $2 ESCAPE '\\'
          OR COALESCE(bp.sensibilities, '') ILIKE $2 ESCAPE '\\'
          OR COALESCE(bp.notes, '') ILIKE $2 ESCAPE '\\'
        )
      ORDER BY score DESC, e.name ASC
      LIMIT 50
    `,
    [normalized, searchPattern]
  );

  return result.rows.map((row) => toApiProfile(row));
}

async function deactivateBuyerProfile(id) {
  const current = await getBuyerProfileRow(id);

  if (!current) {
    throw new Error('Buyer profile not found');
  }

  await query(
    `
      UPDATE buyer_profiles
      SET active = FALSE,
          status = 'archived',
          updated_at = NOW()
      WHERE id = $1
    `,
    [id]
  );

  return getBuyerProfile(id);
}

module.exports = {
  createBuyerProfile,
  getBuyerProfile,
  getBuyerProfileByEntity,
  updateBuyerProfile,
  listBuyerProfiles,
  searchBuyerProfiles,
  deactivateBuyerProfile
};
