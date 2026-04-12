const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawnSync } = require('child_process');
const { query, close } = require('../../src/db/connection');
const { createApp } = require('../../src/api/server');
const { parseFile } = require('../../src/import-export/gateway');

const ROOT = path.join(__dirname, '..', '..');
const CORE_TABLES = [
  'entities',
  'entity_relationships',
  'properties',
  'buyer_profiles',
  'seller_profiles',
  'knowledge_entries',
  'matches',
  'deals'
];

function isPortOpen(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    function finish(value) {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(value);
      }
    }

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
    socket.connect(port, host);
  });
}

function runNodeScript(scriptPath) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: ROOT,
    encoding: 'utf8'
  });
}

async function requestJson(app, method, routePath) {
  const server = http.createServer(app);

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}${routePath}`, { method });
    const body = await response.json();
    return {
      status: response.status,
      body
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('Core runtime integration', async (t) => {
  t.after(async () => {
    await close();
  });

  await t.test('Docker service ports are reachable', async () => {
    const postgresHost = process.env.POSTGRES_HOST || 'localhost';
    const postgresPort = Number(process.env.POSTGRES_PORT || 5433);
    const chromaHost = process.env.CHROMA_HOST || 'localhost';
    const chromaPort = Number(process.env.CHROMA_PORT || 8000);

    assert.equal(await isPortOpen(postgresHost, postgresPort), true);
    assert.equal(await isPortOpen(chromaHost, chromaPort), true);
  });

  await t.test('Migrations run cleanly and are idempotent', async () => {
    const firstRun = runNodeScript(path.join(ROOT, 'scripts', 'admin', 'migrate.js'));
    assert.equal(firstRun.status, 0, firstRun.stderr || firstRun.stdout);

    const secondRun = runNodeScript(path.join(ROOT, 'scripts', 'admin', 'migrate.js'));
    assert.equal(secondRun.status, 0, secondRun.stderr || secondRun.stdout);

    const tablesResult = await query(
      `
        SELECT COUNT(*)::int AS count
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
      `,
      [CORE_TABLES]
    );
    const migrationsTableResult = await query(
      `
        SELECT COUNT(*)::int AS count
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = '_migrations'
      `
    );
    const extensionResult = await query(
      `
        SELECT extname
        FROM pg_extension
        WHERE extname = 'pg_trgm'
      `
    );

    assert.equal(tablesResult.rows[0].count, 8);
    assert.equal(migrationsTableResult.rows[0].count, 1);
    assert.equal(extensionResult.rows.length, 1);
  });

  await t.test('Seed data inserts and stays idempotent', async () => {
    const firstRun = runNodeScript(path.join(ROOT, 'scripts', 'admin', 'seed-test-data.js'));
    assert.equal(firstRun.status, 0, firstRun.stderr || firstRun.stdout);

    const secondRun = runNodeScript(path.join(ROOT, 'scripts', 'admin', 'seed-test-data.js'));
    assert.equal(secondRun.status, 0, secondRun.stderr || secondRun.stdout);

    const propertyCountResult = await query('SELECT COUNT(*)::int AS count FROM properties');
    const entityCountResult = await query('SELECT COUNT(*)::int AS count FROM entities');
    const buyerProfileCountResult = await query('SELECT COUNT(*)::int AS count FROM buyer_profiles');

    assert.equal(propertyCountResult.rows[0].count, 10);
    assert.ok(entityCountResult.rows[0].count >= 10);
    assert.equal(buyerProfileCountResult.rows[0].count, 2);
  });

  await t.test('Health endpoint reports dependency status and metadata', async () => {
    const response = await requestJson(createApp(), 'GET', '/health');

    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'ok');
    assert.equal(response.body.database, 'connected');
    assert.equal(response.body.tables, 8);
    assert.equal(response.body.chromadb, 'connected');
    assert.equal(
      response.body.inference_provider,
      String(process.env.INFERENCE_PROVIDER || 'claude').trim().toLowerCase()
    );
    assert.equal(response.body.version, '0.1.0');
    assert.ok(response.body.tables_total >= response.body.tables);
    assert.equal(response.body.core_tables_expected, 8);
  });

  await t.test('Legacy /brain routes are explicit compatibility or deprecation surfaces', async () => {
    const app = createApp();
    const entityResponse = await requestJson(app, 'GET', '/brain/entity/123');
    const importResponse = await requestJson(app, 'POST', '/brain/import');
    const exportResponse = await requestJson(app, 'GET', '/brain/export');

    assert.equal(entityResponse.status, 400);
    assert.deepEqual(entityResponse.body, {
      error: 'id must be a valid UUID'
    });

    assert.equal(importResponse.status, 410);
    assert.deepEqual(importResponse.body, {
      error: 'Legacy /brain/import is deprecated. Use /api/import/foreclosure or the CLI import commands.'
    });

    assert.equal(exportResponse.status, 410);
    assert.deepEqual(exportResponse.body, {
      error: 'Legacy /brain/export is deprecated. Use the CLI or direct /api resources instead.'
    });
  });

  await t.test('Import/export gateway parses CSV and JSON fixtures', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'isg-brain-'));
    const csvPath = path.join(tempDir, 'sample.csv');
    const jsonPath = path.join(ROOT, 'tests', 'fixtures', 'sample-properties.json');

    await fs.promises.writeFile(csvPath, 'apn,address\n6027-013-013,8122 MAIE AVE\n');

    const csvResult = await parseFile(csvPath);
    const jsonResult = await parseFile(jsonPath);

    assert.deepEqual(csvResult.columns, ['apn', 'address']);
    assert.equal(csvResult.format, 'csv');
    assert.equal(csvResult.rows.length, 1);

    assert.equal(jsonResult.format, 'json');
    assert.equal(jsonResult.rows.length, 10);
    assert.ok(jsonResult.columns.includes('apn'));

    await assert.rejects(
      () => parseFile(path.join(tempDir, 'missing.csv')),
      /File not found:/
    );
  });
});
