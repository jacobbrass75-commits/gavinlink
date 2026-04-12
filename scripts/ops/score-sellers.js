const { close } = require('../../src/db/connection');
const { batchScoreProperties } = require('../../src/sellers/distress-score');
const { batchInferMotivation } = require('../../src/sellers/motivation');
const { findPortfolioDistress, findLenderOwnerPatterns } = require('../../src/sellers/portfolio-distress');
const { autoGenerateSellerProfiles, getSellerDistribution } = require('../../src/sellers/profiles');

function parseArgs(argv) {
  const args = {
    infer: false,
    distressed: false,
    report: false,
    rescore: false,
    limit: 0
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--infer') {
      args.infer = true;
      continue;
    }

    if (arg === '--distressed') {
      args.distressed = true;
      continue;
    }

    if (arg === '--report') {
      args.report = true;
      continue;
    }

    if (arg === '--rescore') {
      args.rescore = true;
      continue;
    }

    if (arg === '--limit') {
      args.limit = Number(argv[index + 1] || 0);
      index += 1;
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.infer) {
    const result = await batchInferMotivation({ limit: args.limit || 5 });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.distressed) {
    const [portfolioDistress, lenderPatterns] = await Promise.all([
      findPortfolioDistress(),
      findLenderOwnerPatterns()
    ]);

    console.log(
      JSON.stringify(
        {
          portfolio_distress: portfolioDistress,
          lender_patterns: lenderPatterns
        },
        null,
        2
      )
    );
    return;
  }

  const scoringResult = await batchScoreProperties({
    limit: args.limit,
    rescore: args.rescore
  });

  await autoGenerateSellerProfiles();

  const [distribution, portfolioDistress, lenderPatterns] = await Promise.all([
    getSellerDistribution(),
    findPortfolioDistress(),
    findLenderOwnerPatterns()
  ]);

  if (args.report) {
    console.log(
      JSON.stringify(
        {
          scoring: scoringResult,
          distribution,
          portfolio_distress: portfolioDistress,
          lender_patterns: lenderPatterns
        },
        null,
        2
      )
    );
    return;
  }

  console.log(
    JSON.stringify(
      {
        scoring: scoringResult,
        distribution,
        portfolio_distress_count: portfolioDistress.length,
        lender_pattern_count: lenderPatterns.length
      },
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
