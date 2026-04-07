const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { query, close } = require('../../src/db/connection');
const { createApp } = require('../../src/api/server');
const { normalizeName } = require('../../src/entities/extract');

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
      property_documents,
      property_import_records,
      wiki_promotion_queue,
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
}

async function requestJson(app, method, routePath) {
  const server = http.createServer(app);

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}${routePath}`, { method });
    return {
      status: response.status,
      body: await response.json()
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('Module 2 import pipeline works end to end with fixture data', async (t) => {
  t.after(async () => {
    await close();
  });

  const migrateRun = runNodeScript(path.join(ROOT, 'scripts', 'migrate.js'));
  assert.equal(migrateRun.status, 0, migrateRun.stderr || migrateRun.stdout);

  await resetTables();

  const importArgs = [
    '--csv',
    path.join(ROOT, 'tests', 'fixtures', 'sample-properties.json'),
    '--limit',
    '10'
  ];
  const firstImport = runNodeScript(path.join(ROOT, 'scripts', 'import-from-realestatetool.js'), importArgs);
  assert.equal(firstImport.status, 0, firstImport.stderr || firstImport.stdout);

  const propertyCountResult = await query('SELECT COUNT(*)::int AS count FROM properties');
  const entityCountResult = await query('SELECT COUNT(*)::int AS count FROM entities');
  const linkedCountResult = await query(
    `
      SELECT
        COUNT(*) FILTER (WHERE owner_entity_id IS NOT NULL)::int AS owner_links,
        COUNT(*) FILTER (WHERE trustee_entity_id IS NOT NULL)::int AS trustee_links
      FROM properties
    `
  );

  assert.equal(propertyCountResult.rows[0].count, 10);
  assert.ok(entityCountResult.rows[0].count > 0);
  assert.equal(linkedCountResult.rows[0].owner_links, 10);
  assert.equal(linkedCountResult.rows[0].trustee_links, 10);

  const countsBeforeSecondImport = {
    properties: propertyCountResult.rows[0].count,
    entities: entityCountResult.rows[0].count
  };
  const secondImport = runNodeScript(path.join(ROOT, 'scripts', 'import-from-realestatetool.js'), importArgs);
  assert.equal(secondImport.status, 0, secondImport.stderr || secondImport.stdout);

  const propertyCountAfterSecondImport = await query('SELECT COUNT(*)::int AS count FROM properties');
  const entityCountAfterSecondImport = await query('SELECT COUNT(*)::int AS count FROM entities');

  assert.equal(propertyCountAfterSecondImport.rows[0].count, countsBeforeSecondImport.properties);
  assert.equal(entityCountAfterSecondImport.rows[0].count, countsBeforeSecondImport.entities);

  const app = createApp();
  const listResponse = await requestJson(app, 'GET', '/api/entities');

  assert.equal(listResponse.status, 200);
  assert.ok(Array.isArray(listResponse.body.results));
  assert.ok(listResponse.body.results.length > 0);

  const searchResponse = await requestJson(app, 'GET', '/api/entities/search?q=MAIE');

  assert.equal(searchResponse.status, 200);
  assert.ok(
    searchResponse.body.results.some((entity) => entity.name === 'MAIE JT & KT DEVELOPMENT LLC')
  );

  const literalWildcardSearchResponse = await requestJson(app, 'GET', '/api/entities/search?q=%');
  assert.equal(literalWildcardSearchResponse.status, 200);
  assert.equal(literalWildcardSearchResponse.body.total, 0);

  const maieEntityResult = await query(
    `
      SELECT id
      FROM entities
      WHERE normalized_name = $1
      LIMIT 1
    `,
    [normalizeName('MAIE JT & KT DEVELOPMENT LLC')]
  );
  const maieId = maieEntityResult.rows[0].id;
  const detailResponse = await requestJson(app, 'GET', `/api/entities/${maieId}`);
  const portfolioResponse = await requestJson(app, 'GET', `/api/entities/${maieId}/portfolio`);

  assert.equal(detailResponse.status, 200);
  assert.equal(detailResponse.body.entity.id, maieId);
  assert.ok(Array.isArray(detailResponse.body.properties));

  assert.equal(portfolioResponse.status, 200);
  assert.equal(portfolioResponse.body.entity.id, maieId);
  assert.ok(portfolioResponse.body.properties.length >= 1);
});
