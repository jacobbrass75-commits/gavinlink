const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyForeclosureStage } = require('../../src/sellers/foreclosure-stage');

function isoDaysAgo(days) {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

test('Non-foreclosure properties classify as none', () => {
  assert.equal(classifyForeclosureStage({ foreclosure: false }), 'none');
});

test('Recent default classifies as notice_of_default', () => {
  assert.equal(
    classifyForeclosureStage({
      foreclosure: true,
      default_date: isoDaysAgo(30)
    }),
    'notice_of_default'
  );
});

test('Mid-process default classifies as notice_of_sale', () => {
  assert.equal(
    classifyForeclosureStage({
      foreclosure: true,
      default_date: isoDaysAgo(120)
    }),
    'notice_of_sale'
  );
});

test('Old default classifies as auction_pending', () => {
  assert.equal(
    classifyForeclosureStage({
      foreclosure: true,
      default_date: isoDaysAgo(200)
    }),
    'auction_pending'
  );
});

test('Sale date classifies as reo', () => {
  assert.equal(
    classifyForeclosureStage({
      foreclosure: true,
      sale_date: '2026-01-15'
    }),
    'reo'
  );
});

test('TitlePro no recording status classifies as pre_foreclosure', () => {
  assert.equal(
    classifyForeclosureStage({
      foreclosure: true,
      metadata: {
        titlepro_status: 'no_recording_date'
      }
    }),
    'pre_foreclosure'
  );
});

test('Missing foreclosure dates classify as unknown', () => {
  assert.equal(
    classifyForeclosureStage({
      foreclosure: true
    }),
    'unknown'
  );
});
