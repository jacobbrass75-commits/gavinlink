const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../db/connection');
const { processPropertyEntities } = require('../entities/extract');
const { parseFile } = require('./gateway');
const { autoGenerateSellerProfiles } = require('../sellers/profiles');
const { syncPropertyGroups, normalizeAddress } = require('../properties/grouping');

const REQUIRED_COLUMNS = ['APN'];
const RECOMMENDED_COLUMNS = [
  'Address',
  'City',
  'Sale Date',
  'Bene/Client Name',
  'Trustee Name',
  'Trustee Phone #'
];

function normalizeCity(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed === '') {
    return null;
  }

  return trimmed
    .toLowerCase()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function normalizePhone(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const digits = value.replace(/\D/g, '');

  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }

  return digits.length > 0 ? value.trim() : null;
}

function normalizeEntityLabel(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed === '') {
    return null;
  }

  return trimmed
    .toUpperCase()
    .replace(/[.,]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBeneficiaryName(value) {
  const normalized = normalizeEntityLabel(value);

  if (!normalized || normalized === 'NO LENDER ON DOCUMENT') {
    return null;
  }

  return normalized;
}

function normalizeApn(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parseSaleDate(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed === '') {
    return null;
  }

  const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);

  if (match) {
    const [, month, day, year] = match;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return trimmed.slice(0, 10);
  }

  return null;
}

function validateColumns(columns = []) {
  const missingRequired = REQUIRED_COLUMNS.filter((column) => !columns.includes(column));
  const missingRecommended = RECOMMENDED_COLUMNS.filter((column) => !columns.includes(column));

  return {
    missingRequired,
    missingRecommended
  };
}

function mapForeclosureRow(row, index, sourceFile) {
  const apn = normalizeApn(row['APN']);

  if (!apn) {
    return null;
  }

  const normalizedAddress = normalizeAddress(row['Address']);

  return {
    row_number: index + 2,
    source_file: sourceFile,
    source_record_key: row.property_key || null,
    dedupe_key: `${apn}:la_county`,
    apn,
    address: normalizedAddress,
    city: normalizeCity(row['City']),
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
    default_date: parseSaleDate(row['Sale Date']),
    source: 'foreclosure_csv',
    region: 'la_county',
    owner_name: null,
    trustee_name: normalizeEntityLabel(row['Trustee Name']),
    trustee_phone: normalizePhone(row['Trustee Phone #']),
    beneficiary_name: normalizeBeneficiaryName(row['Bene/Client Name']),
    titlepro_recording_date: null,
    use_code: typeof row.Use === 'string' && row.Use.trim() !== '' ? row.Use.trim() : null,
    realestatetool_id: null,
    ai_summary: null,
    metadata: {
      foreclosure_doc_type: row['Foreclosure Document Type'] || null,
      trustee_city: row['Trustee City'] || null,
      property_key: row.property_key || null,
      import_source: 'foreclosure_csv',
      original_row: row
    }
  };
}

function dedupeByApn(rows = []) {
  const seen = new Map();
  const duplicates = [];

  for (const row of rows) {
    if (!row) {
      continue;
    }

    const existing = seen.get(row.dedupe_key);

    if (!existing) {
      seen.set(row.dedupe_key, row);
      continue;
    }

    duplicates.push(row);

    if (!existing.default_date && row.default_date) {
      seen.set(row.dedupe_key, row);
    }
  }

  return {
    unique: Array.from(seen.values()),
    duplicates
  };
}

