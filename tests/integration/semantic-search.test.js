const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { query, close } = require('../../src/db/connection');
const provider = require('../../src/inference/provider');
const { routeClassifiedMessage } = require('../../src/ingestion/router');
const { hybridSearch } = require('../../src/knowledge/search');
const { resetEmbeddingsCollection } = require('../../src/knowledge/embeddings');

const ROOT = path.join(__dirname, '..', '..');

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
  await resetEmbeddingsCollection();
}

function classification(summary, entityName, classificationType) {
  return {
    classifications: [classificationType],
    entities: entityName ? [{ name: entityName, type: 'person' }] : [],
    relationships: [],
    buyer_profile:
      classificationType === 'buyer_intel'
        ? {
            entity_name: entityName,
            target_property_types: ['industrial']
          }
        : null,
    seller_profile: null,
    property_ref: null,
    action_items: [],
    summary
  };
}

function embeddingFor(text) {
  if (/industrial|carson|warehouse/i.test(text)) {
    return [1, 0, 0];
  }

  if (/seller|distress|foreclosure/i.test(text)) {
    return [0, 1, 0];
  }

  return [0, 0, 1];
}

test('semantic and hybrid search return relevant filtered results', async (t) => {
  t.after(async () => {
    await close();
  });

  const originalEmbed = provider.embed;

  t.after(() => {
    provider.embed = originalEmbed;
  });

  const migrateRun = runNodeScript(path.join(ROOT, 'scripts', 'migrate.js'));
  assert.equal(migrateRun.status, 0, migrateRun.stderr || migrateRun.stdout);

  await resetTables();
  provider.embed = async (text) => embeddingFor(text);

  await routeClassifiedMessage(
    classification('Mike Chen wants industrial in Long Beach', 'Mike Chen', 'buyer_intel'),
    'Mike Chen wants industrial in Long Beach',
    { source: 'api' }
  );
  await routeClassifiedMessage(
    classification('Sarah Park is tracking seller distress in Carson', 'Sarah Park', 'seller_intel'),
    'Sarah Park is tracking seller distress in Carson',
    { source: 'api' }
  );
  await routeClassifiedMessage(
    classification('General market note about office demand', null, 'market_insight'),
    'General market note about office demand',
    { source: 'api' }
  );

  const basicResults = await hybridSearch('who wanted industrial in Long Beach', { limit: 5 });
  assert.ok(basicResults.length >= 1);
  assert.match(basicResults[0].knowledge_entry.content, /industrial in Long Beach/i);

  const mikeEntityResult = await query(
    `
      SELECT id
      FROM entities
      WHERE normalized_name = 'MIKE CHEN'
      LIMIT 1
    `
  );
  const mikeId = mikeEntityResult.rows[0].id;

  const entityFilteredResults = await hybridSearch('industrial', {
    entity_ids: [mikeId],
    limit: 5
  });
  assert.ok(entityFilteredResults.every((result) =>
    result.linked_entities.some((entity) => entity.id === mikeId)
  ));

  const classificationFilteredResults = await hybridSearch('industrial', {
    entry_types: ['buyer_intel'],
    limit: 5
  });
  assert.ok(classificationFilteredResults.every((result) =>
    result.knowledge_entry.content.toLowerCase().includes('industrial')
  ));

  const emptyResults = await hybridSearch('nothing about this should exist', { limit: 5 });
  assert.ok(Array.isArray(emptyResults));
});
