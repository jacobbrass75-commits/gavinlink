const fs = require('fs');
const path = require('path');
const brainApp = require('../app/brain');
const runtimeApp = require('../app/runtime');
const inferenceProvider = require('../inference/provider');
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

async function getBrainHealthPayload() {
  return runtimeApp.getRuntimeStatus();
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

function stripTrailingPunctuation(text) {
  return String(text || '').replace(/^[\s"'`]+|[\s"'`?!.,:;]+$/g, '').trim();
}

function classifyPlainTextHeuristically(text) {
  const normalized = cleanText(text, '');
  const lowered = normalized.toLowerCase();

  if (!normalized) {
    return {
      name: 'help',
      argument: ''
    };
  }

  if (
    /\b(don'?t save|do not save|dont save|never ?mind|nvm|cancel that|ignore that|stop)\b/i.test(
      normalized
    )
  ) {
    return {
      name: 'cancel',
      argument: ''
    };
  }

  if (
    /\b(help|what can you do|how do i use|commands)\b/i.test(normalized)
  ) {
    return {
      name: 'help',
      argument: ''
    };
  }

  if (
    /\b(are you working|you working|are you there|are you online|status|working\?)\b/i.test(
      normalized
    )
  ) {
    return {
      name: 'status',
      argument: ''
    };
  }

  if (
    /\b(what should i do today|what do i need to do today|today'?s priorities|daily brief|daily)\b/i.test(
      normalized
    )
  ) {
    return {
      name: 'daily',
      argument: ''
    };
  }

  const lookupMatch =
    normalized.match(/^(?:who is|who's|what do we know about|tell me about|lookup)\s+(.+)$/i) ||
    normalized.match(/^(?:pull up|show me)\s+(.+)$/i);

  if (lookupMatch) {
    return {
      name: 'lookup',
      argument: stripTrailingPunctuation(lookupMatch[1])
    };
  }

  const searchMatch =
    normalized.match(/^(?:search|find|search for|find me)\s+(.+)$/i) ||
    normalized.match(/^(?:what do we have on)\s+(.+)$/i);

  if (searchMatch) {
    return {
      name: 'search',
      argument: stripTrailingPunctuation(searchMatch[1])
    };
  }

  const matchMatch =
    normalized.match(/^(?:match|match for|find matches for|who matches)\s+(.+)$/i) ||
    normalized.match(/^(?:buyers for|matches for)\s+(.+)$/i);

  if (matchMatch) {
    return {
      name: 'match',
      argument: stripTrailingPunctuation(matchMatch[1])
    };
  }

  const explicitAddMatch =
    normalized.match(/^(?:save|remember|note|add|log|record|capture)(?:\s+this)?\s*(?::|-)?\s+(.+)$/i) ||
    normalized.match(/^(?:just talked to|talked to|met with|call with|call notes?:)\s+(.+)$/i);

  if (explicitAddMatch) {
    return {
      name: 'add',
      argument: stripTrailingPunctuation(explicitAddMatch[1] || normalized)
    };
  }

  return {
    name: 'unknown',
    argument: normalized
  };
}

function tryParseJsonObject(text) {
  const normalized = cleanText(text, null);

  if (!normalized) {
    return null;
  }

  const firstBrace = normalized.indexOf('{');
  const lastBrace = normalized.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  try {
    return JSON.parse(normalized.slice(firstBrace, lastBrace + 1));
  } catch (_error) {
    return null;
  }
}

async function classifyPlainTextWithInference(text) {
  const provider = String(process.env.INFERENCE_PROVIDER || '').trim().toLowerCase();
  const hasAnthropicKey = cleanText(process.env.ANTHROPIC_API_KEY, null);
  const hasOpenAiKey = cleanText(process.env.OPENAI_API_KEY, null);

  if (!text || ((provider === 'claude' || !provider) && !hasAnthropicKey)) {
    return null;
  }

  if (provider === 'openai' && !hasOpenAiKey) {
    return null;
  }

  if (provider === 'ollama') {
    return null;
  }

  const prompt = [
    'You route Telegram messages for Soleil, a commercial real estate assistant.',
    'Return minified JSON only with keys: intent, argument.',
    'Allowed intents: help, status, daily, search, lookup, match, add, cancel, unknown.',
    'Choose add only when the user is explicitly asking to save, remember, capture, or log a note, or the message is clearly broker intel meant for storage.',
    'Casual chat, corrections, greetings, status checks, and "do not save" messages must not be add.',
    'For lookup/search/match, extract the best argument string.',
    'For status/help/daily/cancel/unknown, use an empty argument unless needed.',
    `Message: ${JSON.stringify(text)}`
  ].join('\n');

  try {
    const raw = await inferenceProvider.complete(prompt, {
      maxTokens: 180
    });
    const parsed = tryParseJsonObject(raw);

    if (!parsed || typeof parsed.intent !== 'string') {
      return null;
    }

    const intent = parsed.intent.trim().toLowerCase();
    const allowed = new Set(['help', 'status', 'daily', 'search', 'lookup', 'match', 'add', 'cancel', 'unknown']);

    if (!allowed.has(intent)) {
      return null;
    }

    return {
      name: intent,
      argument: cleanText(parsed.argument, '')
    };
  } catch (_error) {
    return null;
  }
}

async function resolveTelegramIntent(text) {
  const heuristic = classifyPlainTextHeuristically(text);

  if (heuristic.name !== 'unknown') {
    return heuristic;
  }

  const inferred = await classifyPlainTextWithInference(text);

  if (inferred && inferred.name !== 'unknown') {
    return inferred;
  }

  return {
    name: 'unknown',
    argument: cleanText(text, '')
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
      'Plain text is intent-routed first.',
      'Use /add or say "save:" when you want something stored as a note.'
    ].join('\n')
  );
}

async function handleCommand(command, argument) {
  switch (command) {
    case 'start':
    case 'help':
      return buildHelpText();
    case 'status':
      return formatStatusPayload(await getBrainHealthPayload());
    case 'daily':
      return formatDailyPayload(await brainApp.getDailyBrief());
    case 'search':
      if (!argument) {
        return 'Usage: /search <query>';
      }

      return formatSearchPayload(await brainApp.searchBrain({ query: argument, limit: 5 }));
    case 'lookup':
      if (!argument) {
        return 'Usage: /lookup <name or address>';
      }

      return formatLookupPayload(await brainApp.lookupBrain({ name: argument }));
    case 'match':
      if (!argument) {
        return 'Usage: /match <buyer or property>';
      }

      return formatMatchPayload(await brainApp.matchIdentifier({ identifier: argument, limit: 5 }));
    case 'add':
      if (!argument) {
        return 'Usage: /add <note>';
      }

      await brainApp.ingestMessage({
        message: argument,
        source: 'telegram'
      });
      return 'Saved to Soleil.';
    case 'cancel':
      return 'Not saved.';
    case 'unknown':
      return 'I did not save that. Ask a question, use a command, or say "save:" when you want a note captured.';
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

  const parsed = parseTelegramCommand(text);
  const resolved = parsed.name === 'plain' ? await resolveTelegramIntent(text) : parsed;
  const { name, argument } = resolved;
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
  classifyPlainTextHeuristically,
  resolveTelegramIntent,
  formatDailyPayload,
  formatSearchPayload,
  formatLookupPayload,
  formatMatchPayload,
  formatStatusPayload,
  getBrainHealthPayload,
  loadOffsetState,
  saveOffsetState,
  processTelegramUpdates,
  runTelegramBot
};
