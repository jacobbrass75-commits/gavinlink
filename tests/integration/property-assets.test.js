const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { spawnSync } = require('child_process');
const { query, close } = require('../../src/db/connection');
const { createApp } = require('../../src/api/server');

const ROOT = path.join(__dirname, '..', '..');

function runNodeScript(scriptPath, args = []) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env
  });
}

async function resetTables() {
  await query(`
    TRUNCATE
      buyer_purchases,
      property_documents,
      property_import_records,
      wiki_promotion_queue,
      knowledge_entities,
      knowledge_properties,
      property_groups,
      entity_relationships,
      deals,
      matches,
      seller_profiles,
      buyer_profiles,
      knowledge_entries,
      properties,
      entities
    RESTART IDENTITY CASCADE
  `);
}

async function request(app, method, routePath, body = undefined, headers = {}) {
  const server = http.createServer(app);

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}${routePath}`, {
      method,
      headers,
      body
    });

    return {
      status: response.status,
      body: await response.json()
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function createUtf16Csv() {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'isg-foreclosure-'));
  const filePath = path.join(tempDir, 'foreclosures.csv');
  const rows = [
    'property_key,Address,City,Sale Date,APN,Bene/Client Name,Foreclosure Document Type,Trustee Name,Trustee City,Trustee Phone #,Use',
    'row-1,123 Main St,LOS ANGELES,11/24/2025 12:00:00 AM,111-AAA-001,CROSSROADS HOLLYWOOD LENDER LLC,,LENDERS T D SERVICE INC,,9498551945,',
    'row-2,123 MAIN ST,Los Angeles,11/25/2025 12:00:00 AM,222-BBB-002,HANKEY CAPITAL LLC,,BEACON DEFAULT MANAGEMENT INC,,949-555-1111,',
    'row-3,123 Main St,Los Angeles,,111-AAA-001,CROSSROADS HOLLYWOOD LENDER LLC,,LENDERS T D SERVICE INC,,(949) 855-1945,'
  ];
  const payload = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(rows.join('\n'), 'utf16le')
  ]);

  await fs.promises.writeFile(filePath, payload);
  return filePath;
}

test('foreclosure import preview/import and property documents work end to end', async (t) => {
  t.after(async () => {
    await close();
  });

  const tempNarrativeRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'isg-property-docs-'));
  const previousWikiRoot = process.env.ISG_WIKI_ROOT;
  const previousRawRoot = process.env.ISG_RAW_ROOT;
  const previousDocumentRoot = process.env.ISG_PROPERTY_DOCUMENT_ROOT;

  process.env.ISG_WIKI_ROOT = path.join(tempNarrativeRoot, 'wiki');
  process.env.ISG_RAW_ROOT = path.join(tempNarrativeRoot, 'raw');
  process.env.ISG_PROPERTY_DOCUMENT_ROOT = path.join(tempNarrativeRoot, 'data', 'property-documents');

  t.after(() => {
    process.env.ISG_WIKI_ROOT = previousWikiRoot;
    process.env.ISG_RAW_ROOT = previousRawRoot;
    process.env.ISG_PROPERTY_DOCUMENT_ROOT = previousDocumentRoot;
  });

  const migrateRun = runNodeScript(path.join(ROOT, 'scripts', 'admin', 'migrate.js'));
  assert.equal(migrateRun.status, 0, migrateRun.stderr || migrateRun.stdout);

  await resetTables();
  const csvPath = await createUtf16Csv();
  const app = createApp();

  const previewForm = new FormData();
  previewForm.append('file', new File([await fs.promises.readFile(csvPath)], 'foreclosures.csv'));
  const previewResponse = await request(app, 'POST', '/api/import/foreclosure/preview', previewForm);

  assert.equal(previewResponse.status, 200);
  assert.equal(previewResponse.body.unique_properties, 2);
  assert.equal(previewResponse.body.duplicate_rows, 1);
  assert.equal(previewResponse.body.grouped_parcels[0].apn_count, 2);

  const importForm = new FormData();
  importForm.append('file', new File([await fs.promises.readFile(csvPath)], 'foreclosures.csv'));
  importForm.append('skipSellers', 'true');
  const importResponse = await request(app, 'POST', '/api/import/foreclosure', importForm);

  assert.equal(importResponse.status, 201);
  assert.equal(importResponse.body.imported_properties, 2);
  assert.equal(importResponse.body.property_groups_touched, 1);
  assert.equal(importResponse.body.import_records_recorded, 3);

  const propertyCountResult = await query('SELECT COUNT(*)::int AS count FROM properties');
  const groupCountResult = await query('SELECT COUNT(*)::int AS count FROM property_groups');
  const importRecordCountResult = await query('SELECT COUNT(*)::int AS count FROM property_import_records');

  assert.equal(propertyCountResult.rows[0].count, 2);
  assert.equal(groupCountResult.rows[0].count, 1);
  assert.equal(importRecordCountResult.rows[0].count, 3);

  const propertyResult = await query(
    `
      SELECT id
      FROM properties
      WHERE apn = '111-AAA-001'
      LIMIT 1
    `
  );
  const propertyId = propertyResult.rows[0].id;

  const groupResponse = await request(app, 'GET', `/api/properties/${propertyId}/group`);
  assert.equal(groupResponse.status, 200);
  assert.equal(groupResponse.body.properties.length, 2);
  assert.equal(groupResponse.body.import_records.length, 3);

  const pdfTempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'isg-pdf-'));
  const pdfPath = path.join(pdfTempDir, 'notice.pdf');
  await fs.promises.writeFile(pdfPath, '%PDF-1.4\nTest PDF');
  const documentForm = new FormData();
  documentForm.append(
    'document',
    new File([await fs.promises.readFile(pdfPath)], 'notice.pdf', { type: 'application/pdf' })
  );
  documentForm.append('document_type', 'notice_of_sale');
  documentForm.append('notes', 'Recorded notice for parcel review');
  const documentResponse = await request(app, 'POST', `/api/properties/${propertyId}/documents`, documentForm);

  assert.equal(documentResponse.status, 201);
  assert.equal(documentResponse.body.document_type, 'notice_of_sale');
  assert.ok(documentResponse.body.knowledge_entry_id);
  assert.match(documentResponse.body.wiki_page_path, /properties\/.+\.md$/);

  const documentsResponse = await request(app, 'GET', `/api/properties/${propertyId}/documents`);
  assert.equal(documentsResponse.status, 200);
  assert.equal(documentsResponse.body.total, 1);

  const propertyResponse = await request(app, 'GET', `/api/properties/${propertyId}`);
  assert.equal(propertyResponse.status, 200);
  assert.equal(propertyResponse.body.documents.length, 1);

  const knowledgeCountResult = await query(
    `
      SELECT COUNT(*)::int AS count
      FROM knowledge_entries
      WHERE source = 'property_document'
    `
  );
  assert.equal(knowledgeCountResult.rows[0].count, 1);

  const queueCountResult = await query(
    `
      SELECT COUNT(*)::int AS count
      FROM wiki_promotion_queue
    `
  );
  assert.equal(queueCountResult.rows[0].count, 0);

  const promotedPagePath = path.resolve(ROOT, documentResponse.body.wiki_page_path);
  const promotedPageContent = await fs.promises.readFile(promotedPagePath, 'utf8');
  assert.match(promotedPageContent, /\[ke:/);
  assert.match(promotedPageContent, /\[raw:property-documents\//);

  const queuedPdfPath = path.join(pdfTempDir, 'queued-notice.pdf');
  await fs.promises.writeFile(queuedPdfPath, '%PDF-1.4\nQueued PDF');
  const queuedDocumentForm = new FormData();
  queuedDocumentForm.append(
    'document',
    new File([await fs.promises.readFile(queuedPdfPath)], 'queued-notice.pdf', { type: 'application/pdf' })
  );
  queuedDocumentForm.append('document_type', 'foreclosure_notice');
  queuedDocumentForm.append('auto_promote', 'false');
  queuedDocumentForm.append('queue_promotion', 'true');

  const queuedDocumentResponse = await request(
    app,
    'POST',
    `/api/properties/${propertyId}/documents`,
    queuedDocumentForm
  );

  assert.equal(queuedDocumentResponse.status, 201);
  assert.equal(queuedDocumentResponse.body.wiki_page_path, null);
  assert.ok(queuedDocumentResponse.body.knowledge_entry_id);

  const queuedRowsResult = await query(
    `
      SELECT status, reason
      FROM wiki_promotion_queue
      ORDER BY created_at DESC
      LIMIT 1
    `
  );
  assert.equal(queuedRowsResult.rows[0].status, 'pending');
  assert.equal(queuedRowsResult.rows[0].reason, 'property_document');

  const maintenanceRun = runNodeScript(path.join(ROOT, 'scripts', 'ops', 'run-wiki-maintenance.js'), ['--limit', '10'], {
    ...process.env,
    ISG_WIKI_ROOT: process.env.ISG_WIKI_ROOT,
    ISG_RAW_ROOT: process.env.ISG_RAW_ROOT,
    ISG_PROPERTY_DOCUMENT_ROOT: process.env.ISG_PROPERTY_DOCUMENT_ROOT
  });
  assert.equal(maintenanceRun.status, 0, maintenanceRun.stderr || maintenanceRun.stdout);

  const processedQueueResult = await query(
    `
      SELECT status
      FROM wiki_promotion_queue
      ORDER BY created_at DESC
      LIMIT 1
    `
  );
  assert.equal(processedQueueResult.rows[0].status, 'completed');

  const maintenanceReportPath = path.join(process.env.ISG_WIKI_ROOT, 'reports', 'latest-maintenance.json');
  const maintenanceReport = JSON.parse(await fs.promises.readFile(maintenanceReportPath, 'utf8'));
  assert.equal(maintenanceReport.queue.completed >= 1, true);
});
