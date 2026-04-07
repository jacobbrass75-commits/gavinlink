const TOOLS = [
  {
    name: 'brain_add',
    description:
      "Add any information to the Second Brain. Just describe what you know in plain English — a buyer's criteria, a seller's situation, a relationship between people, a market observation, a deal update, or any context. The system automatically extracts entities, classifies the information, stores it, and runs matching if relevant.",
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
      'Search everything in the Second Brain — call notes, buyer preferences, seller situations, property details, market insights. Uses semantic search.',
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
      'Look up everything about a person, company, LLC, or property. Returns full profile, connected entities, properties, deals, and conversation history.',
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
    description: 'Find matching buyers for a property or matching properties for a buyer.',
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
      "Get today's prioritized action list: who to call, follow-ups, new matches, overdue items.",
    inputSchema: { type: 'object', properties: {} }
  }
];

function getApiBaseUrl() {
  return process.env.BRAIN_API_URL || `http://localhost:${process.env.API_PORT || 3100}`;
}

async function callApi(method, endpoint, body) {
  const response = await fetch(`${getApiBaseUrl()}${endpoint}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });

  const payload = await response.json();

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      payload
    };
  }

  return {
    ok: true,
    status: response.status,
    payload
  };
}

async function callTool(name, args = {}) {
  switch (name) {
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
    default:
      throw new Error(`Unknown MCP tool: ${name}`);
  }
}

module.exports = {
  TOOLS,
  callTool
};
