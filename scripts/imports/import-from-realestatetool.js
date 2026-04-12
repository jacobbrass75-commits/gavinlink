const path = require('path');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');
const { getPool, close } = require('../../src/db/connection');
const { fetchAllProperties, fetchStats } = require('../../src/integrations/realestatetool');
const { processPropertyEntities } = require('../../src/entities/extract');
const { batchResolveLLCs } = require('../../src/entities/resolve-llc');
const { parseFile } = require('../../src/import-export/gateway');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function parseArgs(argv) {
  const args = {
    csv: '',
    limit: 0,
    region: '',
    resolve: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--csv') {
      args.csv = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (arg === '--limit') {
      args.limit = Number(argv[index + 1] || 0);
      index += 1;
      continue;
    }

    if (arg === '--region') {
      args.region = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (arg === '--resolve') {
      args.resolve = true;
    }
  }

  return args;
}

function cleanZip(value) {
  if (value == null) {
    return null;
  }

  return String(value)
    .trim()
    .replace(/\.0$/, '');
}

function mapBatchType(value) {
  const normalized = String(value || '').trim().toUpperCase();

  if (normalized === 'IND') {
    return 'industrial';
  }

  if (normalized === 'COM') {
    return 'commercial';
  }

  if (normalized === 'MF') {
    return 'multifamily';
  }

  if (normalized === 'RES') {
    return 'residential';
  }

  if (normalized !== '') {
    return 'other';
  }

  return 'other';
}

function toNullableNumber(value) {
  if (value == null || value === '') {
    return null;
  }

  const parsed = Number(String(value).replace(/,/g, ''));

  return Number.isFinite(parsed) ? parsed : null;
}

function toBooleanFlag(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value === 1;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();

    if (normalized === '1' || normalized === 'true' || normalized === 'yes') {
      return true;
    }

    if (normalized === '0' || normalized === 'false' || normalized === 'no') {
      return false;
    }
  }

  return false;
}

function parseDateValue(value) {
  if (!value) {
    return null;
  }

  const trimmed = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);

  if (slashMatch) {
    const [, month, day, year] = slashMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  const parsed = new Date(trimmed);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined && entry !== '')
  );
}

function normalizeImportedProperty(property) {
  const source = property?.source || (property?.owner_first_name ? 'realestatetool' : 'realestatetool');
  const propertyType = property?.property_type
    ? String(property.property_type).trim().toLowerCase()
    : mapBatchType(property?.batch_type);

  return {
    apn: property?.apn ? String(property.apn).trim() : '',
    address: property?.situs_street || property?.address || null,
    city: property?.situs_city || property?.city || null,
    state: property?.state ? String(property.state).trim() : 'CA',
    zip: cleanZip(property?.situs_zip || property?.zip),
    property_type: propertyType || 'other',
    sq_feet: toNullableNumber(property?.sq_feet),
    lot_size: toNullableNumber(property?.lot_size),
    assessed_value: toNullableNumber(property?.assessed_value),
    units: toNullableNumber(property?.units),
    loan_amount: toNullableNumber(property?.loan_amount),
    ltv: toNullableNumber(property?.ltv),
    equity_amount: toNullableNumber(property?.equity_amount),
    equity_percent: toNullableNumber(property?.equity_percent),
    foreclosure: toBooleanFlag(property?.foreclosure),
    default_amount: toNullableNumber(property?.default_amount),
    default_date: parseDateValue(property?.default_date),
    source: source || 'realestatetool',
    region: property?.region || 'la_county',
    owner_name: property?.owner_first_name || property?.owner_name || null,
    trustee_name: property?.trustee_name || null,
    trustee_phone: property?.trustee_phone || null,
    beneficiary_name: property?.beneficiary_name || null,
    titlepro_recording_date: parseDateValue(property?.titlepro_recording_date),
    use_code: property?.use_code || null,
    realestatetool_id: property?.realestatetool_id || property?.id || null,
    ai_summary: property?.ai_summary || null,
    metadata: compactObject({
      batch_type: property?.batch_type || null,
      google_maps_url: property?.google_maps_url || null,
      google_earth_url: property?.google_earth_url || null,
      titlepro_status: property?.titlepro_status || null,
      recording_doc_link: property?.recording_doc_link || null,
      listed_for_sale: property?.listed_for_sale ?? null,
      owner_occupied: property?.owner_occupied ?? null,
      beneficiary_name: property?.beneficiary_name || null,
      default_date_raw: property?.default_date || null,
      default_amount_raw: property?.default_amount ?? null
    })
  };
}

