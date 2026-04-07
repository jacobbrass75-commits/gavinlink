const test = require('node:test');
const assert = require('node:assert/strict');
const { explainMatch } = require('../../src/matching/explainer');

const buyer = {
  entity_name: 'Mike Chen',
  max_price: 4000000,
  investment_strategy: 'value_add',
  urgency: 'actively_looking'
};

const seller = {
  distress_level: 4,
  timeline: 'urgent'
};

const property = {
  property_type: 'industrial',
  city: 'Carson',
  sq_feet: 28000,
  assessed_value: 3500000
};

test('explainMatch lists the main positive signals in a strong match', () => {
  const reasons = explainMatch({
    buyer,
    seller,
    property,
    breakdown: {
      property_type: 25,
      price: 25,
      location: 20,
      size: 15,
      strategy: 15,
      timing: 8,
      knowledge: 0,
      knowledge_signals: []
    }
  });

  assert.ok(reasons.some((reason) => reason.includes('Property type match: industrial')));
  assert.ok(reasons.some((reason) => reason.includes('Target city: Carson')));
  assert.ok(reasons.some((reason) => reason.includes('Size match:')));
  assert.ok(reasons.some((reason) => reason.includes('Strategy fit: value_add')));
});

test('explainMatch adds a price flag when pricing misses the buyer budget', () => {
  const reasons = explainMatch({
    buyer,
    seller,
    property: { ...property, assessed_value: 16248200 },
    breakdown: {
      property_type: 25,
      price: 0,
      location: 20,
      size: 15,
      strategy: 15,
      timing: 8,
      knowledge: 0,
      knowledge_signals: []
    }
  });

  assert.ok(reasons.some((reason) => reason.includes('PRICE FLAG')));
});

test('explainMatch includes a location bonus for an exact city match', () => {
  const reasons = explainMatch({
    buyer,
    seller,
    property,
    breakdown: {
      property_type: 25,
      price: 15,
      location: 20,
      size: 0,
      strategy: 0,
      timing: 0,
      knowledge: 0,
      knowledge_signals: []
    }
  });

  assert.ok(reasons.some((reason) => reason.includes('Target city: Carson')));
});

test('explainMatch surfaces positive knowledge signals', () => {
  const reasons = explainMatch({
    buyer,
    seller,
    property,
    breakdown: {
      property_type: 25,
      price: 25,
      location: 20,
      size: 15,
      strategy: 15,
      timing: 8,
      knowledge: 5,
      knowledge_signals: ['Buyer notes mention Carson']
    }
  });

  assert.ok(reasons.some((reason) => reason.includes('Knowledge signal: Buyer notes mention Carson')));
});

test('explainMatch surfaces negative knowledge signals as cautions', () => {
  const reasons = explainMatch({
    buyer,
    seller,
    property,
    breakdown: {
      property_type: 25,
      price: 25,
      location: 20,
      size: 15,
      strategy: 15,
      timing: 8,
      knowledge: -5,
      knowledge_signals: ['Buyer notes warn against Carson']
    }
  });

  assert.ok(
    reasons.some((reason) => reason.includes('Knowledge caution: Buyer notes warn against Carson'))
  );
});
