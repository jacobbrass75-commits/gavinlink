const path = require('path');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');
const { getPool, close } = require('../src/db/connection');
const { processPropertyEntities } = require('../src/entities/extract');
const { parseFile } = require('../src/import-export/gateway');
const { autoGenerateSellerProfiles } = require('../src/sellers/profiles');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// --- Normalization ---

function normalizeCity(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  // Title case: "LOS ANGELES" -> "Los Angeles", "los angeles" -> "Los Angeles"
  return trimmed
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizePhone(value) {
  if (!value || typeof value !== 'string') return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length === 0) return null;
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits[0] === '1') {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return value.trim();
}

function normalizeTrusteeName(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed
    .toUpperCase()
    .replace(/[.,]+/g, '')  // strip dots and commas
    .replace(/\s+/g, ' ')
    .replace(/\bS B S\b/, 'SBS')
    .trim();
}

function normalizeBeneficiaryName(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.toUpperCase() === 'NO LENDER ON DOCUMENT') return null;
  return trimmed
    .toUpperCase()
    .replace(/[.,]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\bAND\b/g, 'AND')  // keep consistent
    .trim();
}

function parseSaleDate(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  // "11/26/2025 12:00:00 AM" format
  const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (match) {
    const [, month, day, year] = match;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  // ISO format
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return trimmed.slice(0, 10);
  }

  return null;
}

function normalizeAddress(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.toUpperCase().startsWith('NA ')) return null;
  return trimmed
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAPN(value) {
  if (!value || typeof value !== 'string') return null;
  return value.trim() || null;
}

// --- Field Mapping ---

function mapForeclosureRow(row) {
  const apn = normalizeAPN(row['APN']);
  if (!apn) return null;  // skip rows without APN

  const address = normalizeAddress(row['Address']);
  const city = normalizeCity(row['City']);
  const saleDate = parseSaleDate(row['Sale Date']);
  const trusteeName = normalizeTrusteeName(row['Trustee Name']);
  const trusteePhone = normalizePhone(row['Trustee Phone #']);
  const beneficiaryName = normalizeBeneficiaryName(row['Bene/Client Name']);

  return {
    apn,
    address,
    city,
    state: 'CA',
    zip: null,
    property_type: 'other',
    sq_feet: null,
    lot_size: null,
    assessed_value: null,
    units: null,
    loan_amount: null,
    ltv: null,
    equity_amount: null,
    equity_percent: null,
    foreclosure: true,
    default_amount: null,
    default_date: saleDate,
    source: 'foreclosure_csv',
    region: 'la_county',
    owner_name: null,
    trustee_name: trusteeName,
    trustee_phone: trusteePhone,
    beneficiary_name: beneficiaryName,
    titlepro_recording_date: null,
    use_code: row['Use'] || null,
    realestatetool_id: null,  // property_key is UUID, realestatetool_id is bigint
    ai_summary: null,
    metadata: {
      foreclosure_doc_type: row['Foreclosure Document Type'] || null,
      trustee_city: row['Trustee City'] || null,
      property_key: row['property_key'] || null,
      import_source: 'foreclosure_csv',
      original_city_casing: row['City'] || null,
      original_beneficiary: row['Bene/Client Name'] || null,
      original_trustee: row['Trustee Name'] || null
    }
  };
}

// --- Deduplication ---

function dedupeByAPN(rows) {
  const seen = new Map();
  const dupes = [];

  for (const row of rows) {
    if (!row) continue;
    const key = `${row.apn}:${row.region}`;
    if (seen.has(key)) {
      dupes.push(row.apn);
      // keep the one with more data (prefer one with sale date)
      const existing = seen.get(key);
      if (!existing.default_date && row.default_date) {
        seen.set(key, row);
      }
    } else {
      seen.set(key, row);
    }
  }

  return {
    unique: Array.from(seen.values()),
    duplicateCount: dupes.length,
    duplicateAPNs: [...new Set(dupes)]
  };
}

// --- Database Upsert ---

