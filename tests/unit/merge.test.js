const test = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const { query, close } = require('../../src/db/connection');
const {
  findOrCreateEntity,
  findEntityExact,
  findEntitiesFuzzy
} = require('../../src/ingestion/merge');
const { normalizeName } = require('../../src/entities/extract');

test.after(async () => {
  await close();
});

async function resetTables() {
  await query(`
    TRUNCATE
      buyer_purchases,
      knowledge_entities,
      knowledge_properties,
      entity_relationships,
      deals,
      matches,
      seller_profiles,
      buyer_profiles,
      knowledge_entries,
      properties,
      entities
    RESTART IDENTITY CASCADE
  `);
}

async function insertEntity(name, entityType) {
  await query(
    `
      INSERT INTO entities (
        id,
        name,
        normalized_name,
        entity_type,
        source
      )
      VALUES ($1, $2, $3, $4, 'test')
    `,
    [uuidv4(), name, normalizeName(name), entityType]
  );
}

test('findOrCreateEntity returns exact match when present', async () => {
  await resetTables();
  await insertEntity('Mike Chen', 'person');

  const result = await findOrCreateEntity({ name: 'Mike Chen', type: 'person' });

  assert.equal(result.action, 'found');
  assert.equal(result.entity.name, 'Mike Chen');
});

test('findOrCreateEntity returns fuzzy match when close name exists', async () => {
  await resetTables();
  await insertEntity('Mike Chen', 'person');

  const result = await findOrCreateEntity({ name: 'Michael Chen', type: 'person' }, 0.3);

  assert.equal(result.action, 'fuzzy_matched');
  assert.equal(result.entity.name, 'Mike Chen');
});

test('different entity type creates a new entity', async () => {
  await resetTables();
  await insertEntity('Mike Chen', 'person');

  const result = await findOrCreateEntity({ name: 'Mike Chen', type: 'company' });
  const allMikeEntities = await query(
    `
      SELECT COUNT(*)::int AS count
      FROM entities
      WHERE normalized_name = $1
    `,
    [normalizeName('Mike Chen')]
  );

  assert.equal(result.action, 'created');
  assert.equal(allMikeEntities.rows[0].count, 2);
});

test('below-threshold match creates a new entity', async () => {
  await resetTables();
  await insertEntity('Mike Chen', 'person');

  const result = await findOrCreateEntity({ name: 'Steve Park', type: 'person' }, 0.7);
  assert.equal(result.action, 'created');
});

test('empty database creates a new entity', async () => {
  await resetTables();

  const result = await findOrCreateEntity({ name: 'Mike Chen', type: 'person' });
  const exact = await findEntityExact('Mike Chen', 'person');
  const fuzzy = await findEntitiesFuzzy('Mike Chen', 0.4, 'person');

  assert.equal(result.action, 'created');
  assert.ok(exact);
  assert.ok(fuzzy.length >= 1);
});
