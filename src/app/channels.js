const DEFAULT_MESSAGE_KEYS = [
  'message',
  'text',
  'content',
  'body',
  'transcript',
  'note',
  'summary',
  'description',
  'caption',
  'title',
  'subject',
  'message_text',
  'plain_text',
  'utterance'
];

const DEFAULT_META_KEYS = {
  messageId: ['message_id', 'messageId', 'id', 'event_id', 'eventId', 'uuid', 'external_id'],
  conversationId: ['conversation_id', 'conversationId', 'thread_id', 'threadId', 'session_id', 'sessionId', 'channel_id', 'channelId'],
  timestamp: ['occurred_at', 'timestamp', 'created_at', 'createdAt', 'sent_at', 'sentAt', 'received_at', 'receivedAt', 'started_at', 'startedAt'],
  eventType: ['event_type', 'eventType', 'type', 'kind', 'event'],
  source: ['source', 'origin', 'provider', 'channel', 'app'],
  subject: ['subject', 'title', 'headline'],
  summary: ['summary', 'abstract', 'preview'],
  tags: ['tags', 'labels', 'topics', 'keywords']
};

const MESSAGE_CONTAINER_KEYS = new Set([
  'message',
  'text',
  'content',
  'body',
  'transcript',
  'note',
  'summary',
  'description',
  'caption',
  'title',
  'subject',
  'message_text',
  'plain_text',
  'utterance',
  'prompt',
  'details',
  'data',
  'payload',
  'event',
  'record'
]);

const MESSAGE_SCALAR_FALLBACK_KEYS = new Set([
  'kind',
  'type',
  'event_type',
  'eventType',
  'status',
  'source',
  'provider',
  'channel',
  'id',
  'uuid',
  'external_id',
  'message_id',
  'conversation_id',
  'timestamp',
  'created_at',
  'updated_at'
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function toArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (value === undefined || value === null) {
    return [];
  }

  return [value];
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value === 'string') {
      const cleaned = cleanText(value, null);
      if (cleaned) {
        return cleaned;
      }
    }
  }

  return null;
}

function readPath(root, path) {
  if (!path) {
    return undefined;
  }

  const segments = Array.isArray(path) ? path : String(path).split('.');
  let current = root;

  for (const segment of segments) {
    if (!isPlainObject(current) && !Array.isArray(current)) {
      return undefined;
    }

    current = current?.[segment];

    if (current === undefined || current === null) {
      return current;
    }
  }

  return current;
}

function readFirstPath(root, paths) {
  for (const path of paths) {
    const value = readPath(root, path);
    if (value !== undefined && value !== null) {
      return value;
    }
  }

  return undefined;
}

function findFirstField(value, keys, seen = new WeakSet()) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstField(item, keys, seen);
      if (found !== undefined && found !== null) {
        return found;
      }
    }

    return undefined;
  }

  if (!isPlainObject(value)) {
    return undefined;
  }

  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const candidate = value[key];
      if (candidate !== undefined && candidate !== null) {
        return candidate;
      }
    }
  }

  for (const [key, candidate] of Object.entries(value)) {
    if (!MESSAGE_CONTAINER_KEYS.has(key)) {
      continue;
    }

    const found = findFirstField(candidate, keys, seen);
    if (found !== undefined && found !== null) {
      return found;
    }
  }

  return undefined;
}

function cleanArray(values) {
  return toArray(values)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => cleanText(typeof value === 'string' ? value : String(value ?? ''), null))
    .filter(Boolean);
}

function uniqueStrings(values) {
  return [...new Set(cleanArray(values))];
}

