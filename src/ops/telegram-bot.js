const fs = require('fs');
const path = require('path');
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

function cleanLines(values = []) {
  return values
    .map((value) => cleanText(value, null))
    .filter(Boolean);
}

function getApiBaseUrl() {
  return String(process.env.BRAIN_API_URL || `http://localhost:${process.env.API_PORT || 3100}`).replace(
    /\/$/,
    ''
  );
}

function getAdminHeaders(headers = {}) {
  if (!process.env.ADMIN_API_KEY) {
    return headers;
  }

  return {
    ...headers,
    'x-api-key': process.env.ADMIN_API_KEY
  };
}

async function callBrainApi(method, endpoint, body) {
  const response = await fetch(`${getApiBaseUrl()}${endpoint}`, {
    method,
    headers: getAdminHeaders(body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error || `Brain API request failed with status ${response.status}`);
  }

  return payload;
}

function getOffsetFilePath() {
  return path.resolve(process.cwd(), process.env.TELEGRAM_BOT_OFFSET_FILE || 'data/telegram-bot-offset.json');
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
      name: 'add',
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

function formatDailyPayload(payload) {
  const lines = ['Soleil daily brief'];

  const actionItems = Array.isArray(payload?.action_items) ? payload.action_items.slice(0, 5) : [];
  const distressed = Array.isArray(payload?.distressed_sellers)
    ? payload.distressed_sellers.slice(0, 5)
    : [];

  if (actionItems.length > 0) {
    lines.push('', 'Action items:');

    for (const item of actionItems) {
      lines.push(`- ${item.action}${item.summary ? ` (${item.summary})` : ''}`);
    }
  }

  if (distressed.length > 0) {
    lines.push('', 'Distressed sellers:');

    for (const seller of distressed) {
      lines.push(
        `- ${seller.entity_name || 'Unknown seller'}${seller.address ? ` - ${seller.address}` : ''}${seller.distress_level != null ? ` (distress ${seller.distress_level})` : ''}`
      );
    }
  }

  if (actionItems.length === 0 && distressed.length === 0) {
    lines.push('', 'No priority items yet.');
  }

  return truncateMessage(lines.join('\n'));
}

function formatSearchPayload(payload) {
  const results = Array.isArray(payload?.results) ? payload.results.slice(0, 5) : [];

  if (results.length === 0) {
    return 'No matching knowledge entries found.';
  }

  const lines = ['Search results:'];

  for (const result of results) {
    const entry = result.knowledge_entry || {};
    const summary = cleanText(entry.title, null) || cleanText(entry.content, 'Untitled entry');
    const score = Number.isFinite(Number(result.relevance_score))
      ? ` [score ${Number(result.relevance_score).toFixed(2)}]`
      : '';
    lines.push(`- ${summary}${score}`);
  }

  return truncateMessage(lines.join('\n'));
}

function formatLookupPayload(payload) {
  if (payload?.kind === 'entity') {
    const lines = [
      `Entity: ${payload.entity?.name || 'Unknown'}`,
      `Type: ${payload.entity?.type || 'unknown'}`
    ];
    const properties = Array.isArray(payload?.properties) ? payload.properties.slice(0, 5) : [];
    const relationships = Array.isArray(payload?.relationships) ? payload.relationships.slice(0, 5) : [];

    if (properties.length > 0) {
      lines.push('', 'Properties:');

      for (const property of properties) {
        lines.push(`- ${property.address || property.apn || property.id}`);
      }
    }

    if (relationships.length > 0) {
      lines.push('', 'Relationships:');

      for (const relationship of relationships) {
        lines.push(`- ${relationship.relationship} -> ${relationship.entity?.name || 'Unknown'}`);
      }
    }

    return truncateMessage(lines.join('\n'));
  }

  if (payload?.kind === 'property') {
    const property = payload.property || {};
    const seller = payload.seller_profile || null;
    const lines = [
      `Property: ${property.address || property.apn || property.id || 'Unknown'}`,
      `Type: ${property.property_type || 'unknown'}`,
      `Foreclosure: ${property.foreclosure ? 'yes' : 'no'}`
    ];

    if (seller) {
      lines.push(
        `Seller distress: ${seller.distress_level != null ? seller.distress_level : 'unknown'}`
      );
    }

    return truncateMessage(lines.join('\n'));
  }

  return 'Lookup returned no usable result.';
}

function formatMatchPayload(payload) {
  const matches = Array.isArray(payload?.matches) ? payload.matches.slice(0, 5) : [];

  if (matches.length === 0) {
    return 'No matches found.';
  }

  const lines = [`Matches for ${payload.identifier || 'request'}:`];

  for (const match of matches) {
    lines.push(
      `- ${match.property?.address || match.property?.apn || 'Unknown property'} | buyer ${match.buyer?.entity_name || 'Unknown'} | score ${match.score}`
    );
  }

  return truncateMessage(lines.join('\n'));
}

function formatStatusPayload(payload) {
  const lines = [
    `Brain health: ${payload.status || 'unknown'}`,
    `Database: ${payload.database || 'unknown'}`,
    `ChromaDB: ${payload.chromadb || 'unknown'}`,
    `Inference: ${payload.inference_provider || 'unknown'}`,
    `Gmail configured: ${cleanText(process.env.GMAIL_REFRESH_TOKEN, null) ? 'yes' : 'no'}`,
    `PropertyRadar sync ready: ${cleanText(process.env.GMAIL_REFRESH_TOKEN, null) ? 'yes' : 'blocked by Gmail refresh token'}`
  ];

  return truncateMessage(lines.join('\n'));
}

function buildHelpText() {
  return truncateMessage(
    [
      'Soleil Telegram commands:',
      '/help',
      '/status',
      '/daily',
      '/search <query>',
      '/lookup <name or address>',
      '/match <buyer or property>',
      '/add <note>',
      '',
      'Any plain text message is treated as a brain note and ingested automatically.'
    ].join('\n')
  );
}

async function handleCommand(command, argument) {
  switch (command) {
    case 'start':
    case 'help':
      return buildHelpText();
    case 'status':
      return formatStatusPayload(await callBrainApi('GET', '/health'));
    case 'daily':
      return formatDailyPayload(await callBrainApi('GET', '/api/daily'));
    case 'search':
      if (!argument) {
        return 'Usage: /search <query>';
      }

      return formatSearchPayload(await callBrainApi('POST', '/api/search', { query: argument, limit: 5 }));
    case 'lookup':
      if (!argument) {
        return 'Usage: /lookup <name or address>';
      }

      return formatLookupPayload(
        await callBrainApi('GET', `/api/entities/lookup?name=${encodeURIComponent(argument)}`)
      );
    case 'match':
      if (!argument) {
        return 'Usage: /match <buyer or property>';
      }

      return formatMatchPayload(
        await callBrainApi('GET', `/api/match/${encodeURIComponent(argument)}?limit=5`)
      );
    case 'add':
      if (!argument) {
        return 'Usage: /add <note>';
      }

      await callBrainApi('POST', '/api/ingest', {
        message: argument,
        source: 'telegram'
      });
      return 'Saved to Soleil.';
    default:
      return buildHelpText();
  }
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

  const { name, argument } = parseTelegramCommand(text);
  const responseText = await handleCommand(name, argument);

  await sendTelegramMessage({
    chatId,
    text: responseText
  });

  return {
    processed: true,
    command: name
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
    try {
      outcomes.push({
        update_id: update.update_id,
        ...(await processUpdate(update))
      });
    } catch (error) {
      const chatId = cleanText(update?.message?.chat?.id != null ? String(update.message.chat.id) : null, null);

      if (chatId) {
        await sendTelegramMessage({
          chatId,
          text: truncateMessage(`Soleil hit an error: ${error.message}`)
        }).catch(() => {});
      }

      outcomes.push({
        update_id: update.update_id,
        processed: false,
        reason: 'error',
        error: error.message
      });
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
  formatDailyPayload,
  formatSearchPayload,
  formatLookupPayload,
  formatMatchPayload,
  formatStatusPayload,
  loadOffsetState,
  saveOffsetState,
  processTelegramUpdates,
  runTelegramBot
};
