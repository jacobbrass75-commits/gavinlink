function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function getTelegramBotToken() {
  const token = cleanText(process.env.TELEGRAM_BOT_TOKEN, null);

  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is required for Telegram access');
  }

  return token;
}

function getTelegramBaseUrl() {
  return `https://api.telegram.org/bot${getTelegramBotToken()}`;
}

function getDefaultTelegramChatId() {
  return cleanText(process.env.TELEGRAM_DEFAULT_CHAT_ID, null);
}

async function telegramRequest(methodName, payload = {}) {
  const response = await fetch(`${getTelegramBaseUrl()}/${methodName}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const result = await response.json();

  if (!response.ok || !result?.ok) {
    throw new Error(result?.description || `Telegram request failed for ${methodName}`);
  }

  return result.result;
}

async function sendTelegramMessage({ chatId, text, parseMode = null, disableWebPreview = true }) {
  const targetChatId = cleanText(chatId, null) || getDefaultTelegramChatId();
  const messageText = cleanText(text, null);

  if (!targetChatId) {
    throw new Error('chatId is required');
  }

  if (!messageText) {
    throw new Error('text is required');
  }

  return telegramRequest('sendMessage', {
    chat_id: targetChatId,
    text: messageText,
    ...(parseMode ? { parse_mode: parseMode } : {}),
    disable_web_page_preview: disableWebPreview
  });
}

async function listTelegramUpdates({ offset = null, limit = 10, timeoutSeconds = null } = {}) {
  return telegramRequest('getUpdates', {
    ...(offset == null ? {} : { offset }),
    limit: Math.min(Math.max(Number(limit) || 10, 1), 100),
    ...(Number.isFinite(Number(timeoutSeconds)) && Number(timeoutSeconds) > 0
      ? { timeout: Math.min(Math.max(Number(timeoutSeconds), 1), 60) }
      : {})
  });
}

module.exports = {
  getDefaultTelegramChatId,
  sendTelegramMessage,
  listTelegramUpdates
};
