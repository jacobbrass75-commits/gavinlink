const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { query, close } = require('../../src/db/connection');
const {
  getLenderReport,
  getLenderDetail,
  getLenderOwnerOverlaps
} = require('../../src/buyers/lender-report');
const { normalizeName } = require('../../src/entities/extract');

const ROOT = path.join(__dirname, '..', '..');

function runNodeScript(scriptPath) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: ROOT,
    encoding: 'utf8'
  });
}

async function resetTables() {
  await query(`
    TRUNCATE
      buyer_purchases,
      property_documents,
      property_import_records,
      wiki_promotion_queue,
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

async function createEntity(name, entityType, phone = null) {
  const id = uuidv4();

  await query(
    `
      INSERT INTO entities (id, name, normalized_name, entity_type, source, phone)
      VALUES ($1, $2, $3, $4, 'test', $5)
    `,
    [id, name, normalizeName(name), entityType, phone]
  );

  return id;
}

async function createProperty({
  ownerEntityId,
  trusteeEntityId,
  lenderEntityId = null,
  apn,
  city = 'LOS ANGELES',
  assessedValue = 100000,
  foreclosure = true
}) {
  await query(
    `
      INSERT INTO properties (
        id,
        apn,
        address,
        city,
        state,
        zip,
        property_type,
        assessed_value,
        foreclosure,
        source,
        region,
        owner_name,
        owner_entity_id,
        trustee_name,
        trustee_entity_id,
        lender_entity_id
      )
      VALUES (
        $1, $2, $3, $4, 'CA', '90001', 'industrial', $5, $6, 'test', 'la_county',
        'Owner', $7, 'Trustee', $8, $9
      )
    `,
    [uuidv4(), apn, `${apn} Address`, city, assessedValue, foreclosure, ownerEntityId, trusteeEntityId, lenderEntityId]
  );
}

test.before(async () => {
  const migrationRun = runNodeScript(path.join(ROOT, 'scripts', 'admin', 'migrate.js'));
  assert.equal(migrationRun.status, 0, migrationRun.stderr || migrationRun.stdout);
});

test.beforeEach(async () => {
  await resetTables();
});

test.after(async () => {
  await close();
});

test('getLenderReport aggregates lender activity', async () => {
  const ownerId = await createEntity('Owner One', 'person');
  const lenderId = await createEntity('Atlas Trustee Services', 'lender', '555-1111');

  await createProperty({ ownerEntityId: ownerId, trusteeEntityId: lenderId, apn: 'A1' });
  await createProperty({ ownerEntityId: ownerId, trusteeEntityId: lenderId, apn: 'A2' });

  const report = await getLenderReport();

  assert.equal(report.length, 1);
  assert.equal(report[0].property_count, 2);
  assert.equal(report[0].phone, '555-1111');
});

test('getLenderDetail returns entity and linked properties', async () => {
  const ownerId = await createEntity('Owner One', 'person');
  const lenderId = await createEntity('Atlas Trustee Services', 'lender');

  await createProperty({ ownerEntityId: ownerId, trusteeEntityId: lenderId, apn: 'B1' });
  await createProperty({ ownerEntityId: ownerId, trusteeEntityId: lenderId, apn: 'B2' });
  await createProperty({ ownerEntityId: ownerId, trusteeEntityId: lenderId, apn: 'B3', foreclosure: false });

  const detail = await getLenderDetail(lenderId);

  assert.equal(detail.entity.id, lenderId);
  assert.equal(detail.properties.length, 3);
  assert.equal(detail.foreclosure_count, 2);
});

test('getLenderOwnerOverlaps returns lender-owner pairs with multiple shared properties', async () => {
  const ownerId = await createEntity('Overlap Owner', 'person');
  const otherOwnerId = await createEntity('Other Owner', 'person');
  const lenderId = await createEntity('Atlas Trustee Services', 'lender');

  await createProperty({ ownerEntityId: ownerId, trusteeEntityId: lenderId, apn: 'C1' });
  await createProperty({ ownerEntityId: ownerId, trusteeEntityId: lenderId, apn: 'C2' });
  await createProperty({ ownerEntityId: otherOwnerId, trusteeEntityId: lenderId, apn: 'C3' });

  const overlaps = await getLenderOwnerOverlaps();

  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0].property_count, 2);
  assert.equal(overlaps[0].owner_entity_id, ownerId);
});

test('getLenderOwnerOverlaps returns empty array when there are no repeated owner-lender pairs', async () => {
  const ownerId = await createEntity('Owner One', 'person');
  const lenderId = await createEntity('Atlas Trustee Services', 'lender');

  await createProperty({ ownerEntityId: ownerId, trusteeEntityId: lenderId, apn: 'D1' });

  const overlaps = await getLenderOwnerOverlaps();

  assert.deepEqual(overlaps, []);
});
