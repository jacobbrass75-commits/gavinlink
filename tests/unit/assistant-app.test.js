const test = require('node:test');
const assert = require('node:assert/strict');

const assistantApp = require('../../src/app/assistant');
const brainApp = require('../../src/app/brain');
const realNexApp = require('../../src/app/realnex');
const runtimeApp = require('../../src/app/runtime');
const operatorApp = require('../../src/app/operator');

test('answerMessage routes status-style plain text to runtime status', async (t) => {
  const originalGetRuntimeStatus = runtimeApp.getRuntimeStatus;

  t.after(() => {
    runtimeApp.getRuntimeStatus = originalGetRuntimeStatus;
  });

  runtimeApp.getRuntimeStatus = async () => ({
    status: 'ok',
    database: 'connected',
    chromadb: 'connected',
    inference_provider: 'claude'
  });

  const result = await assistantApp.answerMessage({
    message: 'yo you working bro',
    source: 'unit_test'
  });

  assert.equal(result.intent, 'status');
  assert.equal(result.saved, false);
  assert.match(result.reply, /Brain health: ok/);
});

test('answerMessage routes overview-style plain text to the operator surface', async (t) => {
  const originalGetOperatorOverview = operatorApp.getOperatorOverview;

  t.after(() => {
    operatorApp.getOperatorOverview = originalGetOperatorOverview;
  });

  operatorApp.getOperatorOverview = async () => ({
    runtime: {
      status: 'ok',
      database: 'connected',
      chromadb: 'connected'
    },
    backlog: {
      action_items: [{ action: 'Call Mike Chen' }],
      pending_promotions: [],
      top_matches: []
    },
    alerts: {
      last_7_days: { total: 3, matched: 2, unmatched: 1 }
    },
    workflows: {
      wiki_queue: [],
      match_pipeline: [],
      propertyradar_feed: { seen_message_count: 12 }
    }
  });

  const result = await assistantApp.answerMessage({
    message: 'give me an operator overview',
    source: 'unit_test'
  });

  assert.equal(result.intent, 'overview');
  assert.equal(result.saved, false);
  assert.match(result.reply, /Soleil operator overview/);
  assert.match(result.reply, /Alerts \(7d\): 3 total/);
});

test('answerMessage saves only explicit capture requests', async (t) => {
  const originalIngestMessage = brainApp.ingestMessage;

  t.after(() => {
    brainApp.ingestMessage = originalIngestMessage;
  });

  const calls = [];
  brainApp.ingestMessage = async (payload) => {
    calls.push(payload);
    return {
      knowledge_entry_id: 'ke-123',
      summary: 'Saved note'
    };
  };

  const result = await assistantApp.answerMessage({
    message: 'save: Mike Chen wants Carson industrial',
    source: 'unit_test'
  });

  assert.equal(result.intent, 'add');
  assert.equal(result.saved, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].message, 'Mike Chen wants Carson industrial');
  assert.equal(calls[0].source, 'unit_test');
});

test('answerMessage respects explicit do-not-save correction', async () => {
  const result = await assistantApp.answerMessage({
    message: "nah don't save",
    source: 'unit_test'
  });

  assert.equal(result.intent, 'cancel');
  assert.equal(result.saved, false);
  assert.equal(result.reply, 'Not saved.');
});

test('answerMessage routes lookup questions into lookupBrain', async (t) => {
  const originalLookupBrain = brainApp.lookupBrain;

  t.after(() => {
    brainApp.lookupBrain = originalLookupBrain;
  });

  brainApp.lookupBrain = async ({ name }) => ({
    kind: 'entity',
    entity: {
      name,
      type: 'person'
    },
    properties: [],
    relationships: []
  });

  const result = await assistantApp.answerMessage({
    message: 'who is Mike Chen',
    source: 'unit_test'
  });

  assert.equal(result.intent, 'lookup');
  assert.equal(result.argument, 'Mike Chen');
  assert.match(result.reply, /Entity: Mike Chen/);
});

