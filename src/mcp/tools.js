const brainApp = require('../app/brain');
const runtimeApp = require('../app/runtime');
const {
  createRealNexService,
  disambiguateLocalEntityAgainstRealNex
} = require('../app/realnex');
const assistantApp = require('../app/assistant');

const TOOLS = [
  {
    name: 'brain_answer',
    description:
      'Ask Soleil a natural-language question or instruction. Use this as the default assistant entrypoint for normal conversation, status checks, daily priorities, lookups, searches, matches, and explicit save requests.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Natural language request for Soleil' },
        limit: { type: 'number', description: 'Max items to use for search/match style answers', default: 5 },
        allowSave: { type: 'boolean', description: 'Whether explicit save/capture requests are allowed', default: true }
      },
      required: ['message']
    }
  },
  {
    name: 'brain_add',
    description:
      "Store new broker intelligence in the Second Brain. Use this only when the user is explicitly providing information to remember or save — buyer criteria, seller situation, relationship context, market insight, deal update, or other durable notes. Do not use this for questions, status checks, or casual chat.",
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What you want to add. Just talk naturally.' }
      },
      required: ['message']
    }
  },
  {
    name: 'brain_search',
    description:
      'Search the Second Brain when the user is asking a broad or fuzzy recall question across notes, buyer preferences, seller situations, property details, or market insights.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        limit: { type: 'number', description: 'Max results', default: 10 }
      },
      required: ['query']
    }
  },
  {
    name: 'brain_lookup',
    description:
      'Look up a specific person, company, LLC, or property when the user names a concrete entity or address. Returns profile, connected entities, properties, deals, and knowledge history.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Person name, company name, LLC name, or property address/APN' }
      },
      required: ['name']
    }
  },
  {
    name: 'brain_match',
    description:
      'Find matching buyers for a property or matching properties for a buyer when the user asks about fit, likely counterparties, or who matches a given profile or asset.',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: 'Property APN/address OR buyer name' }
      },
      required: ['identifier']
    }
  },
  {
    name: 'brain_daily',
    description:
      "Get today's prioritized action list: who to call, follow-ups, new matches, and overdue items.",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'brain_status',
    description:
      'Get live runtime status for Soleil, including database, ChromaDB, inference provider, and write-auth mode.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'brain_realnex_disambiguate',
    description:
      'Disambiguate a local person or company against RealNex CRM candidates. Use this when the user wants to connect a local entity to a likely RealNex contact or company record.',
    inputSchema: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'Optional local Soleil entity UUID' },
        name: { type: 'string', description: 'Person or company name' },
        email: { type: 'string', description: 'Known email address' },
        phone: { type: 'string', description: 'Known phone number' },
        company: { type: 'string', description: 'Known company name' },
        limit: { type: 'number', description: 'Max ranked matches to return', default: 5 },
        pageSize: { type: 'number', description: 'RealNex page size, capped at 50', default: 25 },
        contactLimit: { type: 'number', description: 'Max contact candidates to scan', default: 25 },
        companyLimit: { type: 'number', description: 'Max company candidates to scan', default: 25 }
      }
    }
  },
  {
    name: 'brain_realnex_sync',
    description:
      'Sync a person or company from RealNex into Soleil and create/update the linked local entity graph when the user wants the CRM record brought into the brain.',
    inputSchema: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'Optional local Soleil entity UUID' },
        name: { type: 'string', description: 'Person or company name' },
        email: { type: 'string', description: 'Known email address' },
        phone: { type: 'string', description: 'Known phone number' },
        company: { type: 'string', description: 'Known company name' },
        minScore: { type: 'number', description: 'Minimum acceptable RealNex match score', default: 72 },
        createKnowledge: { type: 'boolean', description: 'Whether to create a linked knowledge entry for the sync', default: true }
      }
    }
  }
];

function useHttpTransport() {
  return String(process.env.BRAIN_TRANSPORT || '')
    .trim()
    .toLowerCase() === 'http';
}

