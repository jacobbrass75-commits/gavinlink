#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { startMCPServer } = require('../mcp/server');

function getApiBaseUrl() {
  return process.env.BRAIN_API_URL || `http://localhost:${process.env.API_PORT || 3100}`;
}

function printResult(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function apiRequest(method, endpoint, body) {
  const response = await fetch(`${getApiBaseUrl()}${endpoint}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || `API request failed with status ${response.status}`);
  }

  return payload;
}

async function postAudio(filePath) {
  const absolutePath = path.resolve(filePath);
  const fileBuffer = await fs.promises.readFile(absolutePath);
  const file = new File([fileBuffer], path.basename(absolutePath));
  const form = new FormData();

  form.append('audio', file);
  form.append('source', 'cli');

  const response = await fetch(`${getApiBaseUrl()}/api/ingest/audio`, {
    method: 'POST',
    body: form
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || `API request failed with status ${response.status}`);
  }

  return payload;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'add': {
      if (args[0] === '--audio') {
        const filePath = args[1];

        if (!filePath) {
          throw new Error('audio file path is required');
        }

        return printResult(await postAudio(filePath));
      }

      const message = args.join(' ').trim();

      if (!message) {
        throw new Error('message is required');
      }

      return printResult(
        await apiRequest('POST', '/api/ingest', {
          message,
          source: 'cli'
        })
      );
    }
    case 'search': {
      const query = args.join(' ').trim();

      if (!query) {
        throw new Error('query is required');
      }

      return printResult(await apiRequest('POST', '/api/search', { query }));
    }
    case 'lookup': {
      const name = args.join(' ').trim();

      if (!name) {
        throw new Error('name is required');
      }

      return printResult(
        await apiRequest('GET', `/api/entities/lookup?name=${encodeURIComponent(name)}`)
      );
    }
    case 'match': {
      const identifier = args.join(' ').trim();

      if (!identifier) {
        throw new Error('identifier is required');
      }

      return printResult(
        await apiRequest('GET', `/api/match/${encodeURIComponent(identifier)}`)
      );
    }
    case 'daily':
      return printResult(await apiRequest('GET', '/api/daily'));
    case 'serve':
      await startMCPServer();
      return undefined;
    default:
      throw new Error(
        'Usage: brain add <message> | brain add --audio <file> | brain search <query> | brain lookup <name> | brain match <identifier> | brain daily | brain serve'
      );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
