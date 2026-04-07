#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { processAutoPromoteQueue } = require('../src/wiki/queue');
const { lintWiki } = require('../src/wiki/lint');
const { getKnowledgeEntry } = require('../src/knowledge/extract');
const { getWikiRoot } = require('../src/wiki/promote');

function parseFlag(args, name) {
  return args.includes(name);
}

function parseOption(args, name, fallback = null) {
  const index = args.indexOf(name);

  if (index === -1) {
    return fallback;
  }

  return args[index + 1] || fallback;
}

async function writeReport(fileName, payload) {
  const reportsDir = path.join(getWikiRoot(), 'reports');
  await fs.promises.mkdir(reportsDir, { recursive: true });
  await fs.promises.writeFile(path.join(reportsDir, fileName), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = parseFlag(args, '--dry-run');
  const lintOnly = parseFlag(args, '--lint-only');
  const queueOnly = parseFlag(args, '--queue-only');
  const limit = Number(parseOption(args, '--limit', '10')) || 10;
  const report = {
    ran_at: new Date().toISOString(),
    dry_run: dryRun,
    queue: null,
    lint: null
  };

  if (!lintOnly) {
    report.queue = await processAutoPromoteQueue({
      limit,
      dryRun
    });
  }

  if (!queueOnly) {
    report.lint = await lintWiki({
      resolveKnowledgeEntry: async (knowledgeEntryId) => getKnowledgeEntry(knowledgeEntryId)
    });
  }

  await writeReport('latest-maintenance.json', report);

  if (report.lint) {
    await writeReport('latest-lint.json', report.lint);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if ((report.lint && report.lint.errors > 0) || (report.queue && report.queue.failed > 0)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
