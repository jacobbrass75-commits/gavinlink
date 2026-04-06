const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { query, close } = require('../../src/db/connection');
const { createApp } = require('../../src/api/server');

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

async function requestJson(app, method, routePath, body = undefined) {
  const server = http.createServer(app);

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}${routePath}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });

    return {
      status: response.status,
      body: await response.json()
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('Module 3 buyer workflow works end to end', async (t) => {
  t.after(async () => {
    await close();
  });

  const migrationRun = runNodeScript(path.join(ROOT, 'scripts', 'migrate.js'));
  assert.equal(migrationRun.status, 0, migrationRun.stderr || migrationRun.stdout);

  await resetTables();

  const importRun = runNodeScript(path.join(ROOT, 'scripts', 'import-from-realestatetool.js'), [
    '--csv',
    path.join(ROOT, 'tests', 'fixtures', 'sample-properties.json'),
    '--limit',
    '10'
  ]);
  assert.equal(importRun.status, 0, importRun.stderr || importRun.stdout);

  const app = createApp();
  const createResponse = await requestJson(app, 'POST', '/api/buyers', {
    entity_name: 'Mike Chen',
    target_property_types: ['industrial'],
    target_cities: ['Carson', 'Compton'],
    max_price: 4000000,
    min_sq_feet: 25000,
    investment_strategy: 'owner_user',
    financing_preference: 'sba',
    typical_close_timeline: '90_days',
    urgency: 'actively_looking',
    sensibilities: 'Numbers-driven, direct communicator'
  });

  assert.equal(createResponse.status, 201);
  const buyerId = createResponse.body.id;
  assert.ok(buyerId);

  const getResponse = await requestJson(app, 'GET', `/api/buyers/${buyerId}`);
  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.body.entity_name, 'Mike Chen');

  const updateResponse = await requestJson(app, 'PUT', `/api/buyers/${buyerId}`, {
    target_cities: ['Long Beach'],
    sensibilities: 'Also interested in value-add plays'
  });
  assert.equal(updateResponse.status, 200);
  assert.deepEqual(updateResponse.body.target_cities, ['Carson', 'Compton', 'Long Beach']);
  assert.match(updateResponse.body.sensibilities, /Also interested in value-add plays/);

  const listResponse = await requestJson(app, 'GET', '/api/buyers?property_type=industrial&city=Carson');
  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.body.total, 1);

  const searchResponse = await requestJson(app, 'GET', '/api/buyers/search?q=Mike');
  assert.equal(searchResponse.status, 200);
  assert.equal(searchResponse.body.total, 1);

  const lenderResponse = await requestJson(app, 'GET', '/api/lenders');
  assert.equal(lenderResponse.status, 200);
  assert.ok(lenderResponse.body.total > 0);
  const lenderId = lenderResponse.body.results[0].entity_id;

  const lenderDetailResponse = await requestJson(app, 'GET', `/api/lenders/${lenderId}`);
  assert.equal(lenderDetailResponse.status, 200);
  assert.ok(Array.isArray(lenderDetailResponse.body.properties));

  const overlapsResponse = await requestJson(app, 'GET', '/api/lenders/overlaps');
  assert.equal(overlapsResponse.status, 200);

  const propertyResult = await query('SELECT id FROM properties ORDER BY apn LIMIT 1');
  const purchaseResponse = await requestJson(app, 'POST', `/api/buyers/${buyerId}/purchases`, {
    property_id: propertyResult.rows[0].id,
    purchase_price: 3250000,
    purchase_date: '2026-04-03',
    deal_type: 'purchase',
    notes: 'Closed off-market'
  });
  assert.equal(purchaseResponse.status, 201);

  const purchasesResponse = await requestJson(app, 'GET', `/api/buyers/${buyerId}/purchases`);
  assert.equal(purchasesResponse.status, 200);
  assert.equal(purchasesResponse.body.total, 1);

  const statsResponse = await requestJson(app, 'GET', `/api/buyers/${buyerId}/stats`);
  assert.equal(statsResponse.status, 200);
  assert.equal(statsResponse.body.total_purchases, 1);
  assert.equal(statsResponse.body.total_volume, 3250000);

  const deactivateResponse = await requestJson(app, 'DELETE', `/api/buyers/${buyerId}`);
  assert.equal(deactivateResponse.status, 200);
  assert.equal(deactivateResponse.body.active, false);

  const afterDeactivateList = await requestJson(app, 'GET', '/api/buyers');
  assert.equal(afterDeactivateList.status, 200);
  assert.equal(afterDeactivateList.body.total, 0);
});
