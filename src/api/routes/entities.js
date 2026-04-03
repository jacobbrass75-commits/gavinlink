const express = require('express');
const { query } = require('../../db/connection');
const { getPortfolio, detectPortfolioDistress } = require('../../entities/cluster');
const { normalizeName } = require('../../entities/extract');

const router = express.Router();

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

async function getEntityDetail(id) {
  const entityResult = await query(
    `
      SELECT id, name, entity_type, source, metadata, created_at, updated_at
      FROM entities
      WHERE id = $1
    `,
    [id]
  );
  const entity = entityResult.rows[0];

  if (!entity) {
    return null;
  }

  const relationshipsResult = await query(
    `
      SELECT
        er.id,
        er.relationship_type,
        er.source,
        er.confidence,
        CASE
          WHEN er.parent_entity_id = $1 THEN child.id
          ELSE parent.id
        END AS related_entity_id,
        CASE
          WHEN er.parent_entity_id = $1 THEN child.name
          ELSE parent.name
        END AS related_entity_name,
        CASE
          WHEN er.parent_entity_id = $1 THEN child.entity_type
          ELSE parent.entity_type
        END AS related_entity_type,
        CASE
          WHEN er.parent_entity_id = $1 THEN 'outbound'
          ELSE 'inbound'
        END AS direction
      FROM entity_relationships er
      JOIN entities parent ON parent.id = er.parent_entity_id
      JOIN entities child ON child.id = er.child_entity_id
      WHERE er.parent_entity_id = $1
         OR er.child_entity_id = $1
      ORDER BY er.created_at ASC
    `,
    [id]
  );
  const propertiesResult = await query(
    `
      SELECT DISTINCT
        p.id,
        p.apn,
        p.address,
        p.city,
        p.state,
        p.assessed_value,
        p.property_type,
        CASE
          WHEN p.owner_entity_id = $1 THEN 'owner'
          WHEN p.trustee_entity_id = $1 THEN 'trustee'
          ELSE 'lender'
        END AS role
      FROM properties p
      WHERE p.owner_entity_id = $1
         OR p.trustee_entity_id = $1
         OR p.lender_entity_id = $1
      ORDER BY p.address NULLS LAST, p.apn
    `,
    [id]
  );

  return {
    entity: {
      id: entity.id,
      name: entity.name,
      type: entity.entity_type,
      source: entity.source,
      metadata: entity.metadata,
      created_at: entity.created_at,
      updated_at: entity.updated_at
    },
    relationships: relationshipsResult.rows.map((row) => ({
      id: row.id,
      relationship: row.relationship_type,
      source: row.source,
      confidence: row.confidence == null ? null : Number(row.confidence),
      direction: row.direction,
      entity: {
        id: row.related_entity_id,
        name: row.related_entity_name,
        type: row.related_entity_type
      }
    })),
    properties: propertiesResult.rows.map((row) => ({
      id: row.id,
      apn: row.apn,
      address: row.address,
      city: row.city,
      state: row.state,
      assessed_value: row.assessed_value == null ? null : Number(row.assessed_value),
      property_type: row.property_type,
      role: row.role
    }))
  };
}

router.get('/api/entities/search', async (req, res) => {
  const q = String(req.query.q || '').trim();

  if (q === '') {
    return res.status(400).json({
      error: 'q is required'
    });
  }

  const limit = Math.min(parsePositiveInteger(req.query.limit, 25) || 25, 100);
  const offset = parsePositiveInteger(req.query.offset, 0);
  const normalizedQuery = normalizeName(q);
  const result = await query(
    `
      SELECT
        id,
        name,
        entity_type,
        similarity(normalized_name, $1) AS score
      FROM entities
      WHERE normalized_name % $1
         OR normalized_name LIKE $2
      ORDER BY score DESC, name ASC
      LIMIT $3
      OFFSET $4
    `,
    [normalizedQuery, `%${normalizedQuery}%`, limit, offset]
  );

  return res.json({
    results: result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.entity_type,
      score: Number(row.score)
    })),
    limit,
    offset
  });
});

router.get('/api/entities/distressed', async (_req, res, next) => {
  try {
    const results = await detectPortfolioDistress();
    res.json({
      results,
      total: results.length
    });
  } catch (error) {
    next(error);
  }
});

router.get('/api/entities/:id/portfolio', async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isUuid(id)) {
      return res.status(400).json({
        error: 'id must be a valid UUID'
      });
    }

    const portfolio = await getPortfolio(id);

    if (!portfolio) {
      return res.status(404).json({
        error: 'Entity not found'
      });
    }

    return res.json(portfolio);
  } catch (error) {
    return next(error);
  }
});

router.get('/api/entities/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isUuid(id)) {
      return res.status(400).json({
        error: 'id must be a valid UUID'
      });
    }

    const entityDetail = await getEntityDetail(id);

    if (!entityDetail) {
      return res.status(404).json({
        error: 'Entity not found'
      });
    }

    return res.json(entityDetail);
  } catch (error) {
    return next(error);
  }
});

router.get('/api/entities', async (req, res, next) => {
  try {
    const limit = Math.min(parsePositiveInteger(req.query.limit, 25) || 25, 100);
    const offset = parsePositiveInteger(req.query.offset, 0);
    const entityType = typeof req.query.type === 'string' && req.query.type.trim() !== ''
      ? req.query.type.trim().toLowerCase()
      : null;
    const countResult = await query(
      `
        SELECT COUNT(*)::int AS count
        FROM entities
        WHERE ($1::text IS NULL OR entity_type = $1)
      `,
      [entityType]
    );
    const rowsResult = await query(
      `
        SELECT id, name, entity_type, source, created_at, updated_at
        FROM entities
        WHERE ($1::text IS NULL OR entity_type = $1)
        ORDER BY name ASC
        LIMIT $2
        OFFSET $3
      `,
      [entityType, limit, offset]
    );

    return res.json({
      results: rowsResult.rows.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.entity_type,
        source: row.source,
        created_at: row.created_at,
        updated_at: row.updated_at
      })),
      total: countResult.rows[0].count,
      limit,
      offset
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/brain/entity/:id', (_req, res) => {
  res.status(501).json({
    status: 'not_implemented',
    module: 'Module 2',
    message: 'This endpoint will be implemented in Module 2: Entity Extraction'
  });
});

module.exports = router;