function buildPreview(rows, duplicates, validation, columns, limit) {
  const cities = new Map();
  const trustees = new Map();
  const beneficiaries = new Map();
  const addressClusters = new Map();
  let invalidAddressCount = 0;
  let saleDateCount = 0;

  for (const row of rows) {
    if (row.city) {
      cities.set(row.city, (cities.get(row.city) || 0) + 1);
    }

    if (row.trustee_name) {
      trustees.set(row.trustee_name, (trustees.get(row.trustee_name) || 0) + 1);
    }

    if (row.beneficiary_name) {
      beneficiaries.set(row.beneficiary_name, (beneficiaries.get(row.beneficiary_name) || 0) + 1);
    }

    if (!row.address) {
      invalidAddressCount += 1;
    } else {
      const clusterKey = `${row.region}:${row.address}`;
      const cluster = addressClusters.get(clusterKey) || { address: row.address, apns: new Set() };
      cluster.apns.add(row.apn);
      addressClusters.set(clusterKey, cluster);
    }

    if (row.default_date) {
      saleDateCount += 1;
    }
  }

  const groupedParcels = Array.from(addressClusters.values())
    .filter((cluster) => cluster.apns.size > 1)
    .sort((left, right) => right.apns.size - left.apns.size)
    .map((cluster) => ({
      address: cluster.address,
      apn_count: cluster.apns.size,
      apns: Array.from(cluster.apns).sort()
    }));

  const topEntries = (map) =>
    Array.from(map.entries())
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([value, count]) => ({ value, count }));

  return {
    format: 'csv',
    columns,
    validation,
    total_rows: rows.length + duplicates.length,
    unique_properties: rows.length,
    duplicate_rows: duplicates.length,
    invalid_address_rows: invalidAddressCount,
    sale_date_rows: saleDateCount,
    top_cities: topEntries(cities),
    top_trustees: topEntries(trustees),
    top_beneficiaries: topEntries(beneficiaries),
    grouped_parcels: groupedParcels.slice(0, 10),
    sample_rows: rows.slice(0, limit).map((row) => ({
      apn: row.apn,
      address: row.address,
      city: row.city,
      trustee_name: row.trustee_name,
      beneficiary_name: row.beneficiary_name,
      default_date: row.default_date
    }))
  };
}

