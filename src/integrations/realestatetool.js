const crypto = require('crypto');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function getBaseUrl() {
  const url = process.env.REALESTATETOOL_URL;

  if (!url) {
    throw new Error('REALESTATETOOL_URL is required to import from realestatetool');
  }

  return url;
}

function buildPayloads(toolName, params) {
  const id = crypto.randomUUID();

  return [
    {
      jsonrpc: '2.0',
      id,
      method: toolName,
      params
    },
    {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: params
      }
    }
  ];
}

function maybeParseJson(value) {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();

  if (trimmed === '') {
    return value;
  }

  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch (_error) {
      return value;
    }
  }

  return value;
}

function extractResultPayload(body) {
  if (!body) {
    throw new Error('Empty response from realestatetool');
  }

  if (body.error) {
    throw new Error(body.error.message || 'realestatetool returned an unknown RPC error');
  }

  const result = body.result ?? body;

  if (result == null) {
    throw new Error('realestatetool response did not include a result payload');
  }

  if (result && typeof result === 'object') {
    if (result.structuredContent && typeof result.structuredContent === 'object') {
      return result.structuredContent;
    }

    if (result.data && typeof result.data === 'object') {
      return result.data;
    }

    if (Array.isArray(result.content)) {
      for (const item of result.content) {
        const parsed = maybeParseJson(item?.text ?? item?.value ?? '');

        if (parsed && typeof parsed === 'object') {
          return parsed;
        }
      }
    }
  }

  return maybeParseJson(result);
}

async function postPayload(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  let body = null;

  if (text.trim() !== '') {
    try {
      body = JSON.parse(text);
    } catch (_error) {
      body = { result: text };
    }
  }

  if (!response.ok) {
    throw new Error(body?.error?.message || text || `HTTP ${response.status}`);
  }

  return body;
}

async function callRealEstateTool(toolName, params = {}) {
  const url = getBaseUrl();
  let lastError = null;

  for (const payload of buildPayloads(toolName, params)) {
    try {
      const responseBody = await postPayload(url, payload);
      return extractResultPayload(responseBody);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Failed to call realestatetool tool "${toolName}": ${lastError?.message || 'unknown error'}`
  );
}

async function* fetchAllProperties({ limit = 50, region = '' } = {}) {
  const pageSize = Math.max(1, Number(limit) || 50);
  let offset = 0;

  while (true) {
    const payload = await callRealEstateTool('search_properties', {
      limit: pageSize,
      offset,
      region
    });
    const results = Array.isArray(payload?.results)
      ? payload.results
      : Array.isArray(payload)
        ? payload
        : [];

    if (results.length === 0) {
      return;
    }

    yield results;

    offset += results.length;

    if (results.length < pageSize) {
      return;
    }

    const total = Number(payload?.total || 0);

    if (total > 0 && offset >= total) {
      return;
    }
  }
}

async function fetchProperty(apn) {
  if (typeof apn !== 'string' || apn.trim() === '') {
    throw new Error('apn must be a non-empty string');
  }

  const payload = await callRealEstateTool('get_property', { apn: apn.trim() });

  if (!payload) {
    return null;
  }

  if (Array.isArray(payload?.results)) {
    return payload.results[0] || null;
  }

  return payload;
}

async function fetchStats(region = '') {
  return callRealEstateTool('get_property_stats', region ? { region } : {});
}

module.exports = {
  fetchAllProperties,
  fetchProperty,
  fetchStats
};
