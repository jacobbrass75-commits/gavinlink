const fs = require('fs');
const path = require('path');
const assistantApp = require('../app/assistant');
const {
  sendTelegramMessage,
  listTelegramUpdates,
  getDefaultTelegramChatId
} = require('../integrations/telegram');

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function getOffsetFilePath() {
  return path.resolve(
    process.cwd(),
    process.env.TELEGRAM_BOT_OFFSET_FILE || 'data/telegram-bot-offset.json'
  );
}

function getAllowedChatIds() {
  const configured = cleanText(process.env.TELEGRAM_ALLOWED_CHAT_IDS, null);

  if (configured) {
    return new Set(
      configured
        .split(',')
        .map((value) => cleanText(value, null))
        .filter(Boolean)
    );
  }

  const defaultChatId = getDefaultTelegramChatId();
  return new Set(defaultChatId ? [defaultChatId] : []);
}

async function loadOffsetState() {
  const filePath = getOffsetFilePath();

  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      next_update_id: Number.isInteger(parsed?.next_update_id) ? parsed.next_update_id : null
    };
  } catch (_error) {
    return {
      next_update_id: null
    };
  }
}

async function saveOffsetState(state) {
  const filePath = getOffsetFilePath();
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(`${filePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.promises.rename(`${filePath}.tmp`, filePath);
}

function truncateMessage(text, maxLength = 3800) {
  const normalized = String(text || '').trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function stripBotMention(commandToken) {
  return String(commandToken || '').replace(/@\w+$/, '');
}

function parseTelegramCommand(text) {
  const normalized = cleanText(text, '');

  if (!normalized.startsWith('/')) {
    return {
      name: 'plain',
      argument: normalized
    };
  }

  const [rawCommand, ...rest] = normalized.split(/\s+/);
  const name = stripBotMention(rawCommand).slice(1).toLowerCase();
  const argument = rest.join(' ').trim();

  return {
    name,
    argument
  };
}

async function processUpdate(update) {
  const message = update?.message;
  const chatId = cleanText(message?.chat?.id != null ? String(message.chat.id) : null, null);
  const text = cleanText(message?.text, null);

  if (!chatId || !text) {
    return {
      processed: false,
      reason: 'ignored_non_text'
    };
  }

  const allowedChatIds = getAllowedChatIds();

  if (allowedChatIds.size > 0 && !allowedChatIds.has(chatId)) {
    await sendTelegramMessage({
      chatId,
      text: 'This chat is not authorized for Soleil yet.'
    });
    return {
      processed: false,
      reason: 'unauthorized'
    };
  }

  const parsed = parseTelegramCommand(text);
  const assistantMessage =
    parsed.name === 'plain' ? text : `/${parsed.name}${parsed.argument ? ` ${parsed.argument}` : ''}`;
  const result = await assistantApp.answerMessage({
    message: assistantMessage,
    source: 'telegram',
    surface: 'telegram',
    limit: 5,
    allowSave: true
  });

  await sendTelegramMessage({
    chatId,
    text: result.reply
  });

  return {
    processed: true,
    command: result.intent,
    route: result.route
  };
}

async function processTelegramUpdates(options = {}) {
  const state = await loadOffsetState();
  const updates = await listTelegramUpdates({
    offset: state.next_update_id,
    limit: options.limit || 10,
    timeoutSeconds: options.timeoutSeconds || 20
  });
  const outcomes = [];
  let nextUpdateId = state.next_update_id;

  for (const update of updates) {
    let outcome;

    try {
      outcome = {
        update_id: update.update_id,
        ...(await processUpdate(update))
      };
    } catch (error) {
      const chatId = cleanText(
        update?.message?.chat?.id != null ? String(update.message.chat.id) : null,
        null
      );

      if (chatId) {
        await sendTelegramMessage({
          chatId,
          text: truncateMessage(`Soleil hit an error: ${error.message}`)
        }).catch(() => {});
      }

      outcome = {
        update_id: update.update_id,
        processed: false,
        reason: 'error',
        error: error.message
      };
    }

    outcomes.push(outcome);

    if (outcome.processed === false && outcome.reason === 'error') {
      break;
    }

    if (Number.isInteger(update.update_id)) {
      nextUpdateId = update.update_id + 1;
    }
  }

  if (nextUpdateId != null && nextUpdateId !== state.next_update_id) {
    await saveOffsetState({
      next_update_id: nextUpdateId
    });
  }

  return {
    updates_received: updates.length,
    next_update_id: nextUpdateId,
    outcomes
  };
}

async function runTelegramBot(options = {}) {
  const once = Boolean(options.once);
  const pollIntervalMs = Math.max(Number(options.pollIntervalMs) || 3000, 250);

  do {
    const result = await processTelegramUpdates(options);

    if (typeof options.onCycle === 'function') {
      await options.onCycle(result);
    }

    if (once) {
      return result;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  } while (true);
}

module.exports = {
  parseTelegramCommand,
  classifyPlainTextHeuristically: assistantApp.classifyPlainTextHeuristically,
  formatDailyPayload: assistantApp.formatDailyPayload,
  formatSearchPayload: assistantApp.formatSearchPayload,
  processUpdate,
  processTelegramUpdates,
  runTelegramBot
};
