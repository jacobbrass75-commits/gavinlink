const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateDistressScore } = require('../../src/sellers/distress-score');

function isoDaysAgo(days) {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

test('Foreclosure only scores 1', () => {
  assert.equal(calculateDistressScore({ foreclosure: true }), 1);
});

test('Foreclosure plus high LTV scores 2', () => {
  assert.equal(calculateDistressScore({ foreclosure: true, ltv: 90 }), 2);
});

test('Foreclosure plus high LTV plus large default scores 3', () => {
  assert.equal(
    calculateDistressScore({
      foreclosure: true,
      ltv: 90,
      default_amount: 150000,
      assessed_value: 1000000
    }),
    3
  );
});

test('Foreclosure plus owner occupied scores 2', () => {
  assert.equal(calculateDistressScore({ foreclosure: true, owner_occupied: true }), 2);
});

test('Foreclosure plus old default date scores 2', () => {
  assert.equal(
    calculateDistressScore({
      foreclosure: true,
      default_date: isoDaysAgo(240)
    }),
    2
  );
});

test('Maximum distress is clamped to 5', () => {
  assert.equal(
    calculateDistressScore(
      {
        foreclosure: true,
        ltv: 92,
        default_amount: 250000,
        assessed_value: 1000000,
        owner_occupied: true,
        default_date: isoDaysAgo(240),
        equity_percent: 10
      },
      { owner_foreclosure_count: 3 }
    ),
    5
  );
});

test('No foreclosure still clamps to 1', () => {
  assert.equal(calculateDistressScore({ foreclosure: false }), 1);
});

test('Null-heavy data is handled gracefully', () => {
  assert.equal(
    calculateDistressScore({
      foreclosure: true,
      ltv: null,
      default_amount: null,
      assessed_value: null,
      owner_occupied: null,
      default_date: null
    }),
    1
  );
});

test('Portfolio bonus contributes to the score', () => {
  assert.equal(
    calculateDistressScore(
      {
        foreclosure: true
      },
      {
        owner_foreclosure_count: 3
      }
    ),
    2
  );
});

test('Overweight data still clamps to 5', () => {
  assert.equal(
    calculateDistressScore(
      {
        foreclosure: true,
        ltv: 120,
        loan_amount: 2000000,
        assessed_value: 1000000,
        default_amount: 500000,
        owner_occupied: true,
        default_date: isoDaysAgo(365),
        equity_percent: 5,
        trustee_phone: '555-1212',
        sq_feet: 70000
      },
      { owner_foreclosure_count: 5 }
    ),
    5
  );
});
