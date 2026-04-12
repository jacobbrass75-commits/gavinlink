const brainApp = require('./brain');
const realNexApp = require('./realnex');
const runtimeApp = require('./runtime');
const inferenceProvider = require('../inference/provider');

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
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

function stripAssistantPromptPrefix(text) {
  const normalized = cleanText(text, '');

  if (!normalized || normalized.startsWith('/')) {
    return normalized;
  }

  return normalized
    .replace(/^(?:ask:|question:|assistant:|soleil:)\s*/i, '')
    .replace(/^@soleil[\s,:-]*/i, '')
    .trim();
}

function parseAssistantCommand(text) {
  const normalized = cleanText(text, '');

  if (!normalized.startsWith('/')) {
    return {
      name: 'plain',
      argument: normalized,
      route: 'plain'
    };
  }

  const [rawCommand, ...rest] = normalized.split(/\s+/);
  const name = stripBotMention(rawCommand).slice(1).toLowerCase();
  const argument = rest.join(' ').trim();

  return {
    name,
    argument,
    route: 'command'
  };
}

function stripTrailingPunctuation(text) {
  return String(text || '').replace(/^[\s"'`]+|[\s"'`?!.,:;]+$/g, '').trim();
}

function splitLookupIdentity(argument) {
  const normalized = cleanText(argument, '');

  if (!normalized) {
    return {
      name: '',
      company: null
    };
  }

  const match = normalized.match(/^(.+?)\s+(?:at|from)\s+(.+)$/i);

  if (!match) {
    return {
      name: normalized,
      company: null
    };
  }

  return {
    name: stripTrailingPunctuation(match[1]),
    company: stripTrailingPunctuation(match[2])
  };
}

function looksLikeQuestion(text) {
  const normalized = cleanText(text, '');

  if (!normalized) {
    return false;
  }

  if (normalized.includes('?')) {
    return true;
  }

  return /^(who|what|when|where|why|how|can|could|should|do|does|did|is|are|was|were|will)\b/i.test(
    normalized
  );
}

function classifyPlainTextHeuristically(text) {
  const normalized = cleanText(text, '');

  if (!normalized) {
    return {
      name: 'help',
      argument: '',
      route: 'heuristic'
    };
  }

  if (
    /\b(don'?t save|do not save|dont save|never ?mind|nvm|cancel that|ignore that|stop)\b/i.test(
      normalized
    )
  ) {
    return {
      name: 'cancel',
      argument: '',
      route: 'heuristic'
    };
  }

  if (/\b(help|what can you do|how do i use|commands)\b/i.test(normalized)) {
    return {
      name: 'help',
      argument: '',
      route: 'heuristic'
    };
  }

  if (
    /\b(are you working|you working|are you there|are you online|status|working\?)\b/i.test(
      normalized
    )
  ) {
    return {
      name: 'status',
      argument: '',
      route: 'heuristic'
    };
  }

  if (
    /\b(what should i do today|what do i need to do today|today'?s priorities|daily brief|daily)\b/i.test(
      normalized
    )
  ) {
    return {
      name: 'daily',
      argument: '',
      route: 'heuristic'
    };
  }

  const lookupMatch =
    normalized.match(/^(?:who is|who's|what do we know about|tell me about|lookup)\s+(.+)$/i) ||
    normalized.match(/^(?:pull up|show me|summary for|need a summary for|give me a summary for|brief me on)\s+(.+)$/i);

  if (lookupMatch) {
    return {
      name: 'lookup',
      argument: stripTrailingPunctuation(lookupMatch[1]),
      route: 'heuristic'
    };
  }

  const searchMatch =
    normalized.match(/^(?:search|search for|find|find me)\s+(.+)$/i) ||
    normalized.match(/^(?:what do we have on|what can you find on)\s+(.+)$/i);

  if (searchMatch) {
    return {
      name: 'search',
      argument: stripTrailingPunctuation(searchMatch[1]),
      route: 'heuristic'
    };
  }

  const matchMatch =
    normalized.match(/^(?:match|match for|find matches for|who matches)\s+(.+)$/i) ||
    normalized.match(/^(?:buyers for|matches for|who would buy)\s+(.+)$/i);

  if (matchMatch) {
    return {
      name: 'match',
      argument: stripTrailingPunctuation(matchMatch[1]),
      route: 'heuristic'
    };
  }

  const explicitAddMatch =
    normalized.match(
      /^(?:save|remember|note|add|log|record|capture)(?:\s+this)?\s*(?::|-)?\s+(.+)$/i
    ) ||
    normalized.match(/^(?:just talked to|talked to|met with|call with|call notes?:)\s+(.+)$/i);

  if (explicitAddMatch) {
    return {
      name: 'add',
      argument: stripTrailingPunctuation(explicitAddMatch[1] || normalized),
      route: 'heuristic'
    };
  }

  return {
    name: 'unknown',
    argument: normalized,
    route: 'heuristic'
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
    'You route broker requests for Soleil, a commercial real estate assistant.',
    'Return minified JSON only with keys: intent, argument.',
    'Allowed intents: help, status, daily, search, lookup, match, add, cancel, unknown.',
    'Choose add only when the user is explicitly asking to save, remember, capture, or log a note, or the message is clearly broker intel intended for storage.',
    'Casual chat, corrections, greetings, status checks, and "do not save" messages must not be add.',
    'For lookup/search/match, extract the tightest usable argument string.',
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
    const allowed = new Set([
      'help',
      'status',
      'daily',
      'search',
      'lookup',
      'match',
      'add',
      'cancel',
      'unknown'
    ]);

    if (!allowed.has(intent)) {
      return null;
    }

    return {
      name: intent,
      argument: cleanText(parsed.argument, ''),
      route: 'inference'
    };
  } catch (_error) {
    return null;
  }
}

async function resolveAssistantIntent(text) {
  const normalizedText = stripAssistantPromptPrefix(text);
  const parsedCommand = parseAssistantCommand(normalizedText);

  if (parsedCommand.name !== 'plain') {
    return parsedCommand;
  }

  const heuristic = classifyPlainTextHeuristically(normalizedText);

  if (heuristic.name !== 'unknown') {
    return heuristic;
  }

  const inferred = await classifyPlainTextWithInference(normalizedText);

  if (inferred && inferred.name !== 'unknown') {
    return inferred;
  }

  return {
    name: 'unknown',
      argument: cleanText(normalizedText, ''),
      route: inferred ? 'inference_unknown' : 'fallback_unknown'
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
    const relationships = Array.isArray(payload?.relationships)
      ? payload.relationships.slice(0, 5)
      : [];

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

function formatRealNexLookupResult(result) {
  const lines = [formatLookupPayload(result?.lookup_payload)];

  if (result?.status === 'imported') {
    lines.push('', 'Synced from RealNex.');
  } else if (result?.status === 'already_linked') {
    lines.push('', 'Matched against an existing RealNex-linked entity.');
  }

  if (result?.company_entity?.name) {
    lines.push(`Linked company: ${result.company_entity.name}`);
  }

  return truncateMessage(lines.filter(Boolean).join('\n'));
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

function buildHelpText(surface = 'assistant') {
  if (surface === 'telegram') {
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

  return truncateMessage(
    [
      'Soleil can answer status, daily priorities, lookup, search, match, and explicit save requests.',
      'Examples:',
      '- who is Mike Chen',
      '- what should I do today',
      '- find me Carson industrial buyers',
      '- save: Mike Chen wants 30k sqft in Carson'
    ].join('\n')
  );
}

async function answerMessage(options = {}) {
  const message = cleanText(options.message, '');
  const source = cleanText(options.source, 'assistant');
  const surface = cleanText(options.surface, 'assistant');
  const limit = Number.isFinite(Number(options.limit))
    ? Math.min(Math.max(Number(options.limit), 1), 10)
    : 5;
  const allowSave = options.allowSave !== false;

  if (!message) {
    return {
      intent: 'help',
      argument: '',
      route: 'empty',
      saved: false,
      reply: buildHelpText(surface),
      payload: null
    };
  }

  const resolved = await resolveAssistantIntent(message);

  switch (resolved.name) {
    case 'help':
      return {
        intent: 'help',
        argument: resolved.argument,
        route: resolved.route,
        saved: false,
        reply: buildHelpText(surface),
        payload: null
      };
    case 'status': {
      const payload = await runtimeApp.getRuntimeStatus();
      return {
        intent: 'status',
        argument: '',
        route: resolved.route,
        saved: false,
        reply: formatStatusPayload(payload),
        payload
      };
    }
    case 'daily': {
      const payload = await brainApp.getDailyBrief();
      return {
        intent: 'daily',
        argument: '',
        route: resolved.route,
        saved: false,
        reply: formatDailyPayload(payload),
        payload
      };
    }
    case 'search': {
      if (!resolved.argument) {
        return {
          intent: 'search',
          argument: '',
          route: resolved.route,
          saved: false,
          reply: 'Usage: search <query>',
          payload: null
        };
      }

      const payload = await brainApp.searchBrain({
        query: resolved.argument,
        limit
      });
      return {
        intent: 'search',
        argument: resolved.argument,
        route: resolved.route,
        saved: false,
        reply: formatSearchPayload(payload),
        payload
      };
    }
    case 'lookup': {
      if (!resolved.argument) {
        return {
          intent: 'lookup',
          argument: '',
          route: resolved.route,
          saved: false,
          reply: 'Usage: lookup <name or address>',
          payload: null
        };
      }

      const lookupIdentity = splitLookupIdentity(resolved.argument);

      try {
        const payload = await brainApp.lookupBrain({
          name: lookupIdentity.name
        });
        return {
          intent: 'lookup',
          argument: resolved.argument,
          route: resolved.route,
          saved: false,
          reply: formatLookupPayload(payload),
          payload
        };
      } catch (error) {
        if (error?.statusCode === 404) {
          if (!allowSave) {
            return {
              intent: 'lookup',
              argument: resolved.argument,
              route: `${resolved.route}:not_found`,
              saved: false,
              reply: `No entity or property found for "${resolved.argument}".`,
              payload: null
            };
          }

          try {
            const imported = await realNexApp.syncRealNexMatch(
              {
                name: lookupIdentity.name,
                company: lookupIdentity.company
              },
              {
                minScore: 72,
                createKnowledge: true
              }
            );

            return {
              intent: 'lookup',
              argument: resolved.argument,
              route: `${resolved.route}:realnex_import`,
              saved: Boolean(imported.knowledge_entry_id),
              reply: formatRealNexLookupResult(imported),
              payload: imported.lookup_payload
            };
          } catch (_realNexError) {
            // Fall back to the normal not-found reply when no confident RealNex match exists.
          }

          return {
            intent: 'lookup',
            argument: resolved.argument,
            route: resolved.route,
            saved: false,
            reply: `No entity or property found for "${resolved.argument}".`,
            payload: null
          };
        }

        throw error;
      }
    }
    case 'match': {
      if (!resolved.argument) {
        return {
          intent: 'match',
          argument: '',
          route: resolved.route,
          saved: false,
          reply: 'Usage: match <buyer or property>',
          payload: null
        };
      }

      try {
        const payload = await brainApp.matchIdentifier({
          identifier: resolved.argument,
          limit
        });
        return {
          intent: 'match',
          argument: resolved.argument,
          route: resolved.route,
          saved: false,
          reply: formatMatchPayload(payload),
          payload
        };
      } catch (error) {
        if (error?.statusCode === 404) {
          return {
            intent: 'match',
            argument: resolved.argument,
            route: resolved.route,
            saved: false,
            reply: `No buyer or property matched "${resolved.argument}".`,
            payload: null
          };
        }

        throw error;
      }
    }
    case 'add': {
      if (!allowSave) {
        return {
          intent: 'cancel',
          argument: resolved.argument,
          route: `${resolved.route}:save_blocked`,
          saved: false,
          reply: 'Not saved.',
          payload: null
        };
      }

      const noteText = cleanText(resolved.argument, message);
      const payload = await brainApp.ingestMessage({
        message: noteText,
        source
      });
      return {
        intent: 'add',
        argument: noteText,
        route: resolved.route,
        saved: true,
        reply: 'Saved to Soleil.',
        payload
      };
    }
    case 'cancel':
      return {
        intent: 'cancel',
        argument: '',
        route: resolved.route,
        saved: false,
        reply: 'Not saved.',
        payload: null
      };
    default:
      break;
  }

  if (looksLikeQuestion(message)) {
    try {
      const payload = await brainApp.searchBrain({
        query: message,
        limit
      });

      if (payload.total > 0) {
        return {
          intent: 'search',
          argument: message,
          route: 'fallback_search',
          saved: false,
          reply: formatSearchPayload(payload),
          payload
        };
      }
    } catch (_error) {
      // Fall through to the default unknown reply.
    }
  }

  return {
    intent: 'unknown',
    argument: message,
    route: resolved.route,
    saved: false,
    reply:
      'I did not save that. Ask a question, use a command, or say "save:" when you want a note captured.',
    payload: null
  };
}

module.exports = {
  parseAssistantCommand,
  classifyPlainTextHeuristically,
  classifyPlainTextWithInference,
  resolveAssistantIntent,
  answerMessage,
  formatDailyPayload,
  formatSearchPayload,
  formatLookupPayload,
  formatMatchPayload,
  formatStatusPayload,
  buildHelpText,
  stripAssistantPromptPrefix
};
