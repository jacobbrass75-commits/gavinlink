const net = require('net');
const packageJson = require('../../package.json');
const db = require('../db/connection');
const inferenceProvider = require('../inference/provider');

const CORE_TABLES = [
  'entities',
  'entity_relationships',
  'properties',
  'buyer_profiles',
  'seller_profiles',
  'knowledge_entries',
  'matches',
  'deals'
];

function isPortOpen(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    function finish(value) {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(value);
      }
    }

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
    socket.connect(port, host);
  });
}

async function getDatabaseStatus() {
  try {
    await db.query('SELECT 1');
    const [tableCountResult, totalTableCountResult] = await Promise.all([
      db.query(
        `
          SELECT COUNT(*)::int AS count
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = ANY($1::text[])
        `,
        [CORE_TABLES]
      ),
      db.query(
        `
          SELECT COUNT(*)::int AS count
          FROM information_schema.tables
          WHERE table_schema = 'public'
        `
      )
    ]);

    return {
      connected: true,
      tables: Number(tableCountResult.rows[0].count),
      tables_total: Number(totalTableCountResult.rows[0].count)
    };
  } catch (_error) {
    return {
      connected: false,
      tables: 0,
      tables_total: 0
    };
  }
}

function getWriteAuthMode() {
  const keyConfigured = typeof process.env.ADMIN_API_KEY === 'string' && process.env.ADMIN_API_KEY.trim() !== '';

  if (keyConfigured) {
    return 'api_key';
  }

  return 'misconfigured';
}

async function getRuntimeStatus() {
  const chromaHost = process.env.CHROMA_HOST || 'localhost';
  const chromaPort = Number(process.env.CHROMA_PORT || 8000);
  const [databaseStatus, chromaConnected] = await Promise.all([
    getDatabaseStatus(),
    isPortOpen(chromaHost, chromaPort)
  ]);

  let providerName;

  try {
    providerName = inferenceProvider.getProvider();
  } catch (_error) {
    providerName = String(process.env.INFERENCE_PROVIDER || 'claude')
      .trim()
      .toLowerCase();
  }

  const ok = databaseStatus.connected && chromaConnected;

  return {
    status: ok ? 'ok' : 'error',
    database: databaseStatus.connected ? 'connected' : 'disconnected',
    tables: databaseStatus.connected ? databaseStatus.tables : 0,
    tables_total: databaseStatus.connected ? databaseStatus.tables_total : 0,
    core_tables_expected: CORE_TABLES.length,
    chromadb: chromaConnected ? 'connected' : 'disconnected',
    inference_provider: providerName,
    write_auth_mode: getWriteAuthMode(),
    version: packageJson.version
  };
}

module.exports = {
  CORE_TABLES,
  getRuntimeStatus,
  getDatabaseStatus,
  getWriteAuthMode,
  isPortOpen
};
