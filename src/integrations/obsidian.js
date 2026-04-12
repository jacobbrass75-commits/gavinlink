const http = require('http');
const https = require('https');

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function getObsidianBaseUrl() {
  return cleanText(process.env.OBSIDIAN_API_URL, 'https://127.0.0.1:27124');
}

function shouldAllowInsecureTls() {
  const configured = cleanText(process.env.OBSIDIAN_ALLOW_INSECURE_TLS, 'true');
  return configured.toLowerCase() !== 'false';
}

function getObsidianApiKey() {
  const apiKey = cleanText(process.env.OBSIDIAN_API_KEY, null);

  if (!apiKey) {
    throw new Error('OBSIDIAN_API_KEY is required for Obsidian access');
  }

  return apiKey;
}

function normalizeVaultPath(vaultPath) {
  const normalized = String(vaultPath || '')
    .replace(/^\/+/, '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .trim();

  if (normalized === '') {
    return '';
  }

  return normalized
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/');
}

function buildVaultApiPath(vaultPath = '') {
  const normalizedPath = normalizeVaultPath(vaultPath);

  if (normalizedPath === '') {
    return '/vault/';
  }

  return `/vault/${normalizedPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
}

function parseJsonSafely(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

async function obsidianRequest(method, vaultPath, options = {}) {
  const baseUrl = new URL(getObsidianBaseUrl());
  const client = baseUrl.protocol === 'http:' ? http : https;
  const requestPath = buildVaultApiPath(vaultPath);
  const body = options.body == null ? null : String(options.body);
  const headers = {
    Authorization: `Bearer ${getObsidianApiKey()}`,
    ...(options.accept ? { Accept: options.accept } : {}),
    ...(body !== null
      ? {
          'Content-Type': options.contentType || 'text/markdown',
          'Content-Length': Buffer.byteLength(body)
        }
      : {})
  };

  const requestOptions = {
    protocol: baseUrl.protocol,
    hostname: baseUrl.hostname,
    port: baseUrl.port ? Number(baseUrl.port) : baseUrl.protocol === 'https:' ? 443 : 80,
    method,
    path: requestPath,
    headers,
    timeout: Number(options.timeoutMs) || 15000,
    ...(baseUrl.protocol === 'https:' && shouldAllowInsecureTls() ? { rejectUnauthorized: false } : {})
  };

  const response = await new Promise((resolve, reject) => {
    const req = client.request(requestOptions, (res) => {
      const chunks = [];

      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 500,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`Obsidian request timed out for ${requestPath}`));
    });

    if (body !== null) {
      req.write(body);
    }

    req.end();
  });

  if (response.status >= 400) {
    const json = parseJsonSafely(response.body);
    const error = new Error(json?.message || `Obsidian request failed with status ${response.status}`);
    error.statusCode = response.status;
    error.payload = json || response.body;
    throw error;
  }

  return response;
}

async function listVaultFiles() {
  const response = await obsidianRequest('GET', '', {
    accept: 'application/json'
  });
  const payload = parseJsonSafely(response.body) || {};
  return Array.isArray(payload.files) ? payload.files : [];
}

async function readVaultFile(vaultPath) {
  const response = await obsidianRequest('GET', vaultPath, {
    accept: 'text/markdown, text/plain, application/json'
  });
  return response.body;
}

async function writeVaultFile(vaultPath, content, options = {}) {
  const normalizedPath = normalizeVaultPath(vaultPath);

  if (!normalizedPath) {
    throw new Error('vaultPath is required');
  }

  await obsidianRequest('PUT', normalizedPath, {
    body: content,
    contentType: options.contentType || 'text/markdown'
  });

  return {
    path: normalizedPath,
    bytes: Buffer.byteLength(String(content || ''))
  };
}

module.exports = {
  getObsidianBaseUrl,
  normalizeVaultPath,
  buildVaultApiPath,
  listVaultFiles,
  readVaultFile,
  writeVaultFile
};
