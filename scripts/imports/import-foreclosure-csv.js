const path = require('path');
const dotenv = require('dotenv');
const { close } = require('../../src/db/connection');
const { previewForeclosureImport, importForeclosureFile } = require('../../src/import-export/foreclosure-import');

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    filePath: '',
    dryRun: false,
    skipSellers: false,
    limit: 0
  };

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];

    if (value === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (value === '--skip-sellers') {
      options.skipSellers = true;
      continue;
    }

    if (value === '--limit') {
      options.limit = Number(args[index + 1] || 0);
      index += 1;
      continue;
    }

    if (!value.startsWith('--') && !options.filePath) {
      options.filePath = value;
    }
  }

  return options;
}

function printPreview(preview) {
  console.log(`   Columns: ${preview.columns.join(', ')}`);
  console.log(`   Total rows: ${preview.total_rows}`);
  console.log(`   Unique properties: ${preview.unique_properties}`);
  console.log(`   Duplicate rows: ${preview.duplicate_rows}`);
  console.log(`   Missing required columns: ${preview.validation.missingRequired.join(', ') || 'none'}`);
  console.log(
    `   Missing recommended columns: ${preview.validation.missingRecommended.join(', ') || 'none'}`
  );
  console.log(`   Invalid address rows: ${preview.invalid_address_rows}`);
  console.log(`   Rows with sale date: ${preview.sale_date_rows}`);
  console.log(
    `   Top cities: ${preview.top_cities.map((entry) => `${entry.value} (${entry.count})`).join(', ') || 'none'}`
  );
  console.log(
    `   Grouped parcels: ${preview.grouped_parcels.length > 0 ? preview.grouped_parcels.map((group) => `${group.address} [${group.apn_count} APNs]`).join(', ') : 'none'}`
  );
}

async function main() {
  const options = parseArgs(process.argv);

  if (!options.filePath) {
    console.error('Usage: node scripts/imports/import-foreclosure-csv.js <path-to-csv> [--dry-run] [--limit N] [--skip-sellers]');
    process.exit(1);
  }

  console.log('\n=== Foreclosure CSV Importer ===');
  console.log(`File: ${options.filePath}`);
  console.log(`Mode: ${options.dryRun ? 'DRY RUN (preview only)' : 'LIVE IMPORT'}`);
  if (options.limit > 0) {
    console.log(`Limit: ${options.limit} unique properties`);
  }
  console.log('');

  console.log('1. Validating and previewing file...');
  const preview = await previewForeclosureImport(options.filePath, { limit: options.limit });
  printPreview(preview);

  if (options.dryRun) {
    console.log('\n--- DRY RUN COMPLETE ---');
    return;
  }

  console.log('\n2. Importing records...');
  const result = await importForeclosureFile(options.filePath, options);
  console.log(`   Imported properties: ${result.imported_properties}`);
  console.log(`   Property groups touched: ${result.property_groups_touched}`);
  console.log(`   Import records stored: ${result.import_records_recorded}`);
  console.log(`   Entities created: ${result.entities.created}`);
  console.log(`   Entities existing: ${result.entities.existing}`);
  console.log(`   Entity-property links: ${result.entities.linked}`);

  if (result.seller_profiles) {
    console.log(`   Seller profiles created: ${result.seller_profiles.created}`);
    console.log(`   Seller profiles existing: ${result.seller_profiles.existing}`);
  }

  console.log('\n=== IMPORT COMPLETE ===');
}

main()
  .catch((error) => {
    console.error('\nIMPORT FAILED:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await close();
  });