function asIsoTimestamp(value) {
  const text = pickFirstString(typeof value === 'string' ? value : null);
  if (!text) {
    return null;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function extractTimestamp(payload) {
  const raw = readFirstPath(payload, DEFAULT_META_KEYS.timestamp);
  return asIsoTimestamp(raw);
}

function extractMessageId(payload) {
  return pickFirstString(findFirstField(payload, DEFAULT_META_KEYS.messageId));
}

function extractConversationId(payload) {
  return pickFirstString(findFirstField(payload, DEFAULT_META_KEYS.conversationId));
}

function extractSource(payload, fallback) {
  const source = pickFirstString(findFirstField(payload, DEFAULT_META_KEYS.source));
  return source || fallback;
}

function extractEventType(payload, fallback = 'webhook') {
  return pickFirstString(findFirstField(payload, DEFAULT_META_KEYS.eventType)) || fallback;
}

function extractSubject(payload) {
  return pickFirstString(findFirstField(payload, DEFAULT_META_KEYS.subject));
}

function extractSummary(payload) {
  return pickFirstString(findFirstField(payload, DEFAULT_META_KEYS.summary));
}

function extractTags(payload) {
  const tags = uniqueStrings(DEFAULT_META_KEYS.tags.map((key) => findFirstField(payload, [key])));
  return tags.length > 0 ? tags : [];
}

function normalizeActor(actor) {
  if (!isPlainObject(actor)) {
    const name = cleanText(actor, null);
    return name ? { name } : null;
  }

  const name = pickFirstString(actor.name, actor.full_name, actor.fullName, actor.display_name, actor.displayName);
  const id = pickFirstString(actor.id, actor.user_id, actor.userId, actor.contact_id, actor.contactId);
  const email = pickFirstString(actor.email, actor.email_address, actor.emailAddress);
  const phone = pickFirstString(actor.phone, actor.phone_number, actor.phoneNumber, actor.mobile);
  const type = pickFirstString(actor.type, actor.role, actor.kind);

  if (!name && !id && !email && !phone && !type) {
    return null;
  }

  return {
    ...(name ? { name } : {}),
    ...(id ? { id } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(type ? { type } : {})
  };
}

function extractActor(payload) {
  const candidate = findFirstField(payload, ['actor', 'user', 'sender', 'from', 'author', 'device', 'contact', 'profile']);
  if (candidate === undefined || candidate === null) {
    return null;
  }

  return normalizeActor(candidate);
}

function extractAttachments(payload) {
  const attachments = readFirstPath(payload, ['attachments', 'files', 'media', 'documents', 'images']);
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments.filter((item) => item !== undefined && item !== null);
}

function flattenStringPayload(value) {
  if (typeof value === 'string') {
    return cleanText(value, null);
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => flattenStringPayload(item))
      .filter(Boolean);
    return parts.length > 0 ? parts.join('\n') : null;
  }

  if (!isPlainObject(value)) {
    return null;
  }

  const valueField = pickFirstString(value.value, value.text, value.content, value.body);
  if (valueField) {
    return valueField;
  }

  return null;
}

function collectCandidateStrings(value, seen = new WeakSet()) {
  if (value === undefined || value === null) {
    return [];
  }

  if (typeof value === 'string') {
    const cleaned = cleanText(value, null);
    return cleaned ? [cleaned] : [];
  }

  if (typeof value !== 'object') {
    return [];
  }

  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectCandidateStrings(item, seen));
  }

  for (const key of DEFAULT_MESSAGE_KEYS) {
    if (key in value) {
      const candidate = value[key];
      const normalized = flattenStringPayload(candidate);
      if (normalized) {
        return [normalized];
      }

      const nested = collectCandidateStrings(candidate, seen);
      if (nested.length > 0) {
        return nested;
      }
    }
  }

  for (const [key, candidate] of Object.entries(value)) {
    if (MESSAGE_SCALAR_FALLBACK_KEYS.has(key)) {
      continue;
    }

    if (isPlainObject(candidate) || Array.isArray(candidate)) {
      const nested = collectCandidateStrings(candidate, seen);
      if (nested.length > 0) {
        return nested;
      }
    }
  }

  return [];
}

function extractBodyText(payload) {
  const direct = flattenStringPayload(payload);
  if (direct) {
    return direct;
  }

  const candidates = collectCandidateStrings(payload);
  return candidates.find(Boolean) || null;
}

function buildMessageText(payload) {
  const message = extractBodyText(payload);
  if (message) {
    return message;
  }

  const subject = extractSubject(payload);
  const summary = extractSummary(payload);
  const fallbackParts = [subject, summary].filter(Boolean);
  return fallbackParts.length > 0 ? fallbackParts.join('\n\n') : null;
}

function normalizeWebhookPayload(payload, defaults = {}) {
  const rawPayload = payload === undefined ? null : payload;
  const sourceFallback = defaults.channel || defaults.provider || 'webhook';
  const channel = cleanText(defaults.channel, sourceFallback) || sourceFallback;
  const provider = cleanText(defaults.provider, channel) || channel;
  const message = buildMessageText(rawPayload);
  const source =
    Object.prototype.hasOwnProperty.call(defaults, 'source') && defaults.source != null
      ? cleanText(defaults.source, sourceFallback) || sourceFallback
      : extractSource(rawPayload, sourceFallback);
  const eventType =
    Object.prototype.hasOwnProperty.call(defaults, 'eventType') && defaults.eventType != null
      ? cleanText(defaults.eventType, 'webhook') || 'webhook'
      : extractEventType(rawPayload, defaults.eventType || 'webhook');
  const subject = extractSubject(rawPayload);
  const summary = extractSummary(rawPayload);
  const tags = extractTags(rawPayload);
  const actor = extractActor(rawPayload);
  const attachments = extractAttachments(rawPayload);
  const metadata = {
    channel,
    provider,
    source,
    event_type: eventType,
    message_id: extractMessageId(rawPayload),
    conversation_id: extractConversationId(rawPayload),
    occurred_at: extractTimestamp(rawPayload),
    subject,
    summary,
    tags,
    actor,
    attachments_count: attachments.length,
    payload_type: Array.isArray(rawPayload) ? 'array' : typeof rawPayload,
    raw_keys: isPlainObject(rawPayload) ? Object.keys(rawPayload) : []
  };

  return {
    channel,
    provider,
    source,
    event_type: eventType,
    message,
    subject,
    summary,
    message_id: metadata.message_id,
    conversation_id: metadata.conversation_id,
    occurred_at: metadata.occurred_at,
    actor,
    tags,
    attachments,
    metadata,
    raw: rawPayload
  };
}

