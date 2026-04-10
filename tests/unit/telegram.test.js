const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getDefaultTelegramChatId
} = require('../../src/integrations/telegram');

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

test('getDefaultTelegramChatId returns configured chat id', () => {
  const snapshot = {
    TELEGRAM_DEFAULT_CHAT_ID: process.env.TELEGRAM_DEFAULT_CHAT_ID
  };

  process.env.TELEGRAM_DEFAULT_CHAT_ID = '-1001234567890';
  assert.equal(getDefaultTelegramChatId(), '-1001234567890');

  restoreEnv(snapshot);
});
