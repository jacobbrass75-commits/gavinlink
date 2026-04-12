#!/usr/bin/env node

require('dotenv').config();

const { runTelegramBot } = require('../../src/ops/telegram-bot');

function parseOption(args, name, fallback = null) {
  const index = args.indexOf(name);

  if (index === -1) {
    return fallback;
  }

  return args[index + 1] || fallback;
}

function hasFlag(args, name) {
  return args.includes(name);
}

async function main() {
  const args = process.argv.slice(2);
  const once = hasFlag(args, '--once');
  const quiet = hasFlag(args, '--quiet');
  const result = await runTelegramBot({
    once,
    limit: Number(parseOption(args, '--limit', '10')) || 10,
    timeoutSeconds: Number(parseOption(args, '--timeout', '20')) || 20,
    pollIntervalMs: Number(parseOption(args, '--interval-ms', '3000')) || 3000,
    onCycle: quiet || once
      ? null
      : async (cycleResult) => {
          process.stdout.write(`${JSON.stringify(cycleResult, null, 2)}\n`);
        }
  });

  if (once) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