async function upsertProperties(rows = []) {
  const pool = getPool();
  const client = await pool.connect();
  const imported = [];

  try {
    await client.query('BEGIN');

    for (const row of rows) {
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
            assessed_value = COALESCE(EXCLUDED.assessed_value, properties.assessed_value),
            foreclosure = EXCLUDED.foreclosure,
            source = COALESCE(EXCLUDED.source, properties.source),
            owner_name = COALESCE(EXCLUDED.owner_name, properties.owner_name),
            trustee_name = COALESCE(EXCLUDED.trustee_name, properties.trustee_name),
            trustee_phone = COALESCE(EXCLUDED.trustee_phone, properties.trustee_phone),
            beneficiary_name = COALESCE(EXCLUDED.beneficiary_name, properties.beneficiary_name),
            default_date = COALESCE(EXCLUDED.default_date, properties.default_date),
            metadata = properties.metadata || EXCLUDED.metadata,
            updated_at = NOW()
          RETURNING id, apn, address, city, state, region, owner_name, trustee_name, beneficiary_name, source, property_group_id
        `,
        [
          uuidv4(),
          row.apn,
          row.address,
          row.city,
          row.state,
          row.zip,
          row.property_type,
          row.sq_feet,
          row.lot_size,
          row.assessed_value,
          row.units,
          row.foreclosure,
          row.source,
          row.region,
          row.owner_name,
          row.trustee_name,
          row.trustee_phone,
          row.titlepro_recording_date,
          row.beneficiary_name,
          row.use_code,
          row.loan_amount,
          row.ltv,
          row.equity_amount,
          row.equity_percent,
          row.default_amount,
          row.default_date,
          row.realestatetool_id,
          row.ai_summary,
          JSON.stringify(row.metadata || {})
        ]
      );

      imported.push({
        ...row,
        ...result.rows[0]
      });
    }

    await client.query('COMMIT');
    return imported;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function storeImportRecords(rawRows, importedProperties) {
  const propertyByDedupeKey = new Map(importedProperties.map((row) => [row.dedupe_key, row]));
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const row of rawRows) {
      const property = propertyByDedupeKey.get(row.dedupe_key);

      await client.query(
        `
          INSERT INTO property_import_records (
            id,
            property_id,
            property_group_id,
            source,
            source_file,
            source_row_number,
            source_record_key,
            dedupe_key,
            apn,
            address,
            city,
            raw_data
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
          ON CONFLICT (source, COALESCE(source_file, ''), COALESCE(source_row_number, 0), COALESCE(source_record_key, ''))
          DO UPDATE SET
            property_id = EXCLUDED.property_id,
            property_group_id = EXCLUDED.property_group_id,
            dedupe_key = EXCLUDED.dedupe_key,
            apn = EXCLUDED.apn,
            address = EXCLUDED.address,
            city = EXCLUDED.city,
            raw_data = EXCLUDED.raw_data
        `,
        [
          uuidv4(),
          property?.id || null,
          property?.property_group_id || null,
          row.source,
          row.source_file,
          row.row_number,
          row.source_record_key,
          row.dedupe_key,
          row.apn,
          row.address,
          row.city,
          JSON.stringify(row.metadata?.original_row || {})
        ]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function previewForeclosureImport(filePath, options = {}) {
  const parsed = await parseFile(filePath);
  const sourceFile = path.resolve(filePath);
  const validation = validateColumns(parsed.columns);

  if (validation.missingRequired.length > 0) {
    const error = new Error(`Missing required columns: ${validation.missingRequired.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }

  const mappedRows = parsed.rows
    .map((row, index) => mapForeclosureRow(row, index, sourceFile))
    .filter(Boolean);
  const { unique, duplicates } = dedupeByApn(mappedRows);
  const limit = Math.max(Number(options.limit) || 5, 1);

  return {
    ...buildPreview(unique, duplicates, validation, parsed.columns, Math.min(limit, 5)),
    mapped_rows: mappedRows,
    unique_rows: unique,
    duplicate_rows_detail: duplicates
  };
}

async function importForeclosureFile(filePath, options = {}) {
  const preview = await previewForeclosureImport(filePath, options);
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 0;
  const skipSellers = options.skipSellers === true;
  const dryRun = options.dryRun === true;
  const selectedKeys = new Set(
    (limit > 0 ? preview.unique_rows.slice(0, limit) : preview.unique_rows).map((row) => row.dedupe_key)
  );
  const uniqueRows = limit > 0 ? preview.unique_rows.slice(0, limit) : preview.unique_rows;
  const rawRows = preview.mapped_rows.filter((row) => selectedKeys.has(row.dedupe_key));

  if (dryRun) {
    return {
      mode: 'dry_run',
      preview: {
        ...preview,
        unique_properties: uniqueRows.length,
        total_rows: rawRows.length
      }
    };
  }

  const importedProperties = await upsertProperties(uniqueRows);
  const groups = await syncPropertyGroups(importedProperties);
  const pool = getPool();
  const client = await pool.connect();
  let refreshedProperties;

  try {
    const ids = importedProperties.map((row) => row.id);
    const result = await client.query(
      `
        SELECT id, apn, address, city, state, region, owner_name, trustee_name, beneficiary_name, source, property_group_id
        FROM properties
        WHERE id = ANY($1::uuid[])
      `,
      [ids]
    );
    refreshedProperties = result.rows.map((row) => {
      const original = importedProperties.find((property) => property.id === row.id);
      return {
        ...original,
        ...row
      };
    });
  } finally {
    client.release();
  }

  await storeImportRecords(rawRows, refreshedProperties);
  const entitySummary = await processPropertyEntities(refreshedProperties);
  const sellerSummary = skipSellers ? null : await autoGenerateSellerProfiles();

  return {
    mode: 'import',
    preview: {
      ...preview,
      unique_properties: uniqueRows.length,
      total_rows: rawRows.length
    },
    imported_properties: refreshedProperties.length,
    property_groups_touched: [...new Set(groups.map((group) => group.id))].length,
    import_records_recorded: rawRows.length,
    entities: entitySummary,
    seller_profiles: sellerSummary
  };
}

module.exports = {
  REQUIRED_COLUMNS,
  RECOMMENDED_COLUMNS,
  normalizeCity,
  normalizePhone,
  normalizeBeneficiaryName,
  mapForeclosureRow,
  dedupeByApn,
  previewForeclosureImport,
  importForeclosureFile
};
