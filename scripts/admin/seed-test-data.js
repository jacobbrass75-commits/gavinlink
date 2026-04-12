const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getPool, close } = require('../../src/db/connection');

const fixturePath = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'sample-properties.json');
const TEST_BUYER_PROFILES = [
  {
    entity_name: 'Mike Chen',
    target_property_types: ['industrial'],
    target_cities: ['Los Angeles', 'Long Beach', 'Carson'],
    max_price: 5000000,
    min_sq_feet: 20000,
    investment_strategy: 'value_add',
    financing_preference: 'sba',
    typical_close_timeline: '90_days',
    urgency: 'actively_looking',
    sensibilities: 'Numbers-driven, direct communicator',
    notes: 'Seed buyer profile for API and matching smoke tests'
  },
  {
    entity_name: 'Sarah Park',
    target_property_types: ['commercial', 'industrial'],
    target_cities: ['Woodland Hills', 'Los Angeles'],
    max_price: 8000000,
    min_sq_feet: 15000,
    investment_strategy: 'stabilized',
    financing_preference: 'cash',
    typical_close_timeline: '60_days',
    urgency: 'opportunistic',
    sensibilities: 'Prefers clean title and fast diligence',
    notes: 'Seed buyer profile for lender and match workflow checks'
  }
];

function normalizeName(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function inferOwnerEntityType(name) {
  const normalizedName = normalizeName(name);

  if (normalizedName.includes('LLC')) {
    return 'llc';
  }

  if (
    normalizedName.includes('CORP') ||
    normalizedName.includes('INC') ||
    normalizedName.endsWith('CO')
  ) {
    return 'corporation';
  }

  return 'unknown';
}

async function getOrCreateEntity(client, { name, entityType, phone, source }) {
  const normalizedName = normalizeName(name);
  const insertResult = await client.query(
    `
      INSERT INTO entities (
        id,
        entity_type,
        name,
        normalized_name,
        phone,
        source
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (normalized_name, entity_type) DO NOTHING
      RETURNING id
    `,
    [uuidv4(), entityType, name, normalizedName, phone || null, source]
  );

  if (insertResult.rows.length > 0) {
    return insertResult.rows[0].id;
  }

  const existingResult = await client.query(
    `
      SELECT id
      FROM entities
      WHERE normalized_name = $1
        AND entity_type = $2
    `,
    [normalizedName, entityType]
  );

  return existingResult.rows[0].id;
}

async function seedBuyerProfiles(client) {
  for (const buyer of TEST_BUYER_PROFILES) {
    const entityId = await getOrCreateEntity(client, {
      name: buyer.entity_name,
      entityType: 'person',
      phone: null,
      source: 'seed'
    });

    await client.query(
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
          $1, $2, 'active', TRUE, $3::text[], ARRAY[]::text[], $4::text[], ARRAY[]::text[],
          NULL, $5, $6, NULL, NULL, NULL, NULL, NULL, NULL, $7, $8, $9, $10, FALSE, $11, $12
        )
        ON CONFLICT (entity_id) DO UPDATE
        SET preferred_property_types = EXCLUDED.preferred_property_types,
            target_cities = EXCLUDED.target_cities,
            max_price = EXCLUDED.max_price,
            min_sq_feet = EXCLUDED.min_sq_feet,
            investment_strategy = EXCLUDED.investment_strategy,
            financing_preference = EXCLUDED.financing_preference,
            typical_close_timeline = EXCLUDED.typical_close_timeline,
            urgency = EXCLUDED.urgency,
            sensibilities = EXCLUDED.sensibilities,
            notes = EXCLUDED.notes,
            active = TRUE,
            updated_at = NOW()
      `,
      [
        uuidv4(),
        entityId,
        buyer.target_property_types,
        buyer.target_cities,
        buyer.max_price,
        buyer.min_sq_feet,
        buyer.investment_strategy,
        buyer.financing_preference,
        buyer.typical_close_timeline,
        buyer.urgency,
        buyer.sensibilities,
        buyer.notes
      ]
    );
  }
}

async function seedProperties() {
  const properties = JSON.parse(await fs.promises.readFile(fixturePath, 'utf8'));
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const property of properties) {
      const ownerEntityId = await getOrCreateEntity(client, {
        name: property.owner_name,
        entityType: inferOwnerEntityType(property.owner_name),
        phone: null,
        source: property.source
      });

      const trusteeEntityId = await getOrCreateEntity(client, {
        name: property.trustee_name,
        entityType: 'trustee',
        phone: property.trustee_phone,
        source: property.source
      });

      await client.query(
        `
          INSERT INTO properties (
            id,
            apn,
            address,
            city,
            state,
            zip,
            property_type,
            sq_feet,
            lot_size,
            assessed_value,
            units,
            foreclosure,
            source,
            region,
            owner_name,
            trustee_name,
            trustee_phone,
            owner_entity_id,
            trustee_entity_id,
            titlepro_recording_date
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
          )
          ON CONFLICT (apn, region) DO NOTHING
        `,
        [
          uuidv4(),
          property.apn,
          property.address,
          property.city,
          property.state,
          property.zip,
          property.property_type,
          property.sq_feet,
          property.lot_size,
          property.assessed_value,
          property.units ?? null,
          property.foreclosure,
          property.source,
          property.region,
          property.owner_name,
          property.trustee_name,
          property.trustee_phone,
          ownerEntityId,
          trusteeEntityId,
          property.titlepro_recording_date || null
        ]
      );
    }

    await seedBuyerProfiles(client);

    await client.query('COMMIT');
    console.log(`Seeded ${properties.length} properties`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

seedProperties()
  .finally(async () => {
    await close();
  });