test('answerMessage routes summary phrasing into lookupBrain', async (t) => {
  const originalLookupBrain = brainApp.lookupBrain;

  t.after(() => {
    brainApp.lookupBrain = originalLookupBrain;
  });

  brainApp.lookupBrain = async ({ name }) => ({
    kind: 'property',
    property: {
      address: name,
      property_type: 'industrial',
      foreclosure: true
    },
    seller_profile: null
  });

  const result = await assistantApp.answerMessage({
    message: 'need a summary for 8122 Maie Ave',
    source: 'unit_test'
  });

  assert.equal(result.intent, 'lookup');
  assert.equal(result.argument, '8122 Maie Ave');
  assert.match(result.reply, /Property: 8122 Maie Ave/);
});

test('answerMessage strips assistant wrapper prefixes before routing', async (t) => {
  const originalLookupBrain = brainApp.lookupBrain;

  t.after(() => {
    brainApp.lookupBrain = originalLookupBrain;
  });

  brainApp.lookupBrain = async ({ name }) => ({
    kind: 'property',
    property: {
      address: name,
      property_type: 'industrial',
      foreclosure: true
    },
    seller_profile: null
  });

  const result = await assistantApp.answerMessage({
    message: 'ask: need a summary for 8122 Maie Ave',
    source: 'unit_test'
  });

  assert.equal(result.intent, 'lookup');
  assert.equal(result.argument, '8122 Maie Ave');
  assert.match(result.reply, /Property: 8122 Maie Ave/);
});

test('answerMessage falls back to RealNex import on local lookup miss', async (t) => {
  const originalLookupBrain = brainApp.lookupBrain;
  const originalSyncRealNexMatch = realNexApp.syncRealNexMatch;

  t.after(() => {
    brainApp.lookupBrain = originalLookupBrain;
    realNexApp.syncRealNexMatch = originalSyncRealNexMatch;
  });

  brainApp.lookupBrain = async () => {
    const error = new Error('not found');
    error.statusCode = 404;
    throw error;
  };
  realNexApp.syncRealNexMatch = async (payload) => ({
    status: 'imported',
    knowledge_entry_id: 'ke-realnex-1',
    entity: {
      id: 'entity-1',
      name: 'Shelly Garcia'
    },
    company_entity: {
      id: 'entity-2',
      name: 'Lee Associates'
    },
    lookup_payload: {
      kind: 'entity',
      entity: {
        name: 'Shelly Garcia',
        type: 'person'
      },
      properties: [],
      relationships: []
    },
    echo: payload
  });

  const result = await assistantApp.answerMessage({
    message: 'who is Shelly Garcia from Lee Associates',
    source: 'unit_test'
  });

  assert.equal(result.intent, 'lookup');
  assert.equal(result.saved, true);
  assert.equal(result.route, 'heuristic:realnex_import');
  assert.match(result.reply, /Entity: Shelly Garcia/);
  assert.match(result.reply, /Synced from RealNex/);
  assert.match(result.reply, /Linked company: Lee Associates/);
});

test('answerMessage does not sync RealNex when saves are disabled', async (t) => {
  const originalLookupBrain = brainApp.lookupBrain;
  const originalSyncRealNexMatch = realNexApp.syncRealNexMatch;

  t.after(() => {
    brainApp.lookupBrain = originalLookupBrain;
    realNexApp.syncRealNexMatch = originalSyncRealNexMatch;
  });

  brainApp.lookupBrain = async () => {
    const error = new Error('not found');
    error.statusCode = 404;
    throw error;
  };
  realNexApp.syncRealNexMatch = async () => {
    throw new Error('should not sync when allowSave is false');
  };

  const result = await assistantApp.answerMessage({
    message: 'who is Shelly Garcia from Lee Associates',
    source: 'unit_test',
    allowSave: false
  });

  assert.equal(result.intent, 'lookup');
  assert.equal(result.saved, false);
  assert.equal(result.route, 'heuristic:not_found');
  assert.match(result.reply, /No entity or property found/);
});
