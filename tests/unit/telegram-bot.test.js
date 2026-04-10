const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseTelegramCommand,
  formatDailyPayload,
  formatSearchPayload
} = require('../../src/ops/telegram-bot');

test('parseTelegramCommand treats plain text as add', () => {
  assert.deepEqual(parseTelegramCommand('Mike Chen wants Carson industrial'), {
    name: 'add',
    argument: 'Mike Chen wants Carson industrial'
  });
});

test('parseTelegramCommand strips bot mentions from slash commands', () => {
  assert.deepEqual(parseTelegramCommand('/daily@Syllei_bot'), {
    name: 'daily',
    argument: ''
  });
});

test('formatDailyPayload summarizes action items and distressed sellers', () => {
  const formatted = formatDailyPayload({
    action_items: [
      {
        action: 'Call Mike Chen',
        summary: 'Buyer follow-up'
      }
    ],
    distressed_sellers: [
      {
        entity_name: 'Acme LLC',
        address: '8122 MAIE AVE',
        distress_level: 4
      }
    ]
  });

  assert.match(formatted, /Call Mike Chen/);
  assert.match(formatted, /Acme LLC/);
});

test('formatSearchPayload handles empty results', () => {
  assert.equal(formatSearchPayload({ results: [] }), 'No matching knowledge entries found.');
});
