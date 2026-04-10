#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { writeVaultFile } = require('../../src/integrations/obsidian');

function usage() {
  console.error(
    'Usage: node scripts/ops/publish-obsidian-note.js <local-file> <vault-path.md>'
  );
}

async function main() {
  const [localFile, vaultPath] = process.argv.slice(2);

  if (!localFile || !vaultPath) {
    usage();
    process.exit(1);
  }

  const absolutePath = path.resolve(localFile);
  const content = await fs.promises.readFile(absolutePath, 'utf8');
  const result = await writeVaultFile(vaultPath, content, {
    contentType: 'text/markdown'
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        local_file: absolutePath,
        vault_path: result.path,
        bytes: result.bytes
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
