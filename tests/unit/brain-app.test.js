const test = require('node:test');
const assert = require('node:assert/strict');

const classifier = require('../../src/ingestion/classifier');
const ingestionRouter = require('../../src/ingestion/router');
const knowledgeSearch = require('../../src/knowledge/search');
const matchingRunner = require('../../src/matching/runner');
const brainApp = require('../../src/app/brain');

test('ingestMessage classifies and routes through shared app service', async (t) => {
  const originalClassify = classifier.classifyMessage;
  const originalRoute = ingestionRouter.routeClassifiedMessage;

  t.after(() => {
    classifier.classifyMessage = originalClassify;
    ingestionRouter.routeClassifiedMessage = originalRoute;
  });

  classifier.classifyMessage = async (message) => ({
    classifications: ['buyer_intel'],
    summary: `classified:${message}`
  });
  ingestionRouter.routeClassifiedMessage = async (classified, message, options) => ({
    classified,
    message,
    source: options.source
  });

  const result = await brainApp.ingestMessage({
    message: 'Mike Chen wants Carson industrial',
    source: 'unit_test'
  });

  assert.deepEqual(result, {
    classified: {
      classifications: ['buyer_intel'],
      summary: 'classified:Mike Chen wants Carson industrial'
    },
    message: 'Mike Chen wants Carson industrial',
    source: 'unit_test'
  });
});

test('searchBrain preserves result payload shape', async (t) => {
  const originalHybridSearch = knowledgeSearch.hybridSearch;

  t.after(() => {
    knowledgeSearch.hybridSearch = originalHybridSearch;
  });

  knowledgeSearch.hybridSearch = async () => [
    {
      knowledge_entry: {
        id: 'ke-1',
        title: 'Mike Chen'
      },
      relevance_score: 0.92
    }
  ];

  const result = await brainApp.searchBrain({
    query: 'Mike Chen',
    limit: 5
  });

  assert.equal(result.total, 1);
  assert.equal(result.results[0].knowledge_entry.id, 'ke-1');
});

test('matchIdentifier returns broker-facing match payload', async (t) => {
  const originalLookupIdentifier = matchingRunner.lookupIdentifier;
  const originalRunMatchingForBuyer = matchingRunner.runMatchingForBuyer;

  t.after(() => {
    matchingRunner.lookupIdentifier = originalLookupIdentifier;
    matchingRunner.runMatchingForBuyer = originalRunMatchingForBuyer;
  });

  matchingRunner.lookupIdentifier = async () => ({
    kind: 'buyer',
    entity_id: 'entity-1'
  });
  matchingRunner.runMatchingForBuyer = async () => [
    { score: 88, property: { address: '8122 MAIE AVE' }, buyer: { entity_name: 'Mike Chen' } },
    { score: 74, property: { address: '5414 E FLORAL AVE' }, buyer: { entity_name: 'Mike Chen' } }
  ];

  const result = await brainApp.matchIdentifier({
    identifier: 'Mike Chen',
    limit: 1,
    dryRun: true
  });

  assert.equal(result.kind, 'buyer');
  assert.equal(result.total, 2);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].property.address, '8122 MAIE AVE');
});

test('lookupLocalEntityForRealNex accepts direct input without entity lookup', async () => {
  const result = await brainApp.lookupLocalEntityForRealNex({
    name: 'Mike Chen',
    email: 'mike@example.com',
    company: 'Pacific Industrial'
  });

  assert.equal(result.entity, null);
  assert.deepEqual(result.disambiguation_input, {
    name: 'Mike Chen',
    email: 'mike@example.com',
    phone: null,
    company: 'Pacific Industrial'
  });
});
