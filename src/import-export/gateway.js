const fs = require('fs');
const path = require('path');
const csvParser = require('csv-parser');
const XLSX = require('xlsx');

function ensureArrayOfObjects(value) {
  return (
    Array.isArray(value) &&
    value.every((row) => row && typeof row === 'object' && !Array.isArray(row))
  );
}

function collectColumns(rows) {
  const seen = new Set();
  const columns = [];

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }

  return columns;
}

function detectEncoding(buffer) {
  // Check BOM first
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { encoding: 'utf16le', bomBytes: 2 };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { encoding: 'utf16be', bomBytes: 2 };
  }
  // No BOM — check for null-byte pattern (UTF-16 LE without BOM)
  if (buffer.length >= 4 && buffer[1] === 0x00 && buffer[3] === 0x00) {
    return { encoding: 'utf16le', bomBytes: 0 };
  }
  return { encoding: 'utf8', bomBytes: 0 };
}

function parseCsv(filePath) {
  return new Promise((resolve, reject) => {
    const raw = fs.readFileSync(filePath);
    const { encoding, bomBytes } = detectEncoding(raw);
    let stream;

    if (encoding === 'utf16le') {
      const { Readable } = require('stream');
      const decoded = raw.slice(bomBytes).toString('utf16le');
      stream = Readable.from([decoded]);
    } else if (encoding === 'utf16be') {
      const { Readable } = require('stream');
      const payload = raw.slice(bomBytes);
      const swapped = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length - 1; i += 2) {
        swapped[i] = payload[i + 1];
        swapped[i + 1] = payload[i];
      }
      const decoded = swapped.toString('utf16le');
      stream = Readable.from([decoded]);
    } else {
      stream = fs.createReadStream(filePath);
    }

    const rows = [];
    let columns = [];

    stream
      .on('error', reject)
      .pipe(csvParser())
      .on('headers', (headers) => {
        columns = headers.map((h) => h.trim());
      })
      .on('data', (row) => {
        const cleaned = {};
        for (const [key, value] of Object.entries(row)) {
          cleaned[key.trim()] = value;
        }
        rows.push(cleaned);
      })
      .on('end', () => {
        resolve({
          rows,
          columns,
          format: 'csv'
        });
      })
      .on('error', reject);
  });
}

function parseXlsx(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];

  if (!sheetName) {
    return {
      rows: [],
      columns: [],
      format: 'xlsx'
    };
  }

  const worksheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: null
  });

  if (rawRows.length === 0) {
    return {
      rows: [],
      columns: [],
      format: 'xlsx'
    };
  }

  const columns = rawRows[0].map((value) => String(value));
  const rows = rawRows.slice(1).map((rawRow) => {
    const row = {};

    columns.forEach((column, index) => {
      row[column] = rawRow[index] ?? null;
    });

    return row;
  });

  return {
    rows,
    columns,
    format: 'xlsx'
  };
}

async function parseJson(filePath) {
  const fileContents = await fs.promises.readFile(filePath, 'utf8');
  let parsed;

  try {
    parsed = JSON.parse(fileContents);
  } catch (_error) {
    throw new Error(`Invalid JSON file: ${filePath}`);
  }

  if (!ensureArrayOfObjects(parsed)) {
    throw new Error('JSON file must contain a top-level array of objects');
  }

  return {
    rows: parsed,
    columns: collectColumns(parsed),
    format: 'json'
  };
}

async function parseFile(filePath) {
  const absolutePath = path.resolve(filePath);

  try {
    await fs.promises.access(absolutePath, fs.constants.F_OK);
  } catch (_error) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  const extension = path.extname(absolutePath).toLowerCase();

  if (extension === '.csv') {
    return parseCsv(absolutePath);
  }

  if (extension === '.xlsx') {
    return parseXlsx(absolutePath);
  }

  if (extension === '.json') {
    return parseJson(absolutePath);
  }

  throw new Error(`Unsupported file format: ${extension}`);
}

function escapeCsvValue(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const stringValue = String(value);

  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

async function exportToFile(data, format, outputPath) {
  const absolutePath = path.resolve(outputPath);
  await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });

  if (format === 'json') {
    await fs.promises.writeFile(absolutePath, JSON.stringify(data, null, 2));
    return absolutePath;
  }

  if (format === 'csv') {
    const rows = Array.isArray(data) ? data : [];
    const columns = collectColumns(rows);
    const lines = [];

    if (columns.length > 0) {
      lines.push(columns.join(','));
      for (const row of rows) {
        lines.push(columns.map((column) => escapeCsvValue(row[column])).join(','));
      }
    }

    await fs.promises.writeFile(absolutePath, lines.join('\n'));
    return absolutePath;
  }

  if (format === 'xlsx') {
    const rows = Array.isArray(data) ? data : [];
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
    XLSX.writeFile(workbook, absolutePath);
    return absolutePath;
  }

  throw new Error(`Unsupported export format: ${format}`);
}

module.exports = {
  parseFile,
  exportToFile
};
