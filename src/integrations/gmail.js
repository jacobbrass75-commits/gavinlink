const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function decodeBase64Url(value) {
  const text = cleanText(value, '');

  if (!text) {
    return '';
  }

  const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  const paddingLength = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(`${normalized}${'='.repeat(paddingLength)}`, 'base64').toString('utf8');
}

function decodeHtmlEntities(value) {
  if (typeof value !== 'string') {
    return '';
  }

  const named = value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

  return named
    .replace(/&#(\d+);/g, (_match, codePoint) => String.fromCodePoint(Number(codePoint)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, codePoint) => String.fromCodePoint(parseInt(codePoint, 16)));
}

function stripHtml(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return decodeHtmlEntities(
    value
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<\/td>/gi, '\t')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function collectBodies(part, buckets = { text: [], html: [] }) {
  if (!part || typeof part !== 'object') {
    return buckets;
  }

  const mimeType = String(part.mimeType || '').toLowerCase();
  const bodyData = decodeBase64Url(part.body?.data);

  if (mimeType === 'text/plain' && bodyData) {
    buckets.text.push(bodyData);
  }

  if (mimeType === 'text/html' && bodyData) {
    buckets.html.push(bodyData);
  }

  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      collectBodies(child, buckets);
    }
  }

  return buckets;
}

function getMessageBodies(message) {
  const buckets = collectBodies(message?.payload);
  const html = buckets.html.join('\n').trim();
  const text = buckets.text.join('\n').trim();

  return {
    text: text || stripHtml(html),
    html
  };
}

function getHeaderValue(message, name) {
  const headers = Array.isArray(message?.payload?.headers) ? message.payload.headers : [];
  const match = headers.find((header) => String(header.name || '').toLowerCase() === String(name || '').toLowerCase());
  return cleanText(match?.value, null);
}

function getMessageMeta(message) {
  const internalDateMs = Number(message?.internalDate || 0);
  const headerDate = getHeaderValue(message, 'date');
  const parsedHeaderDate = headerDate ? new Date(headerDate) : null;
  const occurredAt = parsedHeaderDate && !Number.isNaN(parsedHeaderDate.getTime())
    ? parsedHeaderDate.toISOString()
    : internalDateMs > 0
      ? new Date(internalDateMs).toISOString()
      : null;

  return {
    id: message?.id || null,
    thread_id: message?.threadId || null,
    subject: getHeaderValue(message, 'subject'),
    message_id: getHeaderValue(message, 'message-id'),
    from: getHeaderValue(message, 'from'),
    occurred_at: occurredAt
  };
}

async function getAccessToken() {
  const staticToken = cleanText(process.env.GMAIL_ACCESS_TOKEN, null);

  if (staticToken) {
    return staticToken;
  }

  const clientId = cleanText(process.env.GMAIL_CLIENT_ID, null);
  const clientSecret = cleanText(process.env.GMAIL_CLIENT_SECRET, null);
  const refreshToken = cleanText(process.env.GMAIL_REFRESH_TOKEN, null);
  const tokenUrl = cleanText(process.env.GMAIL_TOKEN_URL, 'https://oauth2.googleapis.com/token');

  if (!clientId || !refreshToken) {
    throw new Error('GMAIL_CLIENT_ID and GMAIL_REFRESH_TOKEN are required for Gmail access');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });

  if (clientSecret) {
    body.set('client_secret', clientSecret);
  }

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded'
    },
    body,
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || `Failed to refresh Gmail access token (${response.status})`);
  }

  return payload.access_token;
}

async function gmailRequest(apiPath, query = {}) {
  const token = await getAccessToken();
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me${apiPath}`);

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, String(item));
      }
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`
    },
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error?.message || `Gmail API request failed (${response.status})`);
  }

  return payload;
}

async function listMessages({ q, maxResults = 25, pageToken, labelIds } = {}) {
  return gmailRequest('/messages', {
    q,
    maxResults,
    pageToken,
    labelIds
  });
}

async function getMessage(messageId, { format = 'full' } = {}) {
  if (!cleanText(messageId, null)) {
    throw new Error('messageId is required');
  }

  return gmailRequest(`/messages/${encodeURIComponent(messageId)}`, { format });
}

module.exports = {
  decodeBase64Url,
  decodeHtmlEntities,
  stripHtml,
  getMessageBodies,
  getMessageMeta,
  listMessages,
  getMessage
};
