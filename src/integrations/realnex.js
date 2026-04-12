const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const DEFAULT_BASE_URL = 'https://sync.realnex.com';
const MAX_PAGE_SIZE = 50;

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function clampInteger(value, fallback, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  const parsed = Number.parseInt(String(value ?? ''), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function normalizeBaseUrl(value) {
  return cleanText(value, DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function resolveRealNexConfig(overrides = {}) {
  const token = cleanText(overrides.token ?? process.env.REALNEX_API_TOKEN, null);

  if (!token) {
    throw new Error('REALNEX_API_TOKEN is required');
  }

  const fetchImpl = overrides.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required');
  }

  return {
    token,
    baseUrl: normalizeBaseUrl(overrides.baseUrl ?? process.env.REALNEX_BASE_URL),
    pageSize: clampInteger(overrides.pageSize ?? process.env.REALNEX_PAGE_SIZE, 50, {
      min: 1,
      max: MAX_PAGE_SIZE
    }),
    timeoutMs: clampInteger(overrides.timeoutMs ?? process.env.REALNEX_TIMEOUT_MS, 30000, {
      min: 1000,
      max: 300000
    }),
    fetchImpl
  };
}

function buildUrl(baseUrl, apiPath, query = {}) {
  const normalizedBase = `${normalizeBaseUrl(baseUrl)}/`;
  const relativePath = String(apiPath || '').replace(/^\/+/, '');
  const url = new URL(relativePath, normalizedBase);

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url;
}

function createTimeoutSignal(timeoutMs) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return controller.signal;
}

async function readResponseBody(response) {
  const text = await response.text();

  if (text.trim() === '') {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    return text;
  }
}

function buildErrorMessage(body, status, fallback = 'RealNex request failed') {
  const error = body && typeof body === 'object' ? body.error : null;
  const message = cleanText(
    error?.message ?? error ?? body?.message ?? body?.detail ?? body,
    null
  );

  return message || `${fallback} (HTTP ${status})`;
}

async function requestJson(config, method, apiPath, { query = {}, body = undefined } = {}) {
  const url = buildUrl(config.baseUrl, apiPath, query);
  const headers = {
    authorization: `Bearer ${config.token}`,
    accept: 'application/json'
  };

  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const response = await config.fetchImpl(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: createTimeoutSignal(config.timeoutMs)
  });

  const payload = await readResponseBody(response);

  if (!response.ok) {
    throw new Error(buildErrorMessage(payload, response.status));
  }

  return payload ?? {};
}

function buildListQuery(top, skip, count) {
  return {
    $top: top,
    $skip: skip,
    ...(count ? { $count: 'true' } : {})
  };
}

function createRealNexClient(overrides = {}) {
  const config = resolveRealNexConfig(overrides);

  return {
    config: Object.freeze({
      baseUrl: config.baseUrl,
      pageSize: config.pageSize,
      timeoutMs: config.timeoutMs
    }),
    async listContacts({ top = config.pageSize, skip = 0, count = false } = {}) {
      return requestJson(config, 'GET', '/api/v1/CrmOData/Contacts', {
        query: buildListQuery(
          clampInteger(top, config.pageSize, { min: 1, max: MAX_PAGE_SIZE }),
          clampInteger(skip, 0, { min: 0 }),
          count
        )
      });
    },
    async listProperties({ top = config.pageSize, skip = 0, count = false } = {}) {
      return requestJson(config, 'GET', '/api/v1/CrmOData/Properties', {
        query: buildListQuery(
          clampInteger(top, config.pageSize, { min: 1, max: MAX_PAGE_SIZE }),
          clampInteger(skip, 0, { min: 0 }),
          count
        )
      });
    },
    async listCompanies({ top = config.pageSize, skip = 0, count = false } = {}) {
      return requestJson(config, 'GET', '/api/v1/CrmOData/Companies', {
        query: buildListQuery(
          clampInteger(top, config.pageSize, { min: 1, max: MAX_PAGE_SIZE }),
          clampInteger(skip, 0, { min: 0 }),
          count
        )
      });
    },
    async getContact(key) {
      const contactKey = cleanText(key, null);

      if (!contactKey) {
        throw new Error('contact key is required');
      }

      const payload = await requestJson(
        config,
        'GET',
        `/api/v1/Crm/contact/${encodeURIComponent(contactKey)}`
      );
      return {
        ...payload,
        Key: payload?.Key ?? contactKey,
        key: payload?.key ?? contactKey,
        kind: payload?.kind ?? 'contact'
      };
    },
    async getProperty(key) {
      const propertyKey = cleanText(key, null);

      if (!propertyKey) {
        throw new Error('property key is required');
      }

      const payload = await requestJson(
        config,
        'GET',
        `/api/v1/Crm/property/${encodeURIComponent(propertyKey)}`
      );
      return {
        ...payload,
        Key: payload?.Key ?? propertyKey,
        key: payload?.key ?? propertyKey,
        kind: payload?.kind ?? 'property'
      };
    },
    async getCompany(key) {
      const companyKey = cleanText(key, null);

      if (!companyKey) {
        throw new Error('company key is required');
      }

      const payload = await requestJson(
        config,
        'GET',
        `/api/v1/Crm/company/${encodeURIComponent(companyKey)}`
      );
      return {
        ...payload,
        Key: payload?.Key ?? companyKey,
        key: payload?.key ?? companyKey,
        kind: payload?.kind ?? 'company'
      };
    }
  };
}

module.exports = {
  createRealNexClient,
  normalizeBaseUrl,
  resolveRealNexConfig,
  MAX_PAGE_SIZE
};
