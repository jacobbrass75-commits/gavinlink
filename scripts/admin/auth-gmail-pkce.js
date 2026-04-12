#!/usr/bin/env node

const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
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

function toBase64Url(value) {
  return value
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function buildPkcePair() {
  const verifier = toBase64Url(crypto.randomBytes(48));
  const challenge = toBase64Url(crypto.createHash('sha256').update(verifier).digest());

  return {
    verifier,
    challenge
  };
}

function getRedirectUri() {
  return cleanText(process.env.GMAIL_REDIRECT_URI, 'http://127.0.0.1:8787/oauth/google/callback');
}

function getPortFromRedirectUri(redirectUri) {
  const url = new URL(redirectUri);
  return Number(url.port || (url.protocol === 'https:' ? 443 : 80));
}

function getPathFromRedirectUri(redirectUri) {
  return new URL(redirectUri).pathname || '/';
}

function hasFlag(args, flagName) {
  return args.includes(flagName);
}

function getEnvFilePath() {
  return path.resolve(process.cwd(), '.env');
}

async function upsertEnvVar(filePath, key, value) {
  const nextLine = `${key}=${value}`;
  let existing = '';

  try {
    existing = await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const pattern = new RegExp(`^${key}=.*$`, 'm');
  let updated;

  if (pattern.test(existing)) {
    updated = existing.replace(pattern, nextLine);
  } else if (existing.trim() === '') {
    updated = `${nextLine}\n`;
  } else {
    updated = `${existing.replace(/\s*$/, '')}\n${nextLine}\n`;
  }

  await fs.promises.writeFile(filePath, updated, 'utf8');
}

function buildAuthUrl({ clientId, redirectUri, challenge, state }) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');

  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'https://www.googleapis.com/auth/gmail.readonly');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);

  return url.toString();
}

async function exchangeCodeForToken({ clientId, code, verifier, redirectUri }) {
  const tokenUrl = cleanText(process.env.GMAIL_TOKEN_URL, 'https://oauth2.googleapis.com/token');
  const clientSecret = cleanText(process.env.GMAIL_CLIENT_SECRET, null);
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
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

  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || `Failed to exchange auth code (${response.status})`);
  }

  return payload;
}

async function main() {
  const args = process.argv.slice(2);
  const printOnly = hasFlag(args, '--print-only');
  const clientId = cleanText(process.env.GMAIL_CLIENT_ID, null);

  if (!clientId) {
    throw new Error('GMAIL_CLIENT_ID is required');
  }

  const redirectUri = getRedirectUri();
  const port = getPortFromRedirectUri(redirectUri);
  const callbackPath = getPathFromRedirectUri(redirectUri);
  const state = crypto.randomUUID();
  const { verifier, challenge } = buildPkcePair();
  const authUrl = buildAuthUrl({
    clientId,
    redirectUri,
    challenge,
    state
  });

  console.log('Open this URL in your browser and complete consent:');
  console.log(authUrl);
  console.log('');
  console.log(`Waiting for OAuth callback on ${redirectUri} ...`);

  const tokenPayload = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, redirectUri);
        const code = cleanText(url.searchParams.get('code'), null);
        const returnedState = cleanText(url.searchParams.get('state'), null);
        const error = cleanText(url.searchParams.get('error'), null);

        if (url.pathname !== callbackPath) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Not found.\n');
          return;
        }

        if (error) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(`OAuth error: ${error}\n`);
          reject(new Error(`OAuth error: ${error}`));
          server.close();
          return;
        }

        if (!code) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Missing authorization code in OAuth callback.\n');
          return;
        }

        if (returnedState !== state) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('OAuth state mismatch.\n');
          reject(new Error('OAuth state mismatch in callback'));
          server.close();
          return;
        }

        const token = await exchangeCodeForToken({
          clientId,
          code,
          verifier,
          redirectUri
        });

        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Gmail OAuth completed. You can close this tab.\n');
        resolve(token);
        server.close();
      } catch (error) {
        try {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('OAuth exchange failed.\n');
        } catch (_responseError) {
          // Ignore response write issues.
        }

        reject(error);
        server.close();
      }
    });

    server.listen(port, '127.0.0.1');
    server.on('error', reject);
  });

  console.log('');
  console.log('Set these in your local .env:');
  console.log(`GMAIL_CLIENT_ID=${clientId}`);

  if (tokenPayload.refresh_token) {
    if (!printOnly) {
      await upsertEnvVar(getEnvFilePath(), 'GMAIL_REFRESH_TOKEN', tokenPayload.refresh_token);
      console.log(`Saved GMAIL_REFRESH_TOKEN to ${getEnvFilePath()}`);
    }

    console.log(`GMAIL_REFRESH_TOKEN=${tokenPayload.refresh_token}`);
  } else {
    console.log('# No refresh token was returned. Re-run and ensure prompt=consent is honored.');
  }

  if (tokenPayload.access_token) {
    console.log(`# Temporary access token: ${tokenPayload.access_token}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  hasFlag,
  getEnvFilePath,
  upsertEnvVar
};
