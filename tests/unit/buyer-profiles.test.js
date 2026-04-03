const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { query, close } = require('../../src/db/connection');
const {
  createBuyerProfile,
  getBuyerProfile,
  updateBuyerProfile,
  listBuyerProfiles,
  searchBuyerProfiles,
  deactivateBuyerProfile
} = require('../../src/buyers/profiles');
const { normalizeName } = require('../../src/entities/extract');

const ROOT = path.join(__dirname, '..', '..');

function runNodeScript(scriptPath) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: ROOT,
    encoding: 'utf8'
  });
}

async function resetTables() {
  await query(`
    TRUNCATE
      buyer_purchases,
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

test.before(async () => {
  const migrationRun = runNodeScript(path.join(ROOT, 'scripts', 'migrate.js'));
  assert.equal(migrationRun.status, 0, migrationRun.stderr || migrationRun.stdout);
});

test.beforeEach(async () => {
  await resetTables();
});

test.after(async () => {
  await close();
});

test('createBuyerProfile creates a profile and auto-creates an entity', async () => {
  const profile = await createBuyerProfile({
    entity_name: 'Mike Chen',
    target_property_types: ['industrial'],
    target_cities: ['Carson', 'Compton']
  });

  assert.equal(profile.entity_name, 'Mike Chen');
  assert.deepEqual(profile.target_property_types, ['industrial']);
  assert.deepEqual(profile.target_cities, ['Carson', 'Compton']);
});

test('createBuyerProfile links to an existing fuzzy-matched entity', async () => {
  const entityResult = await query(
    `
      INSERT INTO entities (id, name, normalized_name, entity_type, source)
      VALUES ($2, 'Mike Chen', $1, 'person', 'test')
      RETURNING id
    `,
    [normalizeName('Mike Chen'), uuidv4()]
  );
  const entityId = entityResult.rows[0].id;
  const profile = await createBuyerProfile({
    entity_name: 'Mike   Chen',
    target_property_types: ['industrial']
  });

  assert.equal(profile.entity_id, entityId);

  const entityCount = await query('SELECT COUNT(*)::int AS count FROM entities');
  assert.equal(entityCount.rows[0].count, 1);
});

test('getBuyerProfile returns null when profile does not exist', async () => {
  const profile = await getBuyerProfile('00000000-0000-4000-8000-000000000000');
  assert.equal(profile, null);
});

test('updateBuyerProfile merges arrays and appends sensibilities', async () => {
  const profile = await createBuyerProfile({
    entity_name: 'Mike Chen',
    target_cities: ['Carson', 'Compton'],
    sensibilities: 'Numbers-driven, direct communicator'
  });
  const updated = await updateBuyerProfile(profile.id, {
    target_cities: ['Long Beach'],
    sensibilities: 'Also interested in value-add plays'
  });

  assert.deepEqual(updated.target_cities, ['Carson', 'Compton', 'Long Beach']);
  assert.match(updated.sensibilities, /Numbers-driven, direct communicator/);
  assert.match(updated.sensibilities, /\[\d{4}-\d{2}-\d{2}\] Also interested in value-add plays/);
});

test('updateBuyerProfile preserves unspecified fields', async () => {
  const profile = await createBuyerProfile({
    entity_name: 'Mike Chen',
    target_cities: ['Carson'],
    max_price: 4000000
  });
  const updated = await updateBuyerProfile(profile.id, {
    target_property_types: ['industrial']
  });

  assert.equal(updated.max_price, 4000000);
  assert.deepEqual(updated.target_cities, ['Carson']);
  assert.deepEqual(updated.target_property_types, ['industrial']);
});

test('listBuyerProfiles supports active filtering by property type and city', async () => {
  await createBuyerProfile({
    entity_name: 'Mike Chen',
    target_property_types: ['industrial'],
    target_cities: ['Carson']
  });
  await createBuyerProfile({
    entity_name: 'Sarah Patel',
    target_property_types: ['retail'],
    target_cities: ['Pasadena']
  });

  const result = await listBuyerProfiles({
    property_type: 'industrial',
    city: 'Carson'
  });

  assert.equal(result.total, 1);
  assert.equal(result.profiles[0].entity_name, 'Mike Chen');
});

test('searchBuyerProfiles finds profiles by name and criteria', async () => {
  await createBuyerProfile({
    entity_name: 'Mike Chen',
    target_property_types: ['industrial'],
    target_cities: ['Carson']
  });

  const byName = await searchBuyerProfiles('Mike');
  const byCriteria = await searchBuyerProfiles('industrial');

  assert.equal(byName.length, 1);
  assert.equal(byCriteria.length, 1);
});

test('deactivateBuyerProfile marks the profile inactive and removes it from active listings', async () => {
  const profile = await createBuyerProfile({
    entity_name: 'Mike Chen'
  });

  const deactivated = await deactivateBuyerProfile(profile.id);
  const listed = await listBuyerProfiles();

  assert.equal(deactivated.active, false);
  assert.equal(deactivated.status, 'archived');
  assert.equal(listed.total, 0);
});
