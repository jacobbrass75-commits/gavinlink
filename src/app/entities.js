const { query } = require('../db/connection');
const { lookupBrain, getEntityDetail } = require('./brain');
const entityCluster = require('../entities/cluster');
const { normalizeName } = require('../entities/extract');
const { buildContainsPattern } = require('../utils/sql');

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function lookupEntity(options = {}) {
  return lookupBrain({ name: options.name });
}

async function searchEntities({ query: searchQuery, limit = 25, offset = 0 } = {}) {
  const normalizedQuery = normalizeName(searchQuery);
  const result = await query(
    `
      SELECT
        id,
        name,
        entity_type,
        similarity(normalized_name, $1) AS score
      FROM entities
      WHERE normalized_name % $1
         OR normalized_name LIKE $2 ESCAPE '\\'
      ORDER BY score DESC, name ASC
      LIMIT $3
      OFFSET $4
    `,
    [normalizedQuery, buildContainsPattern(normalizedQuery), limit, offset]
  );

  return {
    results: result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.entity_type,
      score: Number(row.score)
    })),
    total: result.rows.length,
    limit,
    offset
  };
}

async function listEntities({ type = null, limit = 25, offset = 0 } = {}) {
  const countResult = await query(
    `
      SELECT COUNT(*)::int AS count
      FROM entities
      WHERE ($1::text IS NULL OR entity_type = $1)
    `,
    [type]
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
    [type, limit, offset]
  );

  return {
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
  };
}

async function getDistressedEntities() {
  return entityCluster.detectPortfolioDistress();
}

async function getEntityPortfolio(entityId) {
  return entityCluster.getPortfolio(entityId);
}

async function getEntityDetailById(entityId) {
  return getEntityDetail(entityId);
}

module.exports = {
  parsePositiveInteger,
  lookupEntity,
  searchEntities,
  listEntities,
  getDistressedEntities,
  getEntityPortfolio,
  getEntityDetailById
};
