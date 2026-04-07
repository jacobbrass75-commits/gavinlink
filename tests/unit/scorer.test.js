const test = require('node:test');
const assert = require('node:assert/strict');
const knowledgeSearch = require('../../src/knowledge/search');
const {
  calculateMatchScore,
  scorePropertyType,
  scorePrice,
  scoreLocation,
  scoreSize,
  scoreStrategy,
  scoreTiming,
  scoreKnowledgeAlignment
} = require('../../src/matching/scorer');

const buyer = {
  id: 'buyer-1',
  entity_id: 'entity-1',
  entity_name: 'Mike Chen',
  target_property_types: ['industrial'],
  target_cities: ['Carson'],
  target_zip_codes: ['90745'],
  min_price: 2000000,
  max_price: 5000000,
  min_sq_feet: 20000,
  max_sq_feet: 50000,
  investment_strategy: 'value_add',
  urgency: 'actively_looking'
};

const seller = {
  id: 'seller-1',
  distress_level: 4,
  timeline: 'urgent',
  motivation: 'foreclosure'
};

const property = {
  id: 'property-1',
  property_type: 'industrial',
  city: 'Carson',
  zip: '90745',
  assessed_value: 4000000,
  sq_feet: 30000,
  lot_size: 25000,
  foreclosure: true
};

test('calculateMatchScore returns a very high score for a strong fit', async () => {
  const result = await calculateMatchScore(buyer, seller, property, { skipKnowledge: true });

  assert.ok(result.score >= 90);
  assert.equal(result.breakdown.property_type, 25);
  assert.equal(result.breakdown.location, 20);
});

test('property type mismatch caps a bad fit', async () => {
  const result = await calculateMatchScore(
    buyer,
    seller,
    { ...property, property_type: 'retail' },
    { skipKnowledge: true }
  );

  assert.ok(result.score <= 30);
});

test('price way over budget stays low', async () => {
  const result = await calculateMatchScore(
    { ...buyer, min_price: null, max_price: 1000000 },
    seller,
    { ...property, assessed_value: 10000000 },
    { skipKnowledge: true }
  );

  assert.ok(result.score <= 40);
});

test('scorePrice returns full credit when price is within range', () => {
  assert.equal(scorePrice(buyer, property), 25);
});

test('scorePrice returns partial credit when price is slightly over budget', () => {
  assert.equal(scorePrice({ ...buyer, min_price: null, max_price: 4000000 }, { ...property, assessed_value: 4300000 }), 15);
});

test('scoreLocation returns exact city credit', () => {
  assert.equal(scoreLocation(buyer, property), 20);
});

test('scoreLocation returns adjacent city credit', () => {
  assert.equal(scoreLocation(buyer, { ...property, city: 'Compton', zip: '90220' }), 10);
});

test('scoreStrategy rewards value-add buyers for distressed sellers', () => {
  assert.equal(scoreStrategy(buyer, seller, property), 15);
});

test('scoreStrategy returns zero for a stabilized buyer against heavy distress', () => {
  assert.equal(
    scoreStrategy({ ...buyer, investment_strategy: 'stabilized' }, { ...seller, distress_level: 5 }, property),
    0
  );
});

test('scoreTiming gives the full urgent bonus', () => {
  assert.equal(scoreTiming({ ...buyer, urgency: 'urgent' }, { ...seller, timeline: 'urgent' }), 10);
});

test('no explicit targets produce neutral scores instead of zero', async () => {
  const neutralBuyer = {
    entity_id: 'neutral',
    entity_name: 'Neutral Buyer',
    target_property_types: [],
    target_cities: [],
    target_zip_codes: [],
    min_price: null,
    max_price: null,
    min_sq_feet: null,
    max_sq_feet: null
  };
  const result = await calculateMatchScore(neutralBuyer, seller, property, { skipKnowledge: true });

  assert.equal(scorePropertyType(neutralBuyer, property), 12);
  assert.equal(scoreLocation(neutralBuyer, property), 10);
  assert.equal(scoreSize(neutralBuyer, property), 8);
  assert.ok(result.score > 0);
});

test('missing property size does not crash and returns zero for size', () => {
  assert.equal(scoreSize(buyer, { ...property, sq_feet: null }), 0);
});

test('final score is capped at 100', async () => {
  const result = await calculateMatchScore(
    { ...buyer, urgency: 'urgent' },
    { ...seller, timeline: 'urgent' },
    property,
    {
      skipKnowledge: true
    }
  );

  assert.equal(result.score, 100);
});

test('scoreKnowledgeAlignment uses semantic search and stays within the bonus range', async (t) => {
  const originalSemanticSearch = knowledgeSearch.semanticSearch;

  t.after(() => {
    knowledgeSearch.semanticSearch = originalSemanticSearch;
  });

  knowledgeSearch.semanticSearch = async () => [
    {
      knowledge_entry: {
        content: 'Mike Chen loves Carson industrial and wants distressed deals there.',
        title: 'Buyer note'
      }
    },
    {
      knowledge_entry: {
        content: "Avoid 90001 zip and don't chase non-industrial deals.",
        title: 'Buyer caution'
      }
    }
  ];

  const result = await scoreKnowledgeAlignment(buyer, property);

  assert.ok(result.adjustment >= -10 && result.adjustment <= 10);
  assert.ok(result.signals.length >= 1);
});
