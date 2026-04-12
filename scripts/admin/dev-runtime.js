#!/usr/bin/env node
const path = require('path');
const { spawn } = require('child_process');
const runtimeApp = require('../../src/app/runtime');
const db = require('../../src/db/connection');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || REPO_ROOT,
      stdio: options.stdio || 'inherit',
      env: {
        ...process.env,
        ...(options.env || {})
      }
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function commandExists(command, args = ['--version']) {
  try {
    await runCommand(command, args, { stdio: 'ignore' });
    return true;
  } catch (_error) {
    return false;
  }
}

async function getLocalStatus() {
  const apiPort = Number(process.env.API_PORT || 3100);
  const postgresHost = process.env.POSTGRES_HOST || '127.0.0.1';
  const postgresPort = Number(process.env.POSTGRES_PORT || 5433);
  const chromaHost = process.env.CHROMA_HOST || '127.0.0.1';
  const chromaPort = Number(process.env.CHROMA_PORT || 8000);
  const [postgresOpen, chromaOpen, apiOpen] = await Promise.all([
    runtimeApp.isPortOpen(postgresHost, postgresPort),
    runtimeApp.isPortOpen(chromaHost, chromaPort),
    runtimeApp.isPortOpen('127.0.0.1', apiPort)
  ]);

  let database = {
    connected: false,
    tables: 0,
    tables_total: 0
  };

  if (postgresOpen) {
    database = await runtimeApp.getDatabaseStatus();
  }

  let api = {
    connected: false,
    payload: null
  };

  if (apiOpen) {
    try {
      const response = await fetch(`http://127.0.0.1:${apiPort}/health`);
      api = {
        connected: response.ok,
        payload: await response.json()
      };
    } catch (_error) {
      api = {
        connected: false,
        payload: null
      };
    }
  }

  await db.close().catch(() => {});

  return {
    docker_compose_available: await commandExists('docker', ['compose', 'version']),
    pm2_available: await commandExists('pm2', ['--version']),
    services: {
      postgres: postgresOpen ? 'listening' : 'down',
      chromadb: chromaOpen ? 'listening' : 'down',
      api: apiOpen ? 'listening' : 'down'
    },
    database,
    api,
    auth: {
      mode: runtimeApp.getWriteAuthMode(),
      admin_api_key_configured: Boolean(cleanText(process.env.ADMIN_API_KEY, null)),
      allow_unauthenticated_write:
        String(process.env.ALLOW_UNAUTHENTICATED_WRITE || '').trim().toLowerCase() === 'true'
    }
  };
}

async function up(args) {
  const seed = hasFlag(args, '--seed');
  const pm2 = hasFlag(args, '--pm2');

  await runCommand('docker', ['compose', 'up', '-d']);
  await runCommand('node', ['scripts/admin/migrate.js']);

  if (seed) {
    await runCommand('node', ['scripts/admin/seed-test-data.js']);
  }

  if (pm2) {
    await runCommand('pm2', ['start', 'ecosystem.config.cjs'], {
      env: {
        NODE_ENV: cleanText(process.env.NODE_ENV, 'development') || 'development'
      }
    });
  }

  printJson(await getLocalStatus());
}

async function down(args) {
  const commandArgs = ['compose', 'down'];

  if (hasFlag(args, '--volumes')) {
    commandArgs.push('--volumes');
  }

  await runCommand('docker', commandArgs);
  await db.close().catch(() => {});
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'up':
      return up(args);
    case 'check':
      return printJson(await getLocalStatus());
    case 'down':
      return down(args);
    default:
      throw new Error(
        'Usage: node scripts/admin/dev-runtime.js <up|check|down> [--seed] [--pm2] [--volumes]'
      );
  }
}

main().catch(async (error) => {
  console.error(error.message);
  await db.close().catch(() => {});
  process.exit(1);
});
