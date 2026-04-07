const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { query, close } = require('../../src/db/connection');
const { getPortfolio, detectPortfolioDistress } = require('../../src/entities/cluster');
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
      property_documents,
      property_import_records,
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

async function createEntity(name, entityType) {
  const id = uuidv4();

  await query(
    `
      INSERT INTO entities (
        id,
        name,
        normalized_name,
        entity_type,
        source
      )
      VALUES ($1, $2, $3, $4, $5)
    `,
    [id, name, normalizeName(name), entityType, 'test']
  );

  return id;
}

async function createRelationship(parentEntityId, childEntityId, relationshipType = 'controls') {
  await query(
    `
      INSERT INTO entity_relationships (
        id,
        parent_entity_id,
        child_entity_id,
        relationship_type,
        source
      )
      VALUES ($1, $2, $3, $4, $5)
    `,
    [uuidv4(), parentEntityId, childEntityId, relationshipType, 'test']
  );
}

async function createProperty(ownerEntityId, overrides = {}) {
  const id = uuidv4();
  const suffix = overrides.apnSuffix || id.slice(0, 8);

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
        owner_entity_id
      )
      VALUES ($1, $2, $3, $4, 'CA', '90001', $5, $6, $7, 'test', 'la_county', $8, $9)
    `,
    [
      id,
      `APN-${suffix}`,
      overrides.address || `Address ${suffix}`,
      overrides.city || 'LOS ANGELES',
      overrides.propertyType || 'industrial',
      overrides.assessedValue || 100,
      overrides.foreclosure || false,
      overrides.ownerName || 'Owner',
      ownerEntityId
    ]
  );

  return id;
}

test.before(async () => {
  const migrationRun = runNodeScript(path.join(ROOT, 'scripts', 'migrate.js'));
  assert.equal(migrationRun.status, 0, migrationRun.stderr || migrationRun.stdout);
});

test.beforeEach(async () => {
  await resetTables();
});

test.after(async () => {
  await close();
});

test('getPortfolio returns a single property through one LLC', async () => {
  const personId = await createEntity('Jane Owner', 'person');
  const llcId = await createEntity('Single Asset LLC', 'llc');

  await createRelationship(personId, llcId);
  await createProperty(llcId, {
    assessedValue: 150000
  });

  const portfolio = await getPortfolio(personId);

  assert.equal(portfolio.properties.length, 1);
  assert.equal(portfolio.total_assessed_value, 150000);
});

test('getPortfolio aggregates multiple LLC-owned properties', async () => {
  const personId = await createEntity('Portfolio Owner', 'person');
  const llcIds = await Promise.all([
    createEntity('Alpha Holdings LLC', 'llc'),
    createEntity('Bravo Holdings LLC', 'llc'),
    createEntity('Charlie Holdings LLC', 'llc')
  ]);

  for (const llcId of llcIds) {
    await createRelationship(personId, llcId);
  }

  await createProperty(llcIds[0], { assessedValue: 100000, apnSuffix: '001' });
  await createProperty(llcIds[1], { assessedValue: 250000, apnSuffix: '002' });
  await createProperty(llcIds[2], { assessedValue: 300000, apnSuffix: '003' });

  const portfolio = await getPortfolio(personId);

  assert.equal(portfolio.properties.length, 3);
  assert.equal(portfolio.total_assessed_value, 650000);
});

test('getPortfolio returns empty data for entities without properties', async () => {
  const entityId = await createEntity('No Properties LLC', 'llc');
  const portfolio = await getPortfolio(entityId);

  assert.equal(portfolio.properties.length, 0);
  assert.equal(portfolio.total_assessed_value, 0);
});

test('getPortfolio handles circular references without infinite recursion', async () => {
  const entityA = await createEntity('Cycle A LLC', 'llc');
  const entityB = await createEntity('Cycle B LLC', 'llc');

  await createRelationship(entityA, entityB);
  await createRelationship(entityB, entityA);
  await createProperty(entityB, {
    assessedValue: 50000,
    apnSuffix: 'CYCLE'
  });

  const portfolio = await getPortfolio(entityA);

  assert.equal(portfolio.properties.length, 1);
  assert.equal(
    portfolio.related_entities.filter((entity) => entity.id === entityB).length,
    1
  );
});

test('detectPortfolioDistress returns entities with multiple foreclosed properties', async () => {
  const personId = await createEntity('Distressed Owner', 'person');
  const llcA = await createEntity('Distressed Asset A LLC', 'llc');
  const llcB = await createEntity('Distressed Asset B LLC', 'llc');

  await createRelationship(personId, llcA);
  await createRelationship(personId, llcB);
  await createProperty(llcA, { foreclosure: true, assessedValue: 100000, apnSuffix: 'D1' });
  await createProperty(llcB, { foreclosure: true, assessedValue: 125000, apnSuffix: 'D2' });

  const distressed = await detectPortfolioDistress();

  assert.equal(distressed.length, 1);
  assert.equal(distressed[0].entity.id, personId);
  assert.equal(distressed[0].foreclosure_count, 2);
});