function getApiBaseUrl() {
  return process.env.BRAIN_API_URL || `http://localhost:${process.env.API_PORT || 3100}`;
}

async function callApi(method, endpoint, body) {
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

  return {
    ok: response.ok,
    status: response.status,
    payload
  };
}

async function callLocal(handler) {
  try {
    const payload = await handler();
    return {
      ok: true,
      status: 200,
      payload
    };
  } catch (error) {
    return {
      ok: false,
      status: error?.statusCode || 500,
      payload: {
        error: error.message
      }
    };
  }
}

async function callTool(name, args = {}) {
  if (useHttpTransport()) {
    switch (name) {
      case 'brain_answer':
        return callApi('POST', '/api/answer', {
          message: args.message,
          source: 'mcp',
          limit: args.limit,
          allowSave: args.allowSave
        });
      case 'brain_add':
        return callApi('POST', '/api/ingest', {
          message: args.message,
          source: 'mcp'
        });
      case 'brain_search':
        return callApi('POST', '/api/search', {
          query: args.query,
          limit: args.limit
        });
      case 'brain_lookup':
        return callApi('GET', `/api/entities/lookup?name=${encodeURIComponent(args.name)}`);
      case 'brain_match':
        return callApi('GET', `/api/match/${encodeURIComponent(args.identifier)}`);
      case 'brain_daily':
        return callApi('GET', '/api/daily');
      case 'brain_status':
        return callApi('GET', '/health');
      case 'brain_realnex_disambiguate':
        return callApi('POST', '/api/realnex/disambiguate', {
          entityId: args.entityId,
          name: args.name,
          email: args.email,
          phone: args.phone,
          company: args.company,
          limit: args.limit,
          pageSize: args.pageSize,
          contactLimit: args.contactLimit,
          companyLimit: args.companyLimit
        });
      case 'brain_realnex_sync':
        return callApi('POST', '/api/realnex/sync', {
          entityId: args.entityId,
          name: args.name,
          email: args.email,
          phone: args.phone,
          company: args.company,
          minScore: args.minScore,
          createKnowledge: args.createKnowledge
        });
      default:
        throw new Error(`Unknown MCP tool: ${name}`);
    }
  }

  switch (name) {
    case 'brain_answer':
      return callLocal(() =>
        assistantApp.answerMessage({
          message: args.message,
          source: 'mcp',
          surface: 'assistant',
          limit: args.limit,
          allowSave: args.allowSave
        })
      );
    case 'brain_add':
      return callLocal(() => brainApp.ingestMessage({ message: args.message, source: 'mcp' }));
    case 'brain_search':
      return callLocal(() => brainApp.searchBrain({ query: args.query, limit: args.limit }));
    case 'brain_lookup':
      return callLocal(() => brainApp.lookupBrain({ name: args.name }));
    case 'brain_match':
      return callLocal(() => brainApp.matchIdentifier({ identifier: args.identifier }));
    case 'brain_daily':
      return callLocal(() => brainApp.getDailyBrief());
    case 'brain_status':
      return callLocal(() => runtimeApp.getRuntimeStatus());
    case 'brain_realnex_disambiguate':
      return callLocal(async () => {
        const service = createRealNexService();
        return disambiguateLocalEntityAgainstRealNex(
          {
          entityId: args.entityId,
          name: args.name,
          email: args.email,
          phone: args.phone,
          company: args.company
          },
          {
            service,
            limit: args.limit,
            pageSize: args.pageSize,
            contactLimit: args.contactLimit,
            companyLimit: args.companyLimit
          }
        );
      });
    case 'brain_realnex_sync':
      return callLocal(() =>
        realNexApp.syncRealNexMatch(
          {
            entityId: args.entityId,
            name: args.name,
            email: args.email,
            phone: args.phone,
            company: args.company
          },
          {
            minScore: args.minScore,
            createKnowledge: args.createKnowledge
          }
        )
      );
    default:
      throw new Error(`Unknown MCP tool: ${name}`);
  }
}

module.exports = {
  TOOLS,
  callTool
};
