const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../db/connection');

const LLC_PATTERN = /\bL\.?\s*L\.?\s*C\.?\b/;
const CORPORATION_PATTERN = /\b(?:INC(?:ORPORATED)?|CORP(?:ORATION)?)\b/;
const TRUST_PATTERN = /\b(?:TRUST|TRUSTEE)\b/;
const PARTNERSHIP_PATTERN = /\b(?:L\.?\s*P\.?\b|PARTNERS?\b|PARTNERSHIP\b)\b/;
const LENDER_PATTERN = /\b(?:SERVIC(?:E|ES|ING)|BANK|LENDING|MORTGAGE|FINANCIAL)\b/;

function normalizeName(name) {
  if (typeof name !== 'string') {
    return '';
  }

  return name
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:]+$/g, '')
    .toUpperCase();
}

function classifyEntityType(name, sourceField = '') {
  const normalized = normalizeName(name);

  if (normalized === '') {
    return 'unknown';
  }

  if (LLC_PATTERN.test(normalized)) {
    return 'llc';
  }

  if (CORPORATION_PATTERN.test(normalized)) {
    return 'corporation';
  }

  if (TRUST_PATTERN.test(normalized)) {
    return 'trust';
  }

  if (PARTNERSHIP_PATTERN.test(normalized)) {
    return 'partnership';
  }

  if (
    (sourceField === 'trustee_name' || sourceField === 'beneficiary_name') &&
    LENDER_PATTERN.test(normalized)
  ) {
    return 'lender';
  }

  return 'person';
}

function getPropertyField(property, fieldNames) {
  for (const fieldName of fieldNames) {
    const value = property?.[fieldName];

    if (typeof value === 'string' && value.trim() !== '') {
      return {
        fieldName,
        value: value.trim()
      };
    }
  }

  return null;
}

function extractEntities(property) {
  const fields = [
    getPropertyField(property, ['owner_first_name', 'owner_name']),
    getPropertyField(property, ['trustee_name']),
    getPropertyField(property, ['beneficiary_name'])
  ].filter(Boolean);
  const seen = new Set();
  const source = property?.source || 'realestatetool';
  const entities = [];

  for (const field of fields) {
    const normalizedName = normalizeName(field.value);

    if (normalizedName === '') {
      continue;
    }

    const entityType = classifyEntityType(field.value, field.fieldName);
    const key = `${normalizedName}:${entityType}:${field.fieldName}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    entities.push({
      name: field.value,
      normalized_name: normalizedName,
      entity_type: entityType,
      source_field: field.fieldName,
      source
    });
  }

  return entities;
}

function getPropertyLinkColumn(sourceField) {
  if (sourceField === 'owner_first_name' || sourceField === 'owner_name') {
    return 'owner_entity_id';
  }

  if (sourceField === 'trustee_name') {
    return 'trustee_entity_id';
  }

  if (sourceField === 'beneficiary_name') {
    return 'lender_entity_id';
  }

  return null;
}

async function upsertEntity(client, entity) {
  const result = await client.query(
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
      DO UPDATE SET
        updated_at = NOW(),
        metadata = entities.metadata || EXCLUDED.metadata
      RETURNING id, (xmax = 0) AS inserted
    `,
    [
      uuidv4(),
      entity.name,
      entity.normalized_name,
      entity.entity_type,
      entity.source,
      JSON.stringify({
        source_field: entity.source_field
      })
    ]
  );

  return result.rows[0];
}

async function resolvePropertyId(client, property) {
  if (property?.id) {
    return property.id;
  }

  const region = property?.region || 'la_county';
  const result = await client.query(
    `
      SELECT id
      FROM properties
      WHERE apn = $1
        AND region = $2
    `,
    [property.apn, region]
  );

  return result.rows[0]?.id || null;
}

async function processPropertyEntities(properties) {
  const pool = getPool();
  const client = await pool.connect();
  let created = 0;
  let existing = 0;
  let linked = 0;

  try {
    await client.query('BEGIN');

    for (const property of properties) {
      const propertyId = await resolvePropertyId(client, property);

      if (!propertyId) {
        continue;
      }

      const entities = extractEntities(property);

      for (const entity of entities) {
        const upserted = await upsertEntity(client, entity);
        const linkColumn = getPropertyLinkColumn(entity.source_field);

        if (upserted.inserted) {
          created += 1;
        } else {
          existing += 1;
        }

        if (linkColumn) {
          const linkResult = await client.query(
            `
              UPDATE properties
              SET ${linkColumn} = $1,
                  updated_at = NOW()
              WHERE id = $2
                AND ${linkColumn} IS DISTINCT FROM $1
            `,
            [upserted.id, propertyId]
          );

          linked += linkResult.rowCount;
        }
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return {
    created,
    existing,
    linked
  };
}

module.exports = {
  classifyEntityType,
  normalizeName,
  extractEntities,
  processPropertyEntities
};
