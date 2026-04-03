const { query } = require('../db/connection');

const PROPERTY_LENDERS_CTE = `
  WITH property_lenders AS (
    SELECT trustee_entity_id AS entity_id, id AS property_id
    FROM properties
    WHERE trustee_entity_id IS NOT NULL

    UNION

    SELECT lender_entity_id AS entity_id, id AS property_id
    FROM properties
    WHERE lender_entity_id IS NOT NULL
  )
`;

async function getLenderReport() {
  const result = await query(
    `
      ${PROPERTY_LENDERS_CTE}
      SELECT
        e.id AS entity_id,
        e.name,
        e.entity_type,
        e.phone,
        COUNT(p.id)::int AS property_count,
        COALESCE(SUM(p.assessed_value), 0) AS total_assessed_value,
        COALESCE(AVG(p.assessed_value), 0) AS avg_assessed_value,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT p.city), NULL) AS cities,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT p.property_type), NULL) AS property_types
      FROM property_lenders pl
      JOIN entities e ON e.id = pl.entity_id
      JOIN properties p ON p.id = pl.property_id
      GROUP BY e.id, e.name, e.entity_type, e.phone
      ORDER BY property_count DESC, total_assessed_value DESC, e.name ASC
    `
  );

  return result.rows.map((row) => ({
    entity_id: row.entity_id,
    name: row.name,
    entity_type: row.entity_type,
    property_count: row.property_count,
    total_assessed_value: Number(row.total_assessed_value || 0),
    avg_assessed_value: Number(row.avg_assessed_value || 0),
    cities: row.cities || [],
    property_types: row.property_types || [],
    phone: row.phone
  }));
}

async function getLenderDetail(entityId) {
  const entityResult = await query(
    `
      SELECT id, name, entity_type, phone
      FROM entities
      WHERE id = $1
    `,
    [entityId]
  );
  const entity = entityResult.rows[0];

  if (!entity) {
    return null;
  }

  const propertiesResult = await query(
    `
      ${PROPERTY_LENDERS_CTE}
      SELECT DISTINCT
        p.id,
        p.apn,
        p.address,
        p.city,
        p.state,
        p.assessed_value,
        p.default_amount,
        p.foreclosure,
        owner.name AS owner_name
      FROM property_lenders pl
      JOIN properties p ON p.id = pl.property_id
      LEFT JOIN entities owner ON owner.id = p.owner_entity_id
      WHERE pl.entity_id = $1
      ORDER BY p.address NULLS LAST, p.apn
    `,
    [entityId]
  );
  const properties = propertiesResult.rows.map((row) => ({
    id: row.id,
    apn: row.apn,
    address: row.address,
    city: row.city,
    state: row.state,
    assessed_value: row.assessed_value == null ? null : Number(row.assessed_value),
    default_amount: row.default_amount == null ? null : Number(row.default_amount),
    foreclosure: row.foreclosure,
    owner_name: row.owner_name
  }));

  return {
    entity: {
      id: entity.id,
      name: entity.name,
      entity_type: entity.entity_type,
      phone: entity.phone
    },
    properties,
    foreclosure_count: properties.filter((property) => property.foreclosure).length,
    total_default_amount: properties.reduce(
      (sum, property) => sum + (property.default_amount || 0),
      0
    ),
    geographic_spread: [...new Set(properties.map((property) => property.city).filter(Boolean))]
  };
}

async function getLenderOwnerOverlaps() {
  const result = await query(
    `
      ${PROPERTY_LENDERS_CTE}
      SELECT
        lender.id AS lender_entity_id,
        lender.name AS lender_name,
        owner.id AS owner_entity_id,
        owner.name AS owner_name,
        COUNT(p.id)::int AS property_count,
        ARRAY_AGG(
          jsonb_build_object(
            'id', p.id,
            'apn', p.apn,
            'address', p.address,
            'city', p.city
          )
          ORDER BY p.apn
        ) AS properties
      FROM property_lenders pl
      JOIN properties p ON p.id = pl.property_id
      JOIN entities lender ON lender.id = pl.entity_id
      JOIN entities owner ON owner.id = p.owner_entity_id
      GROUP BY lender.id, lender.name, owner.id, owner.name
      HAVING COUNT(p.id) >= 2
      ORDER BY property_count DESC, lender.name ASC, owner.name ASC
    `
  );

  return result.rows.map((row) => ({
    lender_entity_id: row.lender_entity_id,
    lender_name: row.lender_name,
    owner_entity_id: row.owner_entity_id,
    owner_name: row.owner_name,
    property_count: row.property_count,
    properties: row.properties || []
  }));
}

module.exports = {
  getLenderReport,
  getLenderDetail,
  getLenderOwnerOverlaps
};
