#!/usr/bin/env node

const { close } = require('../../src/db/connection');
const {
  runFullMatching,
  runMatchingForBuyer,
  runMatchingForProperty,
  getTopMatches,
  getMatchDistribution
} = require('../../src/matching/runner');

function parseArgs(argv) {
  const options = {
    dryRun: false,
    generateNarratives: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === '--dry-run') {
      options.dryRun = true;
    } else if (value === '--narratives') {
      options.generateNarratives = true;
    } else if (value === '--min-score') {
      options.minScore = Number(argv[index + 1]);
      index += 1;
    } else if (value === '--buyer') {
      options.buyerEntityId = argv[index + 1];
      index += 1;
    } else if (value === '--property') {
      options.propertyId = argv[index + 1];
      index += 1;
    } else if (value === '--top') {
      options.topOnly = true;
      options.limit = Number(argv[index + 1] || 10);
      if (!Number.isFinite(options.limit)) {
        options.limit = 10;
      } else {
        index += 1;
      }
    } else if (value === '--distribution') {
      options.distributionOnly = true;
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.topOnly) {
    console.log(JSON.stringify(await getTopMatches({ limit: options.limit }), null, 2));
    return;
  }

  if (options.distributionOnly) {
    console.log(JSON.stringify(await getMatchDistribution(), null, 2));
    return;
  }

  if (options.buyerEntityId) {
    console.log(
      JSON.stringify(
        await runMatchingForBuyer(options.buyerEntityId, {
          minScore: options.minScore,
          dryRun: options.dryRun,
          generateNarratives: options.generateNarratives
        }),
        null,
        2
      )
    );
    return;
  }

  if (options.propertyId) {
    console.log(
      JSON.stringify(
        await runMatchingForProperty(options.propertyId, {
          minScore: options.minScore,
          dryRun: options.dryRun,
          generateNarratives: options.generateNarratives
        }),
        null,
        2
      )
    );
    return;
  }

  console.log(
    JSON.stringify(
      await runFullMatching({
        minScore: options.minScore,
        dryRun: options.dryRun,
        generateNarratives: options.generateNarratives
      }),
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await close();
  });
