const test = require('node:test');
const assert = require('node:assert/strict');

const assistantApp = require('../../src/app/assistant');
const brainApp = require('../../src/app/brain');
const realNexApp = require('../../src/app/realnex');

function clearApiCache() {
  for (const modulePath of [
    '../../src/api/server',
    '../../src/api/routes/answer',
    '../../src/api/routes/channels',
    '../../src/api/routes/realnex'
  ]) {
    delete require.cache[require.resolve(modulePath)];
  }
}

async function withServer(t) {
  clearApiCache();
  const { createApp } = require('../../src/api/server');
  const app = createApp();
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, () => resolve(instance));
    instance.on('error', reject);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  return {
    baseUrl
  };
}

test('POST /api/answer uses the shared assistant service', async (t) => {
  const originalAnswerMessage = assistantApp.answerMessage;

  t.after(() => {
    assistantApp.answerMessage = originalAnswerMessage;
  });

  assistantApp.answerMessage = async (payload) => ({
    intent: 'status',
    route: 'stubbed',
    saved: false,
    reply: `ok:${payload.message}`,
    payload: {
      status: 'ok'
    }
  });

  const { baseUrl } = await withServer(t);
  const response = await fetch(`${baseUrl}/api/answer`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      message: 'yo you working bro'
    })
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.intent, 'status');
  assert.equal(payload.reply, 'ok:yo you working bro');
});

test('POST /api/channels/omi normalizes and ingests through the shared brain layer', async (t) => {
  const originalIngestChannelEvent = brainApp.ingestChannelEvent;

  t.after(() => {
    brainApp.ingestChannelEvent = originalIngestChannelEvent;
  });

  brainApp.ingestChannelEvent = async (payload) => ({
    knowledge_entry_id: 'ke-omi-1',
    echoed: payload
  });

  const { baseUrl } = await withServer(t);
  const response = await fetch(`${baseUrl}/api/channels/omi`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      source: 'omi-recorder',
      message: {
        id: 'msg-omi-1',
        text: 'Mike Chen called about Carson industrial space.'
      },
      timestamp: '2026-04-10T18:30:00-07:00'
    })
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.channel, 'omi');
  assert.equal(payload.message_id, 'msg-omi-1');
  assert.equal(payload.ingest_result.knowledge_entry_id, 'ke-omi-1');
  assert.equal(payload.ingest_result.echoed.channel, 'omi');
});

test('POST /api/channels/vermes uses the Vermes adapter path', async (t) => {
  const originalIngestChannelEvent = brainApp.ingestChannelEvent;
  const originalAnswerMessage = assistantApp.answerMessage;

  t.after(() => {
    brainApp.ingestChannelEvent = originalIngestChannelEvent;
    assistantApp.answerMessage = originalAnswerMessage;
  });

  brainApp.ingestChannelEvent = async (payload) => ({
    knowledge_entry_id: 'ke-vermes-1',
    source: payload.source
  });
  assistantApp.answerMessage = async (payload) => ({
    intent: 'search',
    route: 'channel_assistant',
    saved: false,
    reply: `handled:${payload.message}`,
    payload: {
      results: []
    }
  });

  const { baseUrl } = await withServer(t);
  const response = await fetch(`${baseUrl}/api/channels/vermes`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      event_type: 'conversation.created',
      payload: {
        text: 'Need a summary for 8122 Maie Ave.'
      }
    })
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.channel, 'vermes');
  assert.equal(payload.provider, 'vermes');
  assert.equal(payload.processor_mode, 'assistant');
  assert.equal(payload.ingest_result.intent, 'search');
  assert.equal(payload.ingest_result.reply, 'handled:Need a summary for 8122 Maie Ave.');
});

test('POST /api/realnex/disambiguate uses the shared RealNex app service', async (t) => {
  const originalDisambiguate = realNexApp.disambiguateLocalEntityAgainstRealNex;

  t.after(() => {
    realNexApp.disambiguateLocalEntityAgainstRealNex = originalDisambiguate;
  });

  realNexApp.disambiguateLocalEntityAgainstRealNex = async (input) => ({
    entity: null,
    input,
    contacts: [],
    companies: [],
    matches: [
      {
        id: 'contact-1',
        kind: 'contact',
        name: 'Shelly Garcia',
        score: 80
      }
    ],
    best_match: {
      id: 'contact-1',
      kind: 'contact',
      name: 'Shelly Garcia',
      score: 80
    }
  });

  const { baseUrl } = await withServer(t);
  const response = await fetch(`${baseUrl}/api/realnex/disambiguate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Shelly Garcia',
      email: 'sgarcia@lee-re.com',
      company: 'Lee Associates'
    })
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.best_match.id, 'contact-1');
  assert.equal(payload.input.email, 'sgarcia@lee-re.com');
});
