const express = require('express');
const net = require('net');
const { query } = require('../../db/connection');
const { getProvider } = require('../../inference/provider');
const packageJson = require('../../../package.json');

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

const router = express.Router();

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
    await query('SELECT 1');
    const tableCountResult = await query(
      `
        SELECT COUNT(*)::int AS count
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
      `,
      [CORE_TABLES]
    );

    return {
      connected: true,
      tables: Number(tableCountResult.rows[0].count)
    };
  } catch (_error) {
    return {
      connected: false,
      tables: 0
    };
  }
}

router.get('/health', async (_req, res) => {
  const chromaHost = process.env.CHROMA_HOST || 'localhost';
  const chromaPort = Number(process.env.CHROMA_PORT || 8000);
  const [databaseStatus, chromaConnected] = await Promise.all([
    getDatabaseStatus(),
    isPortOpen(chromaHost, chromaPort)
  ]);

  let providerName;

  try {
    providerName = getProvider();
  } catch (_error) {
    providerName = String(process.env.INFERENCE_PROVIDER || 'claude')
      .trim()
      .toLowerCase();
  }

  const ok = databaseStatus.connected && chromaConnected;
  const payload = {
    status: ok ? 'ok' : 'error',
    database: databaseStatus.connected ? 'connected' : 'disconnected',
    tables: databaseStatus.connected ? databaseStatus.tables : 0,
    chromadb: chromaConnected ? 'connected' : 'disconnected',
    inference_provider: providerName,
    version: packageJson.version
  };

  res.status(ok ? 200 : 503).json(payload);
});

module.exports = router;
