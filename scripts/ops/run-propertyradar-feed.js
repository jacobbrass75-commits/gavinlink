#!/usr/bin/env node

const path = require('path');
const dotenv = require('dotenv');
const { close } = require('../../src/db/connection');
const { runPropertyRadarFeed } = require('../../src/ops/propertyradar-feed');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function parseArgs(argv) {
  const options = {
    query: undefined,
    maxResults: undefined,
    dryRun: false,
    refreshWithRealEstateTool: true,
    messageId: undefined,
    loop: false,
    intervalMs: undefined,
    iterations: undefined,
    sendTelegramSummary: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === '--query') {
      options.query = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (value === '--max-results') {
      options.maxResults = Number(argv[index + 1] || 0) || null;
      index += 1;
      continue;
    }

    if (value === '--message-id') {
      options.messageId = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (value === '--interval-ms') {
      options.intervalMs = Number(argv[index + 1] || 0) || null;
      index += 1;
      continue;
    }

    if (value === '--iterations') {
      options.iterations = Number(argv[index + 1] || 0) || null;
      index += 1;
      continue;
    }

    if (value === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (value === '--no-refresh') {
      options.refreshWithRealEstateTool = false;
      continue;
    }

    if (value === '--loop') {
      options.loop = true;
      continue;
    }

    if (value === '--once') {
      options.loop = false;
      continue;
    }

    if (value === '--telegram-summary') {
      options.sendTelegramSummary = true;
      continue;
    }

    if (value === '--no-telegram-summary') {
      options.sendTelegramSummary = false;
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runPropertyRadarFeed(options);
  console.log(JSON.stringify(result, null, 2));

  if (result.errors.length > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await close();
  });
