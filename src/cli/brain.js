#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { startMCPServer } = require('../mcp/server');
const brainApp = require('../app/brain');
const { promoteKnowledgeEntry } = require('../wiki/promote');
const { lintWiki } = require('../wiki/lint');
const { processAutoPromoteQueue } = require('../wiki/queue');

function getApiBaseUrl() {
  return process.env.BRAIN_API_URL || `http://localhost:${process.env.API_PORT || 3100}`;
}

function printResult(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function useHttpTransport() {
  return String(process.env.BRAIN_TRANSPORT || '')
    .trim()
    .toLowerCase() === 'http';
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
  if (!useHttpTransport()) {
    return brainApp.ingestAudio({
      filePath,
      source: 'cli'
    });
  }

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

async function postDocument(propertyId, filePath, options = {}) {
  const absolutePath = path.resolve(filePath);
  const fileBuffer = await fs.promises.readFile(absolutePath);
  const file = new File([fileBuffer], path.basename(absolutePath));
  const form = new FormData();

  form.append('document', file);
  form.append('source', options.source || 'cli');

  if (options.documentType) {
    form.append('document_type', options.documentType);
  }

  if (options.notes) {
    form.append('notes', options.notes);
  }

  if (options.autoPromote !== undefined) {
    form.append('auto_promote', String(options.autoPromote));
  }

  if (options.queuePromotion !== undefined) {
    form.append('queue_promotion', String(options.queuePromotion));
  }

  if (options.createKnowledgeEntry !== undefined) {
    form.append('create_knowledge_entry', String(options.createKnowledgeEntry));
  }

  const headers = {};

  if (process.env.ADMIN_API_KEY) {
    headers['x-api-key'] = process.env.ADMIN_API_KEY;
  }

  const response = await fetch(`${getApiBaseUrl()}/api/properties/${encodeURIComponent(propertyId)}/documents`, {
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

async function autoPromoteCommand(args) {
  const limitOption = parseOption(args, '--limit');
  const dryRun = hasFlag(args, '--dry-run');
  const result = await processAutoPromoteQueue({
    limit: limitOption.value ? Number(limitOption.value) : 10,
    dryRun
  });

  printResult(result);

  if (result.failed > 0) {
    process.exitCode = 1;
  }
}

async function promoteDocumentCommand(args) {
  const propertyId = args[0];
  const filePath = args[1];

  if (!propertyId) {
    throw new Error('property id is required');
  }

  if (!filePath) {
    throw new Error('document file path is required');
  }

  const documentTypeOption = parseOption(args.slice(2), '--document-type');
  const notesOption = parseOption(documentTypeOption.rest, '--notes');
  const queueOnly = hasFlag(notesOption.rest, '--queue-only');

  return printResult(
    await postDocument(propertyId, filePath, {
      documentType: documentTypeOption.value,
      notes: notesOption.value,
      autoPromote: !queueOnly,
      queuePromotion: true,
      createKnowledgeEntry: true,
      source: 'cli'
    })
  );
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
        useHttpTransport()
          ? await apiRequest('POST', '/api/ingest', {
              message,
              source: 'cli'
            })
          : await brainApp.ingestMessage({
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

      return printResult(
        useHttpTransport()
          ? await apiRequest('POST', '/api/search', { query })
          : await brainApp.searchBrain({ query })
      );
    }
    case 'lookup': {
      const name = args.join(' ').trim();

      if (!name) {
        throw new Error('name is required');
      }

      return printResult(
        useHttpTransport()
          ? await apiRequest('GET', `/api/entities/lookup?name=${encodeURIComponent(name)}`)
          : await brainApp.lookupBrain({ name })
      );
    }
    case 'match': {
      const identifier = args.join(' ').trim();

      if (!identifier) {
        throw new Error('identifier is required');
      }

      return printResult(
        useHttpTransport()
          ? await apiRequest('GET', `/api/match/${encodeURIComponent(identifier)}`)
          : await brainApp.matchIdentifier({ identifier })
      );
    }
    case 'daily':
      return printResult(
        useHttpTransport() ? await apiRequest('GET', '/api/daily') : await brainApp.getDailyBrief()
      );
    case 'promote':
      return promoteCommand(args);
    case 'promote-document':
      return promoteDocumentCommand(args);
    case 'autopromote':
      return autoPromoteCommand(args);
    case 'lint':
      return lintCommand(args);
    case 'serve':
      await startMCPServer();
      return undefined;
    default:
      throw new Error(
        'Usage: brain add <message> | brain add --audio <file> | brain search <query> | brain lookup <name> | brain match <identifier> | brain daily | brain promote <knowledge-entry-id> [--page wiki/...md] [--title "..."] | brain promote-document <property-id> <file> [--document-type type] [--notes text] [--queue-only] | brain autopromote [--limit N] [--dry-run] | brain lint [--offline] | brain serve'
      );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
