#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { startMCPServer } = require('../mcp/server');
const { promoteKnowledgeEntry } = require('../wiki/promote');
const { lintWiki } = require('../wiki/lint');

function getApiBaseUrl() {
  return process.env.BRAIN_API_URL || `http://localhost:${process.env.API_PORT || 3100}`;
}

function printResult(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function apiRequest(method, endpoint, body) {
  const headers = body ? { 'content-type': 'application/json' } : {};

  if (process.env.ADMIN_API_KEY) {
    headers['x-api-key'] = process.env.ADMIN_API_KEY;
  }

  const response = await fetch(`${getApiBaseUrl()}${endpoint}`, {
    method,
    headers,
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
  const headers = {};

  if (process.env.ADMIN_API_KEY) {
    headers['x-api-key'] = process.env.ADMIN_API_KEY;
  }

  const response = await fetch(`${getApiBaseUrl()}/api/ingest/audio`, {
    method: 'POST',
    headers,
    body: form
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || `API request failed with status ${response.status}`);
  }

  return payload;
}

function parseOption(args, flagName) {
  const index = args.indexOf(flagName);

  if (index === -1) {
    return { value: null, rest: [...args] };
  }

  const value = args[index + 1] || null;
  const rest = [...args.slice(0, index), ...args.slice(index + 2)];
  return { value, rest };
}

function hasFlag(args, flagName) {
  return args.includes(flagName);
}

async function promoteCommand(args) {
  const knowledgeEntryId = args[0];

  if (!knowledgeEntryId) {
    throw new Error('knowledge entry id is required');
  }

  const pageOption = parseOption(args.slice(1), '--page');
  const titleOption = parseOption(pageOption.rest, '--title');
  const entry = await apiRequest('GET', `/api/knowledge/${encodeURIComponent(knowledgeEntryId)}`);
  const result = await promoteKnowledgeEntry(entry, {
    page: pageOption.value,
    title: titleOption.value
  });

  return printResult(result);
}

async function lintCommand(args) {
  const offline = hasFlag(args, '--offline');
  const result = await lintWiki({
    resolveKnowledgeEntry: offline
      ? null
      : async (knowledgeEntryId) => {
          try {
            return await apiRequest('GET', `/api/knowledge/${encodeURIComponent(knowledgeEntryId)}`);
          } catch (_error) {
            return null;
          }
        }
  });

  printResult(result);

  if (result.errors > 0) {
    process.exitCode = 1;
  }
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
    case 'promote':
      return promoteCommand(args);
    case 'lint':
      return lintCommand(args);
    case 'serve':
      await startMCPServer();
      return undefined;
    default:
      throw new Error(
        'Usage: brain add <message> | brain add --audio <file> | brain search <query> | brain lookup <name> | brain match <identifier> | brain daily | brain promote <knowledge-entry-id> [--page wiki/...md] [--title "..."] | brain lint [--offline] | brain serve'
      );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