async function loadInputProperties({ csvPath, limit, region }) {
  if (csvPath) {
    const parsed = await parseFile(csvPath);
    const rows = parsed.rows.map(normalizeImportedProperty);

    return limit > 0 ? rows.slice(0, limit) : rows;
  }

  const properties = [];

  for await (const batch of fetchAllProperties({ limit: 50, region })) {
    for (const property of batch) {
      properties.push(normalizeImportedProperty(property));

      if (limit > 0 && properties.length >= limit) {
        return properties;
      }
    }
  }

  return properties;
}

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
            id,
            apn,
            address,
            city,
            state,
            zip,
            property_type,
            sq_feet,
            lot_size,
            assessed_value,
            units,
            foreclosure,
            source,
            region,
            owner_name,
            trustee_name,
            trustee_phone,
            titlepro_recording_date,
            beneficiary_name,
            use_code,
            loan_amount,
            ltv,
            equity_amount,
            equity_percent,
            default_amount,
            default_date,
            realestatetool_id,
            ai_summary,
            metadata
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
            titlepro_recording_date = COALESCE(
              EXCLUDED.titlepro_recording_date,
              properties.titlepro_recording_date
            ),
            beneficiary_name = COALESCE(EXCLUDED.beneficiary_name, properties.beneficiary_name),
            use_code = COALESCE(EXCLUDED.use_code, properties.use_code),
            loan_amount = COALESCE(EXCLUDED.loan_amount, properties.loan_amount),
            ltv = COALESCE(EXCLUDED.ltv, properties.ltv),
            equity_amount = COALESCE(EXCLUDED.equity_amount, properties.equity_amount),
            equity_percent = COALESCE(EXCLUDED.equity_percent, properties.equity_percent),
            default_amount = COALESCE(EXCLUDED.default_amount, properties.default_amount),
            default_date = COALESCE(EXCLUDED.default_date, properties.default_date),
            realestatetool_id = COALESCE(EXCLUDED.realestatetool_id, properties.realestatetool_id),
            ai_summary = COALESCE(EXCLUDED.ai_summary, properties.ai_summary),
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

async function runImport(options = {}) {
  const properties = await loadInputProperties({
    csvPath: options.csv,
    limit: options.limit,
    region: options.region
  });
  const importedProperties = await upsertProperties(properties);
  const entitySummary = await processPropertyEntities(importedProperties);
  let resolveSummary = null;

  if (options.resolve) {
    resolveSummary = await batchResolveLLCs({
      limit: options.limit || 50
    });
  }

  let stats = null;

  if (!options.csv) {
    try {
      stats = await fetchStats(options.region || '');
    } catch (_error) {
      stats = null;
    }
  }

  return {
    imported: importedProperties.length,
    entities: entitySummary,
    resolved: resolveSummary,
    source_stats: stats
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.csv && !process.env.REALESTATETOOL_URL) {
    throw new Error(
      'Provide REALESTATETOOL_URL for live imports or use --csv with an exported file'
    );
  }

  const summary = await runImport(options);
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await close();
    });
}

module.exports = {
  cleanZip,
  mapBatchType,
  normalizeImportedProperty,
  runImport,
  upsertProperties,
  parseDateValue
};
