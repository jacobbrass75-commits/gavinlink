const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyEntityType,
  normalizeName,
  extractEntities
} = require('../../src/entities/extract');
const {
  cleanZip,
  mapBatchType
} = require('../../scripts/import-from-realestatetool');

test('classifyEntityType identifies LLC entities', () => {
  assert.equal(classifyEntityType('MAIE JT & KT DEVELOPMENT LLC'), 'llc');
});

test('classifyEntityType identifies corporations', () => {
  assert.equal(classifyEntityType('SPECIAL DEFAULT SERVICES INC'), 'corporation');
});

test('classifyEntityType identifies trusts', () => {
  assert.equal(classifyEntityType('SMITH FAMILY TRUST'), 'trust');
});

test('classifyEntityType identifies partnerships', () => {
  assert.equal(classifyEntityType('WESTSIDE CAPITAL PARTNERS LP'), 'partnership');
});

test('classifyEntityType identifies people', () => {
  assert.equal(classifyEntityType('JOHN SMITH'), 'person');
});

test('classifyEntityType handles dotted LLC names', () => {
  assert.equal(classifyEntityType('ABC HOLDINGS L.L.C.'), 'llc');
});

test('normalizeName uppercases and collapses whitespace', () => {
  assert.equal(
    normalizeName('  maie jt & kt   development llc  '),
    'MAIE JT & KT DEVELOPMENT LLC'
  );
});

test('extractEntities returns owner and trustee entities from a property', () => {
  const results = extractEntities({
    owner_first_name: 'MAIE JT & KT DEVELOPMENT LLC',
    trustee_name: 'SPECIAL DEFAULT SERVICES INC',
    beneficiary_name: 'PACIFIC LOAN SERVICING',
    source: 'realestatetool'
  });

  assert.equal(results.length, 3);
  assert.deepEqual(
    results.map((result) => ({
      name: result.name,
      type: result.entity_type,
      field: result.source_field
    })),
    [
      {
        name: 'MAIE JT & KT DEVELOPMENT LLC',
        type: 'llc',
        field: 'owner_first_name'
      },
      {
        name: 'SPECIAL DEFAULT SERVICES INC',
        type: 'corporation',
        field: 'trustee_name'
      },
      {
        name: 'PACIFIC LOAN SERVICING',
        type: 'lender',
        field: 'beneficiary_name'
      }
    ]
  );
});

test('extractEntities handles null trustee names', () => {
  const results = extractEntities({
    owner_first_name: 'JOHN SMITH',
    trustee_name: null
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].source_field, 'owner_first_name');
});

test('extractEntities returns an empty array when all supported fields are null', () => {
  assert.deepEqual(
    extractEntities({
      owner_first_name: null,
      trustee_name: null,
      beneficiary_name: null
    }),
    []
  );
});

test('cleanZip removes spreadsheet decimal suffixes', () => {
  assert.equal(cleanZip('90001.0'), '90001');
});

test('mapBatchType maps industrial batches', () => {
  assert.equal(mapBatchType('IND'), 'industrial');
});

test('mapBatchType maps commercial batches', () => {
  assert.equal(mapBatchType('COM'), 'commercial');
});

test('mapBatchType returns other for unknown batch types', () => {
  assert.equal(mapBatchType('XYZ'), 'other');
});
