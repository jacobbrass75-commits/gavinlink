const packageJson = require('../../package.json');
const { TOOLS, callTool } = require('./tools');

async function createMCPServer() {
  const [{ McpServer }, { StdioServerTransport }, z] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('@modelcontextprotocol/sdk/server/stdio.js'),
    import('zod/v4')
  ]);
  const server = new McpServer({
    name: 'isg-second-brain',
    version: packageJson.version
  });

  server.registerTool(
    'brain_add',
    {
      description: TOOLS.find((tool) => tool.name === 'brain_add').description,
      inputSchema: {
        message: z.string().describe('What you want to add. Just talk naturally.')
      }
    },
    async ({ message }) => {
      const result = await callTool('brain_add', { message });
      return {
        content: [{ type: 'text', text: JSON.stringify(result.payload, null, 2) }],
        structuredContent: result.payload
      };
    }
  );

  server.registerTool(
    'brain_search',
    {
      description: TOOLS.find((tool) => tool.name === 'brain_search').description,
      inputSchema: {
        query: z.string().describe('Natural language search query'),
        limit: z.number().optional()
      }
    },
    async ({ query, limit }) => {
      const result = await callTool('brain_search', { query, limit });
      return {
        content: [{ type: 'text', text: JSON.stringify(result.payload, null, 2) }],
        structuredContent: result.payload
      };
    }
  );

  server.registerTool(
    'brain_lookup',
    {
      description: TOOLS.find((tool) => tool.name === 'brain_lookup').description,
      inputSchema: {
        name: z.string().describe('Person name, company name, LLC name, or property address/APN')
      }
    },
    async ({ name }) => {
      const result = await callTool('brain_lookup', { name });
      return {
        content: [{ type: 'text', text: JSON.stringify(result.payload, null, 2) }],
        structuredContent: result.payload
      };
    }
  );

  server.registerTool(
    'brain_match',
    {
      description: TOOLS.find((tool) => tool.name === 'brain_match').description,
      inputSchema: {
        identifier: z.string().describe('Property APN/address OR buyer name')
      }
    },
    async ({ identifier }) => {
      const result = await callTool('brain_match', { identifier });
      return {
        content: [{ type: 'text', text: JSON.stringify(result.payload, null, 2) }],
        structuredContent: result.payload
      };
    }
  );

  server.registerTool(
    'brain_daily',
    {
      description: TOOLS.find((tool) => tool.name === 'brain_daily').description,
      inputSchema: {}
    },
    async () => {
      const result = await callTool('brain_daily', {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result.payload, null, 2) }],
        structuredContent: result.payload
      };
    }
  );

  server.registerTool(
    'brain_status',
    {
      description: TOOLS.find((tool) => tool.name === 'brain_status').description,
      inputSchema: {}
    },
    async () => {
      const result = await callTool('brain_status', {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result.payload, null, 2) }],
        structuredContent: result.payload
      };
    }
  );

  server.registerTool(
    'brain_realnex_disambiguate',
    {
      description: TOOLS.find((tool) => tool.name === 'brain_realnex_disambiguate').description,
      inputSchema: {
        entityId: z.string().optional(),
        name: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        company: z.string().optional(),
        limit: z.number().optional(),
        pageSize: z.number().optional(),
        contactLimit: z.number().optional(),
        companyLimit: z.number().optional()
      }
    },
    async (args) => {
      const result = await callTool('brain_realnex_disambiguate', args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result.payload, null, 2) }],
        structuredContent: result.payload
      };
    }
  );

  return {
    server,
    transport: new StdioServerTransport()
  };
}

async function startMCPServer() {
  const { server, transport } = await createMCPServer();
  await server.connect(transport);
  return server;
}

if (require.main === module) {
  startMCPServer().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  startMCPServer,
  createMCPServer
};
