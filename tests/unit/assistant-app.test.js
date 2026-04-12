const test = require('node:test');
const assert = require('node:assert/strict');

const assistantApp = require('../../src/app/assistant');
const brainApp = require('../../src/app/brain');
const runtimeApp = require('../../src/app/runtime');

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