async function upsertProperties(properties) {
  const pool = getPool();
  const client = await pool.connect();
  const rows = [];

  try {
    await client.query('BEGIN');

    for (const property of properties) {
      const result = await client.query(
        `
          INSERT INTO properties (
            id, apn, address, city, state, zip, property_type,
            sq_feet, lot_size, assessed_value, units, foreclosure,
            source, region, owner_name, trustee_name, trustee_phone,
            titlepro_recording_date, beneficiary_name, use_code,
            loan_amount, ltv, equity_amount, equity_percent,
            default_amount, default_date, realestatetool_id,
            ai_summary, metadata
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
            $21, $22, $23, $24, $25, $26, $27, $28, $29::jsonb
          )
          ON CONFLICT (apn, region)
          DO UPDATE SET
            address = COALESCE(EXCLUDED.address, properties.address),
            city = COALESCE(EXCLUDED.city, properties.city),
            state = COALESCE(EXCLUDED.state, properties.state),
            zip = COALESCE(EXCLUDED.zip, properties.zip),
            property_type = COALESCE(EXCLUDED.property_type, properties.property_type),
            sq_feet = COALESCE(EXCLUDED.sq_feet, properties.sq_feet),
            lot_size = COALESCE(EXCLUDED.lot_size, properties.lot_size),
            assessed_value = COALESCE(EXCLUDED.assessed_value, properties.assessed_value),
            units = COALESCE(EXCLUDED.units, properties.units),
            foreclosure = EXCLUDED.foreclosure,
            source = COALESCE(EXCLUDED.source, properties.source),
            owner_name = COALESCE(EXCLUDED.owner_name, properties.owner_name),
            trustee_name = COALESCE(EXCLUDED.trustee_name, properties.trustee_name),
            trustee_phone = COALESCE(EXCLUDED.trustee_phone, properties.trustee_phone),
            beneficiary_name = COALESCE(EXCLUDED.beneficiary_name, properties.beneficiary_name),
            default_date = COALESCE(EXCLUDED.default_date, properties.default_date),
            realestatetool_id = COALESCE(EXCLUDED.realestatetool_id, properties.realestatetool_id),
            metadata = properties.metadata || EXCLUDED.metadata,
            updated_at = NOW()
          RETURNING id, apn, region, owner_name, trustee_name, beneficiary_name, source
        `,
        [
          uuidv4(),
          property.apn,
          property.address,
          property.city,
          property.state,
          property.zip,
          property.property_type,
          property.sq_feet,
          property.lot_size,
          property.assessed_value,
          property.units,
          property.foreclosure,
          property.source,
          property.region,
          property.owner_name,
          property.trustee_name,
          property.trustee_phone,
          property.titlepro_recording_date,
          property.beneficiary_name,
          property.use_code,
          property.loan_amount,
          property.ltv,
          property.equity_amount,
          property.equity_percent,
          property.default_amount,
          property.default_date,
          property.realestatetool_id,
          property.ai_summary,
          JSON.stringify(property.metadata || {})
        ]
      );

      rows.push(result.rows[0]);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return rows;
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const csvPath = args.find((a) => !a.startsWith('--')) || '';
  const dryRun = args.includes('--dry-run');
  const skipSellers = args.includes('--skip-sellers');
  const limit = args.includes('--limit')
    ? Number(args[args.indexOf('--limit') + 1])
    : 0;

  if (!csvPath) {
    console.error('Usage: node scripts/import-foreclosure-csv.js <path-to-csv> [--dry-run] [--limit N] [--skip-sellers]');
    process.exit(1);
  }

  console.log(`\n=== Foreclosure CSV Importer ===`);
  console.log(`File: ${csvPath}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (preview only)' : 'LIVE IMPORT'}`);
  if (limit > 0) console.log(`Limit: ${limit} rows`);
  console.log('');

  // Step 1: Parse CSV
  console.log('1. Parsing CSV...');
  const parsed = await parseFile(csvPath);
  console.log(`   Parsed ${parsed.rows.length} rows, ${parsed.columns.length} columns`);
  console.log(`   Columns: ${parsed.columns.join(', ')}`);

  // Step 2: Map and normalize
  console.log('\n2. Mapping and normalizing...');
  let mapped = parsed.rows.map(mapForeclosureRow).filter(Boolean);
  console.log(`   Mapped ${mapped.length} valid rows (${parsed.rows.length - mapped.length} skipped - missing APN)`);

  // Step 3: Dedupe
  console.log('\n3. Deduplicating by APN...');
  const { unique, duplicateCount, duplicateAPNs } = dedupeByAPN(mapped);
  console.log(`   Unique properties: ${unique.length}`);
  console.log(`   Duplicates removed: ${duplicateCount}`);
  if (duplicateAPNs.length > 0 && duplicateAPNs.length <= 10) {
    console.log(`   Duplicate APNs: ${duplicateAPNs.join(', ')}`);
  } else if (duplicateAPNs.length > 10) {
    console.log(`   Duplicate APNs (first 10): ${duplicateAPNs.slice(0, 10).join(', ')}...`);
  }

  // Apply limit
  let toImport = limit > 0 ? unique.slice(0, limit) : unique;

  // Step 4: Preview summary
  const cities = {};
  const trustees = {};
  const beneficiaries = {};
  let withSaleDate = 0;

  for (const row of toImport) {
    if (row.city) cities[row.city] = (cities[row.city] || 0) + 1;
    if (row.trustee_name) trustees[row.trustee_name] = (trustees[row.trustee_name] || 0) + 1;
    if (row.beneficiary_name) beneficiaries[row.beneficiary_name] = (beneficiaries[row.beneficiary_name] || 0) + 1;
    if (row.default_date) withSaleDate++;
  }

  console.log(`\n4. Import Preview:`);
  console.log(`   Properties to import: ${toImport.length}`);
  console.log(`   With sale date: ${withSaleDate}`);
  console.log(`   Unique cities: ${Object.keys(cities).length}`);
  console.log(`   Top cities: ${Object.entries(cities).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, n]) => `${c} (${n})`).join(', ')}`);
  console.log(`   Unique trustees: ${Object.keys(trustees).length}`);
  console.log(`   Top trustees: ${Object.entries(trustees).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, n]) => `${t} (${n})`).join(', ')}`);
  console.log(`   Unique beneficiaries: ${Object.keys(beneficiaries).length}`);

  if (dryRun) {
    console.log('\n--- DRY RUN COMPLETE ---');
    console.log('Run without --dry-run to import.');
    return;
  }

  // Step 5: Insert properties
  console.log('\n5. Inserting properties...');
  const imported = await upsertProperties(toImport);
  console.log(`   Inserted/updated: ${imported.length} properties`);

  // Step 6: Create entities (trustee, beneficiary)
  console.log('\n6. Extracting and linking entities...');
  const entitySummary = await processPropertyEntities(imported);
  console.log(`   Entities created: ${entitySummary.created}`);
  console.log(`   Entities existing: ${entitySummary.existing}`);
  console.log(`   Entity-property links: ${entitySummary.linked}`);

  // Step 7: Auto-generate seller profiles
  if (!skipSellers) {
    console.log('\n7. Auto-generating seller profiles...');
    const sellerSummary = await autoGenerateSellerProfiles();
    console.log(`   Seller profiles created: ${sellerSummary.created}`);
    console.log(`   Already existing: ${sellerSummary.existing}`);
  }

  // Final summary
  console.log('\n=== IMPORT COMPLETE ===');
  console.log(`Properties: ${imported.length}`);
  console.log(`Entities: ${entitySummary.created} new, ${entitySummary.existing} existing`);
  if (!skipSellers) console.log(`Seller profiles: auto-generated for all foreclosure properties`);
  console.log('');
}

main()
  .catch((error) => {
    console.error('\nIMPORT FAILED:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await close();
  });
