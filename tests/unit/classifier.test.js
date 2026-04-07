const test = require('node:test');
const assert = require('node:assert/strict');
const provider = require('../../src/inference/provider');
const { classifyMessage, validateClassification } = require('../../src/ingestion/classifier');

test('classifyMessage returns buyer intel structure', async (t) => {
  const originalComplete = provider.complete;

  t.after(() => {
    provider.complete = originalComplete;
  });

  provider.complete = async () =>
    JSON.stringify({
      classifications: ['buyer_intel'],
      entities: [{ name: 'Mike Chen', type: 'person' }],
      relationships: [],
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
      summary: 'Buyer note for Mike Chen'
    });

  const result = await classifyMessage('Mike Chen wants industrial in Carson, $4M, SBA');

  assert.deepEqual(result.classifications, ['buyer_intel']);
  assert.equal(result.entities[0].name, 'Mike Chen');
  assert.equal(result.buyer_profile.entity_name, 'Mike Chen');
  assert.equal(result.buyer_profile.financing_preference, 'sba');
});

test('classifyMessage returns seller intel structure', async (t) => {
  const originalComplete = provider.complete;

  t.after(() => {
    provider.complete = originalComplete;
  });

  provider.complete = async () =>
    JSON.stringify({
      classifications: ['seller_intel'],
      entities: [{ name: 'MAIE JT & KT DEVELOPMENT LLC', type: 'company' }],
      seller_profile: {
        entity_name: 'MAIE JT & KT DEVELOPMENT LLC',
        minimum_acceptable: 10000000,
        distress_level: 4
      },
      property_ref: {
        address: '8122 MAIE AVE'
      },
      summary: 'Seller note for MAIE'
    });

  const result = await classifyMessage('Owner of 8122 Maie Ave is desperate, take 10M');

  assert.deepEqual(result.classifications, ['seller_intel']);
  assert.equal(result.seller_profile.minimum_acceptable, 10000000);
  assert.equal(result.property_ref.address, '8122 MAIE AVE');
});

test('classifyMessage returns relationship data', async (t) => {
  const originalComplete = provider.complete;

  t.after(() => {
    provider.complete = originalComplete;
  });

  provider.complete = async () =>
    JSON.stringify({
      classifications: ['relationship'],
      entities: [
        { name: 'David Kim', type: 'person' },
        { name: 'Maie LLC', type: 'company' },
        { name: 'Long Beach LLC', type: 'company' }
      ],
      relationships: [
        { entity_a: 'David Kim', entity_b: 'Maie LLC', relationship: 'principal_of' },
        { entity_a: 'David Kim', entity_b: 'Long Beach LLC', relationship: 'principal_of' }
      ],
      summary: 'Relationship note'
    });

  const result = await classifyMessage('David Kim controls both Maie LLC and Long Beach LLC');

  assert.deepEqual(result.classifications, ['relationship']);
  assert.equal(result.entities.length, 3);
  assert.equal(result.relationships.length, 2);
});

test('classifyMessage handles market insight and multi-classification', async (t) => {
  const originalComplete = provider.complete;

  t.after(() => {
    provider.complete = originalComplete;
  });

  provider.complete = async () =>
    JSON.stringify({
      classifications: ['buyer_intel', 'relationship', 'market_insight'],
      entities: [
        { name: 'Mike Chen', type: 'person' },
        { name: 'Pacific Industrial Group', type: 'company' }
      ],
      relationships: [
        { entity_a: 'Mike Chen', entity_b: 'Pacific Industrial Group', relationship: 'principal_of' }
      ],
      buyer_profile: {
        entity_name: 'Mike Chen',
        target_property_types: ['industrial']
      },
      summary: 'Buyer note with relationship and market context'
    });

  const result = await classifyMessage(
    'Mike Chen at Pacific Industrial Group wants industrial and Carson rents are jumping 15%'
  );

  assert.deepEqual(result.classifications, ['buyer_intel', 'relationship', 'market_insight']);
  assert.equal(result.relationships[0].relationship, 'principal_of');
});

test('classifyMessage falls back to general_note on garbage input when provider fails', async (t) => {
  const originalComplete = provider.complete;

  t.after(() => {
    provider.complete = originalComplete;
  });

  provider.complete = async () => {
    throw new Error('provider unavailable');
  };

  const result = await classifyMessage('asdf');
  assert.deepEqual(result.classifications, ['general_note']);
});

test('validateClassification throws on malformed JSON', () => {
  assert.throws(
    () => validateClassification('{bad json'),
    /Classification response was not valid JSON|contained malformed JSON/
  );
});

test('validateClassification fills defaults for missing fields', () => {
  const result = validateClassification({
    summary: 'Short note'
  });

  assert.deepEqual(result.classifications, ['general_note']);
  assert.deepEqual(result.entities, []);
  assert.deepEqual(result.relationships, []);
  assert.equal(result.buyer_profile, null);
  assert.equal(result.seller_profile, null);
  assert.deepEqual(result.action_items, []);
  assert.equal(result.summary, 'Short note');
});
