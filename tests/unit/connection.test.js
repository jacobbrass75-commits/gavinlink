const test = require('node:test');
const assert = require('node:assert/strict');
const { getPool, query, close } = require('../../src/db/connection');

test.after(async () => {
  await close();
});

test('getPool returns a singleton instance', async () => {
  const firstPool = getPool();
  const secondPool = getPool();

  assert.equal(firstPool, secondPool);
});

test('query executes a simple SQL statement', async () => {
  const result = await query('SELECT 1 AS value');

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].value, 1);
});

test('close tears down the current pool and allows recreation', async () => {
  const firstPool = getPool();
  await close();

  const secondPool = getPool();

  assert.notEqual(firstPool, secondPool);
});

test('pool configuration follows environment variables before initialization', async () => {
  await close();

  const originalHost = process.env.POSTGRES_HOST;
  const originalPort = process.env.POSTGRES_PORT;

  process.env.POSTGRES_HOST = '127.0.0.1';
  process.env.POSTGRES_PORT = '5432';

  const pool = getPool();

  assert.equal(pool.options.host, '127.0.0.1');
  assert.equal(pool.options.port, 5432);

  await close();

  if (originalHost === undefined) {
    delete process.env.POSTGRES_HOST;
  } else {
    process.env.POSTGRES_HOST = originalHost;
  }

  if (originalPort === undefined) {
    delete process.env.POSTGRES_PORT;
  } else {
    process.env.POSTGRES_PORT = originalPort;
  }
});
