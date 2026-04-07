const { v4: uuidv4 } = require('uuid');
const { query } = require('../db/connection');
const { normalizeName, classifyEntityType } = require('../entities/extract');

const ALLOWED_ENTITY_TYPES = new Set([
  'person',
  'llc',
  'trust',
  'corporation',
  'lender',
  'trustee',
  'broker',
  'partnership',
  'unknown'
]);

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function normalizeEntityType(entityType, name = '') {
  const normalizedType = cleanText(entityType, '').toLowerCase();

  if (normalizedType === 'company') {
    const inferred = classifyEntityType(name, 'owner_name');

    if (inferred === 'person') {
      return 'unknown';
    }

    return ALLOWED_ENTITY_TYPES.has(inferred) ? inferred : 'unknown';
  }

  if (ALLOWED_ENTITY_TYPES.has(normalizedType)) {
    return normalizedType;
  }

  const inferred = classifyEntityType(name, 'owner_name');
  return ALLOWED_ENTITY_TYPES.has(inferred) ? inferred : 'unknown';
}

function toEntity(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    normalized_name: row.normalized_name,
    entity_type: row.entity_type,
    phone: row.phone,
    email: row.email,
    metadata: row.metadata || {}
  };
}

async function findEntityExact(name, type = null) {
  const normalizedName = normalizeName(name);

  if (!normalizedName) {
    return null;
  }

  const entityType = type ? normalizeEntityType(type, name) : null;
  const result = await query(
    `
      SELECT id, name, normalized_name, entity_type, phone, email, metadata
      FROM entities
      WHERE normalized_name = $1
        AND ($2::text IS NULL OR entity_type = $2)
      ORDER BY created_at ASC
      LIMIT 1
    `,
    [normalizedName, entityType]
  );

  return toEntity(result.rows[0] || null);
}

async function findEntitiesFuzzy(name, threshold = 0.4, type = null) {
  const normalizedName = normalizeName(name);

  if (!normalizedName) {
    return [];
  }

  const entityType = type ? normalizeEntityType(type, name) : null;
  const result = await query(
    `
      SELECT
        id,
        name,
        normalized_name,
        entity_type,
        phone,
        email,
        metadata,
        similarity(normalized_name, $1) AS score
      FROM entities
      WHERE similarity(normalized_name, $1) >= $2
        AND ($3::text IS NULL OR entity_type = $3)
      ORDER BY score DESC, name ASC
      LIMIT 10
    `,
    [normalizedName, threshold, entityType]
  );

  return result.rows.map((row) => ({
    ...toEntity(row),
    score: Number(row.score)
  }));
}

async function updateEntityDetails(entityId, entityData, flags = {}) {
  const phone = cleanText(entityData.phone);
  const email = cleanText(entityData.email);
  const metadata = {
    ...(flags.manual_review ? { manual_review: true } : {}),
    ...(flags.fuzzy_match_score != null ? { fuzzy_match_score: flags.fuzzy_match_score } : {})
  };

  await query(
    `
      UPDATE entities
      SET
        phone = COALESCE(entities.phone, $2),
        email = COALESCE(entities.email, $3),
        metadata = CASE
          WHEN $4::jsonb = '{}'::jsonb THEN entities.metadata
          ELSE entities.metadata || $4::jsonb
        END,
        updated_at = NOW()
      WHERE id = $1
    `,
    [entityId, phone, email, JSON.stringify(metadata)]
  );
}

async function createEntity(entityData) {
  const cleanName = cleanText(entityData.name);

  if (!cleanName) {
    throw new Error('entity name is required');
  }

  const entityType = normalizeEntityType(entityData.type, cleanName);
  const id = uuidv4();
  const result = await query(
    `
      INSERT INTO entities (
        id,
        name,
        normalized_name,
        entity_type,
        phone,
        email,
        source,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'ingestion', $7::jsonb)
      ON CONFLICT (normalized_name, entity_type)
      DO UPDATE SET
        phone = COALESCE(entities.phone, EXCLUDED.phone),
        email = COALESCE(entities.email, EXCLUDED.email),
        metadata = entities.metadata || EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING id, name, normalized_name, entity_type, phone, email, metadata
    `,
    [
      id,
      cleanName,
      normalizeName(cleanName),
      entityType,
      cleanText(entityData.phone),
      cleanText(entityData.email),
      JSON.stringify({ tags: ['ingested'] })
    ]
  );

  return toEntity(result.rows[0]);
}

async function findOrCreateEntity(entityData, similarityThreshold = 0.7) {
  const cleanName = cleanText(entityData?.name);

  if (!cleanName) {
    throw new Error('entityData.name is required');
  }

  const entityType = normalizeEntityType(entityData.type, cleanName);
  const exact = await findEntityExact(cleanName, entityType);

  if (exact) {
    await updateEntityDetails(exact.id, entityData);
    return { entity: await findEntityExact(cleanName, entityType), action: 'found' };
  }

  const fuzzyMatches = await findEntitiesFuzzy(cleanName, 0.4, entityType);
  const bestMatch = fuzzyMatches[0];

  if (bestMatch && bestMatch.score >= similarityThreshold) {
    const secondMatch = fuzzyMatches[1];
    const manualReview = Boolean(
      secondMatch && Math.abs(bestMatch.score - secondMatch.score) <= 0.03
    );
    await updateEntityDetails(bestMatch.id, entityData, {
      manual_review: manualReview,
      fuzzy_match_score: bestMatch.score
    });
    return {
      entity: await findEntityExact(bestMatch.name, bestMatch.entity_type),
      action: 'fuzzy_matched'
    };
  }

  return {
    entity: await createEntity({ ...entityData, type: entityType }),
    action: 'created'
  };
}

module.exports = {
  findOrCreateEntity,
  findEntityExact,
  findEntitiesFuzzy,
  normalizeEntityType
};
