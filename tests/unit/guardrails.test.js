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

test('requireAdminApiKey allows dev writes with no key configured', async (t) => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAdminKey = process.env.ADMIN_API_KEY;
  const originalAllow = process.env.ALLOW_UNAUTHENTICATED_WRITE;

  t.after(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.ADMIN_API_KEY = originalAdminKey;
    process.env.ALLOW_UNAUTHENTICATED_WRITE = originalAllow;
  });

  process.env.NODE_ENV = 'development';
  delete process.env.ADMIN_API_KEY;
  delete process.env.ALLOW_UNAUTHENTICATED_WRITE;

  let nextCalled = false;
  const req = { get: () => null };
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

test('requireAdminApiKey fails closed in production when no key is configured', async (t) => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAdminKey = process.env.ADMIN_API_KEY;
  const originalAllow = process.env.ALLOW_UNAUTHENTICATED_WRITE;

  t.after(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.ADMIN_API_KEY = originalAdminKey;
    process.env.ALLOW_UNAUTHENTICATED_WRITE = originalAllow;
  });

  process.env.NODE_ENV = 'production';
  delete process.env.ADMIN_API_KEY;
  delete process.env.ALLOW_UNAUTHENTICATED_WRITE;

  const req = { get: () => null };
  const res = createResponse();

  guardrails.requireAdminApiKey(req, res, () => {
    throw new Error('next should not be called');
  });

  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.payload, {
    error: 'ADMIN_API_KEY must be configured for write routes in production'
  });
});
