const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getObsidianBaseUrl,
  normalizeVaultPath,
  buildVaultApiPath
} = require('../../src/integrations/obsidian');

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

test('getObsidianBaseUrl defaults to the local REST API endpoint', () => {
  const snapshot = {
    OBSIDIAN_API_URL: process.env.OBSIDIAN_API_URL
  };

  delete process.env.OBSIDIAN_API_URL;
  assert.equal(getObsidianBaseUrl(), 'https://127.0.0.1:27124');

  restoreEnv(snapshot);
});

test('normalizeVaultPath removes leading slashes and duplicate separators', () => {
  assert.equal(
    normalizeVaultPath('///status//daily\\2026-04-10.md'),
    'status/daily/2026-04-10.md'
  );
});

test('buildVaultApiPath encodes path segments without breaking folders', () => {
  assert.equal(
    buildVaultApiPath('status/daily note.md'),
    '/vault/status/daily%20note.md'
  );
});