function normalizeOmiPayload(payload, defaults = {}) {
  return normalizeWebhookPayload(payload, {
    channel: 'omi',
    provider: 'omi',
    ...(Object.prototype.hasOwnProperty.call(defaults, 'source') ? { source: defaults.source } : {}),
    ...(Object.prototype.hasOwnProperty.call(defaults, 'eventType') ? { eventType: defaults.eventType } : {}),
    ...defaults
  });
}

function normalizeHermesPayload(payload, defaults = {}) {
  return normalizeWebhookPayload(payload, {
    channel: 'hermes',
    provider: 'hermes',
    ...(Object.prototype.hasOwnProperty.call(defaults, 'source') ? { source: defaults.source } : {}),
    ...(Object.prototype.hasOwnProperty.call(defaults, 'eventType') ? { eventType: defaults.eventType } : {}),
    ...defaults
  });
}

function normalizeVermesPayload(payload, defaults = {}) {
  return normalizeWebhookPayload(payload, {
    channel: 'vermes',
    provider: 'vermes',
    ...(Object.prototype.hasOwnProperty.call(defaults, 'source') ? { source: defaults.source } : {}),
    ...(Object.prototype.hasOwnProperty.call(defaults, 'eventType') ? { eventType: defaults.eventType } : {}),
    ...defaults
  });
}

function buildChannelIngestMessage(normalized = {}) {
  const lines = [];

  if (normalized.subject && normalized.subject !== normalized.message) {
    lines.push(`Subject: ${normalized.subject}`);
  }

  if (normalized.message) {
    lines.push(normalized.message);
  }

  return lines.filter(Boolean).join('\n');
}

function looksLikeAssistantRequest(normalized = {}) {
  const channel = cleanText(normalized.channel, '').toLowerCase();
  const message = cleanText(normalized.message, '');
  const eventType = cleanText(normalized.event_type, '').toLowerCase();
  const subject = cleanText(normalized.subject, '').toLowerCase();
  const mode = cleanText(normalized?.metadata?.mode, '').toLowerCase();
  const intent = cleanText(normalized?.metadata?.intent, '').toLowerCase();

  if (!message || channel === 'omi') {
    return false;
  }

  if (mode === 'assistant' || intent === 'assistant' || intent === 'ask') {
    return true;
  }

  if (eventType === 'assistant.request' || eventType === 'assistant_query') {
    return true;
  }

  if (subject === 'assistant' || subject === 'soleil') {
    return true;
  }

  return /^(\/|ask:|question:|assistant:|soleil:|@soleil\b)/i.test(message);
}

async function callIngestFn(ingestFn, normalized, options = {}) {
  if (typeof ingestFn !== 'function') {
    return null;
  }

  return ingestFn(
    {
      message: normalized.message,
      source: normalized.source,
      metadata: normalized.metadata,
      raw: normalized.raw,
      channel: normalized.channel
    },
    normalized,
    options
  );
}

function createChannelService({ ingestFn = null } = {}) {
  async function ingestNormalized(normalized, options = {}) {
    const effectiveIngestFn =
      typeof options.ingestFn === 'function' ? options.ingestFn : ingestFn;
    const ingestResult = await callIngestFn(effectiveIngestFn, normalized, options);

    return {
      ...normalized,
      ingest_result: ingestResult
    };
  }

  return {
    normalizeWebhookPayload,
    normalizeOmiPayload,
    normalizeHermesPayload,
    async ingestChannelPayload(channel, payload, options = {}) {
      const normalized = normalizeWebhookPayload(payload, {
        channel,
        provider: options.provider || channel,
        source: options.source || channel,
        eventType: options.eventType || 'webhook'
      });

      return ingestNormalized(normalized, options);
    },
    async ingestOmiPayload(payload, options = {}) {
      const normalized = normalizeOmiPayload(payload, options);
      return ingestNormalized(normalized, options);
    },
    async ingestHermesPayload(payload, options = {}) {
      const normalized = normalizeHermesPayload(payload, options);
      return ingestNormalized(normalized, options);
    },
    async ingestVermesPayload(payload, options = {}) {
      const normalized = normalizeVermesPayload(payload, options);
      return ingestNormalized(normalized, options);
    }
  };
}

module.exports = {
  createChannelService,
  buildChannelIngestMessage,
  looksLikeAssistantRequest,
  normalizeWebhookPayload,
  normalizeOmiPayload,
  normalizeHermesPayload,
  normalizeVermesPayload
};
