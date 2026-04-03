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

async function findPortfolioDistress() {
  const result = await query(
    `
      SELECT
        owner.id AS entity_id,
        owner.name AS entity_name,
        COUNT(p.id)::int AS foreclosure_count,
        COALESCE(SUM(p.assessed_value), 0) AS total_assessed_value,
        COALESCE(SUM(p.default_amount), 0) AS total_default_amount,
        ARRAY_AGG(
          jsonb_build_object(
            'id', p.id,
            'apn', p.apn,
            'address', p.address,
            'city', p.city,
            'assessed_value', p.assessed_value,
            'distress_level', sp.distress_level
          )
          ORDER BY COALESCE(sp.distress_level, 0) DESC, p.apn
        ) AS properties
      FROM properties p
      JOIN entities owner ON owner.id = p.owner_entity_id
      LEFT JOIN seller_profiles sp ON sp.property_id = p.id
      WHERE p.foreclosure = TRUE
      GROUP BY owner.id, owner.name
      HAVING COUNT(p.id) >= 2
      ORDER BY foreclosure_count DESC, total_assessed_value DESC, owner.name ASC
    `
  );

  return result.rows.map((row) => ({
    entity_id: row.entity_id,
    entity_name: row.entity_name,
    foreclosure_count: row.foreclosure_count,
    total_assessed_value: Number(row.total_assessed_value || 0),
    total_default_amount: Number(row.total_default_amount || 0),
    properties: row.properties || []
  }));
}

async function findLenderOwnerPatterns() {
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
            'city', p.city,
            'assessed_value', p.assessed_value
          )
          ORDER BY p.apn
        ) AS properties
      FROM property_lenders pl
      JOIN properties p ON p.id = pl.property_id
      JOIN entities lender ON lender.id = pl.entity_id
      JOIN entities owner ON owner.id = p.owner_entity_id
      WHERE p.foreclosure = TRUE
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
  findPortfolioDistress,
  findLenderOwnerPatterns
};
