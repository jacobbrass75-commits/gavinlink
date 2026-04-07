const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const { query, close } = require('../../src/db/connection');
const provider = require('../../src/inference/provider');
const { createApp } = require('../../src/api/server');
const { resetEmbeddingsCollection } = require('../../src/knowledge/embeddings');
const { TOOLS } = require('../../src/mcp/tools');
const { createMCPServer } = require('../../src/mcp/server');

const ROOT = path.join(__dirname, '..', '..');

function runNodeScript(scriptPath, args = [], env = process.env) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env
  });
}

function runNodeScriptAsync(scriptPath, args = [], env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function resetTables() {
  await query(`
    TRUNCATE
      buyer_purchases,
      property_documents,
      property_import_records,
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

async function requestJson(app, method, routePath, body = undefined, headers = {}) {
  const server = http.createServer(app);

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}${routePath}`, {
      method,
      headers,
      body
    });

    return {
      status: response.status,
      body: await response.json(),
      port
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function classificationForMessage(message) {
  if (message.includes('Long Beach')) {
    return {
      classifications: ['buyer_intel'],
      entities: [{ name: 'Mike Chen', type: 'person' }],
      relationships: [],
      buyer_profile: {
        entity_name: 'Mike Chen',
        target_cities: ['Long Beach'],
        sensibilities: 'Very direct'
      },
      seller_profile: null,
      property_ref: null,
      action_items: ['Send Mike Long Beach options'],
      summary: 'Buyer follow-up for Mike Chen'
    };
  }

  return {
    classifications: ['buyer_intel', 'relationship'],
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
      max_price: 4000000,
      financing_preference: 'sba'
    },
    seller_profile: null,
    property_ref: null,
    action_items: ['Run matching for Mike Chen'],
    summary: 'New buyer contact: Mike Chen'
  };
}

function deterministicEmbedding(text) {
  if (/carson|industrial/i.test(text)) {
    return [1, 0, 0];
  }

  if (/seller|distress/i.test(text)) {
    return [0, 1, 0];
  }

  return [0, 0, 1];
}

test('Module 5 ingestion flow works end to end, including CLI and audio ingestion', async (t) => {
  t.after(async () => {
    await close();
  });

  const originalComplete = provider.complete;
  const originalEmbed = provider.embed;
  const originalFetch = global.fetch;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;

  t.after(() => {
    provider.complete = originalComplete;
    provider.embed = originalEmbed;
    global.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalOpenAiKey;
  });

  const migrateRun = runNodeScript(path.join(ROOT, 'scripts', 'migrate.js'));
  assert.equal(migrateRun.status, 0, migrateRun.stderr || migrateRun.stdout);

  await resetTables();

  provider.complete = async (prompt) =>
    JSON.stringify(classificationForMessage(prompt.split('Broker message:\n')[1] || prompt));
  provider.embed = async (text) => deterministicEmbedding(text);
  process.env.OPENAI_API_KEY = 'test-openai-key';

  global.fetch = async (input, init = {}) => {
    const url = String(input);

    if (url === 'https://api.openai.com/v1/audio/transcriptions') {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            text: 'Mike Chen wants industrial in Carson, budget 4M, SBA.',
            duration: 12,
            language: 'en'
          };
        }
      };
    }

    return originalFetch(input, init);
  };

  const app = createApp();

  const firstResponse = await requestJson(
    app,
    'POST',
    '/api/ingest',
    JSON.stringify({
      message:
        'Just talked to Mike Chen at Pacific Industrial Group. Wants industrial in Carson, budget 4M, SBA.',
      source: 'api'
    }),
    { 'content-type': 'application/json' }
  );

  assert.equal(firstResponse.status, 200);
  assert.equal(firstResponse.body.ok, true);
  const knowledgeEntryId = firstResponse.body.knowledge_entry_id;

  const secondResponse = await requestJson(
    app,
    'POST',
    '/api/ingest',
    JSON.stringify({
      message: 'Mike Chen also wants Long Beach and is very direct.',
      source: 'api'
    }),
    { 'content-type': 'application/json' }
  );

  assert.equal(secondResponse.status, 200);

  const mikeEntityResult = await query(
    `
      SELECT id
      FROM entities
      WHERE normalized_name = 'MIKE CHEN'
      LIMIT 1
    `
  );
  const mikeId = mikeEntityResult.rows[0].id;

  const buyersResponse = await requestJson(app, 'GET', '/api/buyers');
  assert.equal(buyersResponse.status, 200);
  assert.equal(buyersResponse.body.total, 1);
  assert.deepEqual(buyersResponse.body.profiles[0].target_cities, ['Carson', 'Long Beach']);

  const knowledgeResponse = await requestJson(app, 'GET', `/api/knowledge/${knowledgeEntryId}`);
  assert.equal(knowledgeResponse.status, 200);
  assert.equal(knowledgeResponse.body.linked_entities.length >= 1, true);

  const knowledgeListResponse = await requestJson(app, 'GET', '/api/knowledge?limit=10');
  assert.equal(knowledgeListResponse.status, 200);
  assert.ok(Array.isArray(knowledgeListResponse.body.results));
  assert.equal(knowledgeListResponse.body.total, 2);
  assert.equal(knowledgeListResponse.body.results.length, 2);

  const lookupResponse = await requestJson(
    app,
    'GET',
    `/api/entities/lookup?name=${encodeURIComponent('Mike Chen')}`
  );
  assert.equal(lookupResponse.status, 200);
  assert.equal(lookupResponse.body.kind, 'entity');

  const audioTempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'brain-audio-'));
  const audioPath = path.join(audioTempDir, 'note.mp3');
  await fs.promises.writeFile(audioPath, 'fake audio');
  const audioFile = new File([await fs.promises.readFile(audioPath)], 'note.mp3');
  const form = new FormData();
  form.append('audio', audioFile);
  form.append('source', 'voice_memo');
  const audioResponse = await requestJson(app, 'POST', '/api/ingest/audio', form);
  assert.equal(audioResponse.status, 200);
  assert.equal(audioResponse.body.transcription.text.includes('Mike Chen'), true);

  const blockedPathResponse = await requestJson(
    app,
    'POST',
    '/api/ingest/audio',
    JSON.stringify({
      file_path: '/etc/passwd',
      source: 'voice_memo'
    }),
    { 'content-type': 'application/json' }
  );
  assert.equal(blockedPathResponse.status, 400);
  assert.deepEqual(blockedPathResponse.body, { error: 'audio file upload is required' });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const env = {
      ...process.env,
      BRAIN_API_URL: `http://127.0.0.1:${port}`
    };
    const cliAdd = await runNodeScriptAsync(path.join(ROOT, 'src', 'cli', 'brain.js'), [
      'add',
      'Mike Chen wants Carson industrial again'
    ], env);
    assert.equal(cliAdd.code, 0, cliAdd.stderr || cliAdd.stdout);

    const cliSearch = await runNodeScriptAsync(path.join(ROOT, 'src', 'cli', 'brain.js'), [
      'search',
      'Carson industrial'
    ], env);
    assert.equal(cliSearch.code, 0, cliSearch.stderr || cliSearch.stdout);
    assert.match(cliSearch.stdout, /knowledge_entry|results/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const { server: mcpServer } = await createMCPServer();
  assert.ok(mcpServer);
  assert.deepEqual(
    TOOLS.map((tool) => tool.name),
    ['brain_add', 'brain_search', 'brain_lookup', 'brain_match', 'brain_daily']
  );
  assert.ok(mikeId);
});
