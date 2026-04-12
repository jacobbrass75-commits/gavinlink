const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { upsertEnvVar } = require('../../scripts/admin/auth-gmail-pkce');

test('upsertEnvVar appends a missing env var', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gmail-auth-env-'));
  const envPath = path.join(tempDir, '.env');

  await fs.promises.writeFile(envPath, 'API_PORT=3100\n', 'utf8');
  await upsertEnvVar(envPath, 'GMAIL_REFRESH_TOKEN', 'abc123');

  const result = await fs.promises.readFile(envPath, 'utf8');
  assert.match(result, /API_PORT=3100/);
  assert.match(result, /GMAIL_REFRESH_TOKEN=abc123/);
});

test('upsertEnvVar replaces an existing env var', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gmail-auth-env-'));
  const envPath = path.join(tempDir, '.env');

  await fs.promises.writeFile(envPath, 'GMAIL_REFRESH_TOKEN=old-token\n', 'utf8');
  await upsertEnvVar(envPath, 'GMAIL_REFRESH_TOKEN', 'new-token');

  const result = await fs.promises.readFile(envPath, 'utf8');
  assert.doesNotMatch(result, /old-token/);
  assert.match(result, /^GMAIL_REFRESH_TOKEN=new-token$/m);
});
