const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createChannelService,
  normalizeOmiPayload,
  normalizeHermesPayload
} = require('../../src/app/channels');

test('normalizeOmiPayload extracts common string payload shapes', () => {
  const payload = {
    event_type: 'memo.created',
    message: {
      id: 'msg-omi-1',
      text: '  Mike Chen called about Carson industrial space.  '
    },
    source: 'omi-recorder',
    actor: {
      name: 'Omi Device 12',
      device_id: 'omi-12'
    },
    tags: ['call', 'broker', ''],
    timestamp: '2026-04-10T18:30:00-07:00'
  };

  const normalized = normalizeOmiPayload(payload);

  assert.equal(normalized.channel, 'omi');
  assert.equal(normalized.provider, 'omi');
  assert.equal(normalized.source, 'omi-recorder');
  assert.equal(normalized.event_type, 'memo.created');
  assert.equal(normalized.message, 'Mike Chen called about Carson industrial space.');
  assert.equal(normalized.message_id, 'msg-omi-1');
  assert.equal(normalized.occurred_at, '2026-04-11T01:30:00.000Z');
  assert.deepEqual(normalized.tags, ['call', 'broker']);
  assert.deepEqual(normalized.actor, {
    name: 'Omi Device 12'
  });
});

test('normalizeHermesPayload falls back across nested shapes', () => {
  const payload = {
    kind: 'webhook',
    data: {
      transcript: 'New notice of default for 5414 E Floral Ave.',
      conversationId: 'conv-77'
    },
    from: {
      name: 'Hermes Relay',
      email: 'relay@example.com'
    },
    labels: ['priority']
  };

  const normalized = normalizeHermesPayload(payload, { source: 'hermes-relay' });

  assert.equal(normalized.channel, 'hermes');
  assert.equal(normalized.provider, 'hermes');
  assert.equal(normalized.source, 'hermes-relay');
  assert.equal(normalized.event_type, 'webhook');
  assert.equal(normalized.message, 'New notice of default for 5414 E Floral Ave.');
  assert.equal(normalized.conversation_id, 'conv-77');
  assert.deepEqual(normalized.tags, ['priority']);
  assert.deepEqual(normalized.actor, {
    name: 'Hermes Relay',
    email: 'relay@example.com'
  });
});

test('createChannelService calls a pluggable ingest function with normalized metadata', async () => {
  const calls = [];
  const service = createChannelService({
    ingestFn: async (ingestable, normalized, options) => {
      calls.push({ ingestable, normalized, options });
      return {
        status: 'ok',
        source: ingestable.source
      };
    }
  });

  const result = await service.ingestOmiPayload(
    {
      text: 'Mike Chen wants 30k sqft industrial in Carson.',
      source: 'omi-device'
    },
    {
      source: 'custom-source',
      ingestFn: async (ingestable) => ({
        echoed: ingestable.message
      })
    }
  );

  assert.equal(calls.length, 0);
  assert.equal(result.channel, 'omi');
  assert.equal(result.source, 'custom-source');
  assert.equal(result.message, 'Mike Chen wants 30k sqft industrial in Carson.');
  assert.deepEqual(result.ingest_result, {
    echoed: 'Mike Chen wants 30k sqft industrial in Carson.'
  });
});

test('createChannelService uses the factory ingestFn when no override is provided', async () => {
  const calls = [];
  const service = createChannelService({
    ingestFn: async (ingestable, normalized, options) => {
      calls.push({ ingestable, normalized, options });
      return {
        accepted: true
      };
    }
  });

  const result = await service.ingestHermesPayload({
    body: {
      text: 'Looking for a seller update on 8122 Maie Ave.'
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(result.channel, 'hermes');
  assert.equal(result.message, 'Looking for a seller update on 8122 Maie Ave.');
  assert.deepEqual(calls[0].ingestable, {
    message: 'Looking for a seller update on 8122 Maie Ave.',
    source: 'hermes',
    metadata: calls[0].ingestable.metadata,
    raw: {
      body: {
        text: 'Looking for a seller update on 8122 Maie Ave.'
      }
    },
    channel: 'hermes'
  });
  assert.equal(calls[0].normalized.channel, 'hermes');
  assert.equal(calls[0].options.source, undefined);
  assert.deepEqual(result.ingest_result, { accepted: true });
});
