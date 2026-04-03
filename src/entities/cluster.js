const { query } = require('../db/connection');

const MAX_DEPTH = 5;

async function getEntityRow(entityId) {
  const result = await query(
    `
      SELECT id, name, entity_type
      FROM entities
      WHERE id = $1
    `,
    [entityId]
  );

  return result.rows[0] || null;
}

async function getReachableEntities(entityId) {
  const result = await query(
    `
      WITH RECURSIVE graph AS (
        SELECT
          $1::uuid AS entity_id,
          ARRAY[$1::uuid] AS path,
          0 AS depth,
          NULL::text AS relationship,
          NULL::uuid AS via_entity_id

        UNION ALL

        SELECT
          er.child_entity_id AS entity_id,
          graph.path || er.child_entity_id,
          graph.depth + 1,
          er.relationship_type,
          graph.entity_id
        FROM graph
        JOIN entity_relationships er
          ON er.parent_entity_id = graph.entity_id
        WHERE graph.depth < $2
          AND NOT (er.child_entity_id = ANY(graph.path))
      )
      SELECT DISTINCT ON (graph.entity_id)
        graph.entity_id,
        graph.relationship,
        graph.via_entity_id,
        graph.depth,
        entities.name,
        entities.entity_type
      FROM graph
      JOIN entities ON entities.id = graph.entity_id
      ORDER BY graph.entity_id, graph.depth ASC
    `,
    [entityId, MAX_DEPTH]
  );

  return result.rows;
}

async function getPortfolio(entityId) {
  const entity = await getEntityRow(entityId);

  if (!entity) {
    return null;
  }

  const reachableEntities = await getReachableEntities(entityId);
  const reachableIds = reachableEntities.map((row) => row.entity_id);
  const relatedEntities = reachableEntities
    .filter((row) => row.entity_id !== entityId)
    .map((row) => ({
      id: row.entity_id,
      name: row.name,
      type: row.entity_type,
      relationship: row.relationship
    }));
  const propertiesResult = await query(
    `
      SELECT DISTINCT
        p.id,
        p.apn,
        p.address,
        p.city,
        p.assessed_value,
        p.property_type,
        p.foreclosure
      FROM properties p
      WHERE p.owner_entity_id = ANY($1::uuid[])
      ORDER BY p.address NULLS LAST, p.apn
    `,
    [reachableIds]
  );
  const properties = propertiesResult.rows.map((row) => ({
    id: row.id,
    apn: row.apn,
    address: row.address,
    city: row.city,
    assessed_value: row.assessed_value == null ? null : Number(row.assessed_value),
    property_type: row.property_type,
    foreclosure: row.foreclosure
  }));
  const totalAssessedValue = properties.reduce(
    (sum, property) => sum + (property.assessed_value || 0),
    0
  );

  return {
    entity: {
      id: entity.id,
      name: entity.name,
      type: entity.entity_type
    },
    related_entities: relatedEntities,
    properties,
    total_assessed_value: totalAssessedValue
  };
}

async function getTopPortfolios({ minProperties = 2 } = {}) {
  const entitiesResult = await query(
    `
      SELECT id
      FROM entities
      WHERE entity_type IN ('person', 'llc', 'trust', 'corporation', 'partnership')
      ORDER BY name ASC
    `
  );
  const portfolios = [];

  for (const entity of entitiesResult.rows) {
    const portfolio = await getPortfolio(entity.id);

    if (portfolio && portfolio.properties.length >= minProperties) {
      portfolios.push({
        ...portfolio,
        property_count: portfolio.properties.length
      });
    }
  }

  portfolios.sort((left, right) => right.total_assessed_value - left.total_assessed_value);

  return portfolios;
}

async function detectPortfolioDistress() {
  const portfolios = await getTopPortfolios({ minProperties: 2 });

  return portfolios
    .map((portfolio) => {
      const distressedProperties = portfolio.properties.filter((property) => property.foreclosure);

      if (distressedProperties.length < 2) {
        return null;
      }

      return {
        entity: portfolio.entity,
        foreclosure_count: distressedProperties.length,
        properties: distressedProperties
      };
    })
    .filter(Boolean);
}

module.exports = {
  getPortfolio,
  getTopPortfolios,
  detectPortfolioDistress
};
