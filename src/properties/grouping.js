const { v4: uuidv4 } = require('uuid');
const { getPool, query } = require('../db/connection');

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function normalizeAddress(value) {
  const text = cleanText(value, null);

  if (!text) {
    return null;
  }

  return text
    .toUpperCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeApn(value) {
  const text = cleanText(value, null);

  if (!text) {
    return null;
  }

  return text.replace(/\s+/g, '').toUpperCase();
}

function buildGroupCandidates(property = {}) {
  const candidates = [];
  const normalizedAddress = normalizeAddress(property.address);
  const normalizedApn = normalizeApn(property.apn);

  if (normalizedAddress) {
    candidates.push(`address:${normalizedAddress}`);
  }

  if (normalizedApn) {
    candidates.push(`apn:${normalizedApn}`);
  }

  if (candidates.length === 0 && property.id) {
    candidates.push(`property:${property.id}`);
  }

  return candidates;
}

async function findGroupByCandidates(client, region, candidates) {
  if (!region || candidates.length === 0) {
    return null;
  }

  const result = await client.query(
    `
      SELECT *
      FROM property_groups
      WHERE region = $1
        AND (group_key = ANY($2::text[]) OR aliases && $2::text[])
      ORDER BY CASE WHEN group_key = ANY($2::text[]) THEN 0 ELSE 1 END, created_at ASC
      LIMIT 1
    `,
    [region, candidates]
  );

  return result.rows[0] || null;
}

async function persistPropertyGroup(client, property) {
  const region = cleanText(property.region, 'la_county');
  const candidates = buildGroupCandidates(property);
  const primaryKey = candidates[0];

  if (!primaryKey) {
    return null;
  }

  const existing = await findGroupByCandidates(client, region, candidates);

  if (existing) {
    const aliases = [...new Set([...(existing.aliases || []), ...candidates])];
    const updateResult = await client.query(
      `
        UPDATE property_groups
        SET canonical_address = COALESCE($2, canonical_address),
            canonical_city = COALESCE($3, canonical_city),
            canonical_state = COALESCE($4, canonical_state),
            aliases = $5::text[],
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        existing.id,
        cleanText(property.address, null),
        cleanText(property.city, null),
        cleanText(property.state, null),
        aliases
      ]
    );

    return updateResult.rows[0];
  }

  const insertResult = await client.query(
    `
      INSERT INTO property_groups (
        id,
        region,
        group_key,
        canonical_address,
        canonical_city,
        canonical_state,
        aliases,
        source,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9::jsonb)
      RETURNING *
    `,
    [
      uuidv4(),
      region,
      primaryKey,
      cleanText(property.address, null),
      cleanText(property.city, null),
      cleanText(property.state, null),
      candidates,
      cleanText(property.source, 'system'),
      JSON.stringify({
        normalized_address: normalizeAddress(property.address),
        normalized_apn: normalizeApn(property.apn)
      })
    ]
  );

  return insertResult.rows[0];
}

async function assignPropertyGroup(client, property) {
  if (!property?.id) {
    return null;
  }

  const group = await persistPropertyGroup(client, property);

  if (!group) {
    return null;
  }

  await client.query(
    `
      UPDATE properties
      SET property_group_id = $2,
          updated_at = NOW()
      WHERE id = $1
        AND property_group_id IS DISTINCT FROM $2
    `,
    [property.id, group.id]
  );

  return group;
}

async function syncPropertyGroupForPropertyId(propertyId) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await client.query(
      `
        SELECT id, apn, address, city, state, region, source, property_group_id
        FROM properties
        WHERE id = $1
      `,
      [propertyId]
    );
    const property = result.rows[0];

    if (!property) {
      await client.query('ROLLBACK');
      return null;
    }

    const group = await assignPropertyGroup(client, property);
    await client.query('COMMIT');
    return group;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function syncPropertyGroups(properties = []) {
  const pool = getPool();
  const client = await pool.connect();
  const groups = [];

  try {
    await client.query('BEGIN');

    for (const property of properties) {
      const group = await assignPropertyGroup(client, property);

      if (group) {
        groups.push(group);
      }
    }

    await client.query('COMMIT');
    return groups;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getPropertyGroup(groupId) {
  const groupResult = await query(
    `
      SELECT *
      FROM property_groups
      WHERE id = $1
    `,
    [groupId]
  );
  const group = groupResult.rows[0];

  if (!group) {
    return null;
  }

  const propertiesResult = await query(
    `
      SELECT id, apn, address, city, state, property_type, assessed_value, foreclosure
      FROM properties
      WHERE property_group_id = $1
      ORDER BY address NULLS LAST, apn ASC
    `,
    [groupId]
  );
  const importRecordsResult = await query(
    `
      SELECT id, source, source_file, source_row_number, source_record_key, apn, address, city, created_at
      FROM property_import_records
      WHERE property_group_id = $1
      ORDER BY created_at DESC, source_row_number DESC NULLS LAST
      LIMIT 100
    `,
    [groupId]
  );
  const documentsResult = await query(
    `
      SELECT id, property_id, file_name, mime_type, file_size, document_type, source, created_at
      FROM property_documents
      WHERE property_group_id = $1
      ORDER BY created_at DESC
      LIMIT 100
    `,
    [groupId]
  );

  return {
    id: group.id,
    region: group.region,
    group_key: group.group_key,
    canonical_address: group.canonical_address,
    canonical_city: group.canonical_city,
    canonical_state: group.canonical_state,
    aliases: group.aliases || [],
    metadata: group.metadata || {},
    created_at: group.created_at,
    updated_at: group.updated_at,
    properties: propertiesResult.rows.map((row) => ({
      ...row,
      assessed_value: row.assessed_value == null ? null : Number(row.assessed_value)
    })),
    import_records: importRecordsResult.rows,
    documents: documentsResult.rows
  };
}

async function getPropertyGroupForProperty(propertyId) {
  const result = await query(
    `
      SELECT property_group_id
      FROM properties
      WHERE id = $1
    `,
    [propertyId]
  );
  const propertyGroupId = result.rows[0]?.property_group_id;

  if (propertyGroupId) {
    return getPropertyGroup(propertyGroupId);
  }

  const group = await syncPropertyGroupForPropertyId(propertyId);
  return group ? getPropertyGroup(group.id) : null;
}

module.exports = {
  normalizeAddress,
  normalizeApn,
  buildGroupCandidates,
  syncPropertyGroupForPropertyId,
  syncPropertyGroups,
  getPropertyGroup,
  getPropertyGroupForProperty
};
