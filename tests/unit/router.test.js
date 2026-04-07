const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { query, close } = require('../../src/db/connection');
const { routeClassifiedMessage } = require('../../src/ingestion/router');
const { getBuyerProfileByEntity } = require('../../src/buyers/profiles');
const { getKnowledgeEntry } = require('../../src/knowledge/extract');
const { resetEmbeddingsCollection } = require('../../src/knowledge/embeddings');
const { findEntityExact } = require('../../src/ingestion/merge');

const ROOT = path.join(__dirname, '..', '..');

test.after(async () => {
  await close();
});

function runNodeScript(scriptPath, args = []) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env
  });
}

async function resetTables() {
  await query(`
    TRUNCATE
      buyer_purchases,
      property_documents,
      property_import_records,
      wiki_promotion_queue,
      knowledge_entities,
      knowledge_properties,
      property_groups,
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
  await resetEmbeddingsCollection();
}

test('routeClassifiedMessage creates new buyer entities, profile, and knowledge entry', async () => {
  const migrateRun = runNodeScript(path.join(ROOT, 'scripts', 'migrate.js'));
  assert.equal(migrateRun.status, 0, migrateRun.stderr || migrateRun.stdout);

  await resetTables();

  const result = await routeClassifiedMessage(
    {
      classifications: ['buyer_intel'],
      entities: [
        { name: 'Mike Chen', type: 'person' },
        { name: 'Pacific Industrial Group', type: 'company' }
      ],
      relationships: [
        {
          entity_a: 'Mike Chen',
          entity_b: 'Pacific Industrial Group',
          relationship: 'principal_of'
        }
      ],
      buyer_profile: {
        entity_name: 'Mike Chen',
        target_property_types: ['industrial'],
        target_cities: ['Carson'],
        max_price: 4000000
      },
      seller_profile: null,
      property_ref: null,
      action_items: ['Run matching for Mike Chen'],
      summary: 'Buyer note for Mike Chen'
    },
    'Mike Chen wants industrial in Carson',
    { source: 'api' }
  );

  const mike = await findEntityExact('Mike Chen', 'person');
  const buyerProfile = await getBuyerProfileByEntity(mike.id);
  const knowledgeEntry = await getKnowledgeEntry(result.knowledge_entry_id);
  const relationshipCount = await query('SELECT COUNT(*)::int AS count FROM entity_relationships');

  assert.ok(result.created.some((line) => line.includes('Mike Chen')));
  assert.ok(buyerProfile);
  assert.equal(knowledgeEntry.ai_summary, 'Buyer note for Mike Chen');
  assert.equal(relationshipCount.rows[0].count, 1);
});

test('routeClassifiedMessage merges repeated buyer mentions', async () => {
  await resetTables();

  await routeClassifiedMessage(
    {
      classifications: ['buyer_intel'],
      entities: [{ name: 'Mike Chen', type: 'person' }],
      relationships: [],
      buyer_profile: {
        entity_name: 'Mike Chen',
        target_property_types: ['industrial'],
        target_cities: ['Carson']
      },
      seller_profile: null,
      property_ref: null,
      action_items: [],
      summary: 'First buyer note'
    },
    'Mike Chen wants industrial in Carson',
    { source: 'api' }
  );

  await routeClassifiedMessage(
    {
      classifications: ['buyer_intel'],
      entities: [{ name: 'Mike Chen', type: 'person' }],
      relationships: [],
      buyer_profile: {
        entity_name: 'Mike Chen',
        target_cities: ['Long Beach'],
        sensibilities: 'Direct communicator'
      },
      seller_profile: null,
      property_ref: null,
      action_items: [],
      summary: 'Second buyer note'
    },
    'Mike Chen also likes Long Beach. Direct communicator.',
    { source: 'api' }
  );

  const mike = await findEntityExact('Mike Chen', 'person');
  const buyerProfile = await getBuyerProfileByEntity(mike.id);

  assert.deepEqual(buyerProfile.target_cities, ['Carson', 'Long Beach']);
  assert.match(buyerProfile.sensibilities, /Direct communicator/);
});

test('routeClassifiedMessage creates seller profile for known property', async () => {
  await resetTables();
  const importRun = runNodeScript(path.join(ROOT, 'scripts', 'import-from-realestatetool.js'), [
    '--csv',
    path.join(ROOT, 'tests', 'fixtures', 'sample-properties.json'),
    '--limit',
    '10'
  ]);
  assert.equal(importRun.status, 0, importRun.stderr || importRun.stdout);

  const result = await routeClassifiedMessage(
    {
      classifications: ['seller_intel'],
      entities: [{ name: 'MAIE JT & KT DEVELOPMENT LLC', type: 'company' }],
      relationships: [],
      buyer_profile: null,
      seller_profile: {
        entity_name: 'MAIE JT & KT DEVELOPMENT LLC',
        minimum_acceptable: 10000000,
        distress_level: 4
      },
      property_ref: { apn: '6027-013-013' },
      action_items: [],
      summary: 'Seller note'
    },
    'Owner of APN 6027-013-013 is desperate, take 10M',
    { source: 'api' }
  );

  const sellerProfileCount = await query('SELECT COUNT(*)::int AS count FROM seller_profiles');
  const knowledgeEntry = await getKnowledgeEntry(result.knowledge_entry_id);

  assert.equal(sellerProfileCount.rows[0].count, 1);
  assert.equal(knowledgeEntry.linked_properties.length, 1);
});

test('routeClassifiedMessage skips unknown property gracefully and still stores knowledge', async () => {
  await resetTables();

  const result = await routeClassifiedMessage(
    {
      classifications: ['seller_intel'],
      entities: [{ name: 'Mystery Owner LLC', type: 'company' }],
      relationships: [],
      buyer_profile: null,
      seller_profile: {
        entity_name: 'Mystery Owner LLC',
        distress_level: 3
      },
      property_ref: { address: '999 Unknown Rd' },
      action_items: [],
      summary: 'Unknown property seller note'
    },
    'Mystery Owner LLC may sell 999 Unknown Rd',
    { source: 'api' }
  );

  const sellerProfileCount = await query('SELECT COUNT(*)::int AS count FROM seller_profiles');
  const knowledgeEntry = await getKnowledgeEntry(result.knowledge_entry_id);

  assert.equal(sellerProfileCount.rows[0].count, 0);
  assert.equal(knowledgeEntry.summary, 'Unknown property seller note');
});
