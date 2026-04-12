const test = require('node:test');
const assert = require('node:assert/strict');

const guardrails = require('../../src/api/guardrails');

function createResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.payload = body;
      return this;
    }
  };
}

test('requireAdminApiKey fails closed when no key is configured', async (t) => {
  const originalAdminKey = process.env.ADMIN_API_KEY;

  t.after(() => {
    process.env.ADMIN_API_KEY = originalAdminKey;
  });

  delete process.env.ADMIN_API_KEY;

  const req = { get: () => null };
  const res = createResponse();

  guardrails.requireAdminApiKey(req, res, () => {
    throw new Error('next should not be called');
  });

  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.payload, {
    error: 'ADMIN_API_KEY must be configured for protected routes'
  });
});

test('requireAdminApiKey accepts a valid x-api-key when configured', async (t) => {
  const originalAdminKey = process.env.ADMIN_API_KEY;

  t.after(() => {
    process.env.ADMIN_API_KEY = originalAdminKey;
  });

  process.env.ADMIN_API_KEY = 'top-secret';

  let nextCalled = false;
  const req = {
    get(name) {
      return name === 'x-api-key' ? 'top-secret' : null;
    }
  };
  const res = createResponse();

  guardrails.requireAdminApiKey(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.payload, null);
});

test('requireAdminApiKey rejects invalid x-api-key when configured', async (t) => {
  const originalAdminKey = process.env.ADMIN_API_KEY;

  t.after(() => {
    process.env.ADMIN_API_KEY = originalAdminKey;
  });

  process.env.ADMIN_API_KEY = 'top-secret';

  const req = { get: () => 'wrong-key' };
  const res = createResponse();

  guardrails.requireAdminApiKey(req, res, () => {
    throw new Error('next should not be called');
  });

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.payload, { error: 'Valid x-api-key is required' });
});

test('requireAdminApiKey still fails closed in production when no key is configured', async (t) => {
  const originalAdminKey = process.env.ADMIN_API_KEY;

  t.after(() => {
    process.env.ADMIN_API_KEY = originalAdminKey;
  });

  delete process.env.ADMIN_API_KEY;

  const req = { get: () => null };
  const res = createResponse();

  guardrails.requireAdminApiKey(req, res, () => {
    throw new Error('next should not be called');
  });

  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.payload, {
    error: 'ADMIN_API_KEY must be configured for protected routes'
  });
});
