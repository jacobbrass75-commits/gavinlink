const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseTelegramCommand,
  classifyPlainTextHeuristically,
  formatDailyPayload,
  formatSearchPayload
} = require('../../src/ops/telegram-bot');

test('parseTelegramCommand treats plain text as unresolved plain text', () => {
  assert.deepEqual(parseTelegramCommand('Mike Chen wants Carson industrial'), {
    name: 'plain',
    argument: 'Mike Chen wants Carson industrial'
  });
});

test('parseTelegramCommand strips bot mentions from slash commands', () => {
  assert.deepEqual(parseTelegramCommand('/daily@Syllei_bot'), {
    name: 'daily',
    argument: ''
  });
});

test('classifyPlainTextHeuristically routes casual status checks away from add', () => {
  assert.deepEqual(classifyPlainTextHeuristically('yo you working bro'), {
    name: 'status',
    argument: ''
  });
});

test('classifyPlainTextHeuristically cancels explicit do-not-save messages', () => {
  assert.deepEqual(classifyPlainTextHeuristically("nah don't save"), {
    name: 'cancel',
    argument: ''
  });
});

test('classifyPlainTextHeuristically still allows explicit note capture', () => {
  assert.deepEqual(
    classifyPlainTextHeuristically('save: Mike Chen wants Carson industrial'),
    {
      name: 'add',
      argument: 'Mike Chen wants Carson industrial'
    }
  );
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
