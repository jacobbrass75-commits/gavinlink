#!/usr/bin/env node

require('dotenv').config();

const { sendTelegramMessage, listTelegramUpdates } = require('../../src/integrations/telegram');

function parseOption(args, name, fallback = null) {
  const index = args.indexOf(name);

  if (index === -1) {
    return fallback;
  }

  return args[index + 1] || fallback;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--updates')) {
    const updates = await listTelegramUpdates({
      limit: Number(parseOption(args, '--limit', '10')) || 10
    });
    process.stdout.write(`${JSON.stringify({ ok: true, updates }, null, 2)}\n`);
    return;
  }

  const message = parseOption(args, '--message', 'Soleil Telegram probe is live.');
  const chatId = parseOption(args, '--chat-id', null);
  const result = await sendTelegramMessage({
    chatId,
    text: message
  });

  process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
