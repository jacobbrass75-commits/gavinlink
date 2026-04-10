const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { query, close } = require('../../src/db/connection');
const provider = require('../../src/inference/provider');
const { createApp } = require('../../src/api/server');
const { createBuyerProfile } = require('../../src/buyers/profiles');
const { autoGenerateSellerProfiles } = require('../../src/sellers/profiles');
const {
  runFullMatching,
  runMatchingForBuyer,
  runMatchingForProperty
} = require('../../src/matching/runner');

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

async function requestJson(app, method, routePath, body = undefined) {
  const server = http.createServer(app);

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}${routePath}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });

    return {
      status: response.status,
      body: await response.json()
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function buildClassification(property) {
  return {
    classifications: ['buyer_intel'],
    entities: [{ name: 'Jordan Lee', type: 'person' }],
    relationships: [],
    buyer_profile: {
      entity_name: 'Jordan Lee',
      target_property_types: [property.property_type],
      target_cities: [property.city],
      max_price: Math.round(Number(property.assessed_value) * 1.1),
      min_sq_feet: Math.max(0, Math.round(Number(property.sq_feet || 0) * 0.8)),
      investment_strategy: 'value_add',
      urgency: 'actively_looking',
      sensibilities: 'Wants fast-moving distressed industrial deals'
    },
    seller_profile: null,
    property_ref: null,
    action_items: ['Review top matches for Jordan Lee'],
    summary: 'Jordan Lee is an active buyer for distressed inventory'
  };
}

async function importFixtureData() {
  const importRun = runNodeScript(path.join(ROOT, 'scripts', 'imports', 'import-from-realestatetool.js'), [
    '--csv',
    path.join(ROOT, 'tests', 'fixtures', 'sample-properties.json'),
    '--limit',
    '10'
  ]);
  assert.equal(importRun.status, 0, importRun.stderr || importRun.stdout);
}

test('Module 6 matching pipeline works end to end', async (t) => {
  t.after(async () => {
    await close();
  });

  const originalComplete = provider.complete;

  t.after(() => {
    provider.complete = originalComplete;
  });

  const migrateRun = runNodeScript(path.join(ROOT, 'scripts', 'admin', 'migrate.js'));
  assert.equal(migrateRun.status, 0, migrateRun.stderr || migrateRun.stdout);

  await resetTables();
  await importFixtureData();

  const generated = await autoGenerateSellerProfiles();
  assert.equal(generated.created, 10);

  const targetPropertyResult = await query(
    `
      SELECT id, property_type, city, assessed_value, sq_feet
      FROM properties
      ORDER BY assessed_value DESC NULLS LAST, apn ASC
      LIMIT 1
    `
  );
  const targetProperty = targetPropertyResult.rows[0];

  const mike = await createBuyerProfile({
    entity_name: 'Mike Chen',
    target_property_types: [targetProperty.property_type],
    target_cities: [targetProperty.city],
    max_price: Math.round(Number(targetProperty.assessed_value) * 1.1),
    min_sq_feet: Math.max(0, Math.round(Number(targetProperty.sq_feet || 0) * 0.8)),
    investment_strategy: 'value_add',
    urgency: 'actively_looking',
    sensibilities: 'Numbers-driven, direct communicator'
  });
  await createBuyerProfile({
    entity_name: 'Low Budget Retail Buyer',
    target_property_types: ['retail'],
    target_cities: ['Pasadena'],
    max_price: 1000000,
    investment_strategy: 'stabilized',
    urgency: 'long_term'
  });

  const buyerMatches = await runMatchingForBuyer(mike.entity_id, {
    dryRun: true,
    skipKnowledge: true
  });
  assert.ok(buyerMatches.length > 0);
  assert.ok(buyerMatches[0].score >= buyerMatches[buyerMatches.length - 1].score);

  const propertyMatches = await runMatchingForProperty(targetProperty.id, {
    dryRun: true,
    skipKnowledge: true
  });
  assert.ok(propertyMatches.length > 0);

  const dryRunSummary = await runFullMatching({
    dryRun: true,
    skipKnowledge: true
  });
  assert.equal(dryRunSummary.buyers_processed, 2);
  assert.ok(Object.keys(dryRunSummary.distribution).length > 0);

  const firstSave = await runFullMatching({
    minScore: 50,
    skipKnowledge: true
  });
  assert.ok(firstSave.matches_created > 0);

  const matchCountAfterFirstSave = await query('SELECT COUNT(*)::int AS count FROM matches');
  assert.ok(matchCountAfterFirstSave.rows[0].count > 0);

  const secondSave = await runFullMatching({
    minScore: 50,
    skipKnowledge: true
  });
  assert.equal(secondSave.matches_created, 0);
  assert.ok(secondSave.matches_updated >= matchCountAfterFirstSave.rows[0].count);

  provider.complete = async (prompt) => {
    if (prompt.includes('ingestion engine for a commercial real estate Second Brain')) {
      return JSON.stringify(buildClassification(targetProperty));
    }

    return JSON.stringify({
      match_summary: 'This buyer fits the seller’s distress timing and asset criteria.',
      approach_strategy: ['Lead with urgency', 'Anchor on speed', 'Validate lien position'],
      deal_structures: ['Straight cash purchase'],
      red_flags: ['Confirm payoff numbers'],
      confidence: 'high'
    });
  };

  const app = createApp();

  const topResponse = await requestJson(app, 'GET', '/api/matches/top');
  assert.equal(topResponse.status, 200);
  assert.ok(topResponse.body.total > 0);
  const firstMatchId = topResponse.body.results[0].id;

  const matchDetailResponse = await requestJson(app, 'GET', `/api/matches/${firstMatchId}`);
  assert.equal(matchDetailResponse.status, 200);
  assert.ok(Array.isArray(matchDetailResponse.body.reasons));

  const statusResponse = await requestJson(app, 'PUT', `/api/matches/${firstMatchId}/status`, {
    status: 'contacted'
  });
  assert.equal(statusResponse.status, 200);
  assert.equal(statusResponse.body.status, 'contacted');

  const missingStatusResponse = await requestJson(app, 'PUT', `/api/matches/${firstMatchId}/status`, {});
  assert.equal(missingStatusResponse.status, 400);
  assert.deepEqual(missingStatusResponse.body, { error: 'status is required' });

  const narrativeResponse = await requestJson(app, 'POST', `/api/matches/${firstMatchId}/narrative`, {});
  assert.equal(narrativeResponse.status, 201);
  assert.equal(narrativeResponse.body.narrative.confidence, 'high');

  const byBuyerResponse = await requestJson(app, 'GET', `/api/matches/buyer/${mike.id}`);
  assert.equal(byBuyerResponse.status, 200);
  assert.ok(byBuyerResponse.body.total > 0);

  const byPropertyResponse = await requestJson(app, 'GET', `/api/matches/property/${targetProperty.id}`);
  assert.equal(byPropertyResponse.status, 200);
  assert.ok(byPropertyResponse.body.total > 0);

  const distributionResponse = await requestJson(app, 'GET', '/api/match/distribution');
  assert.equal(distributionResponse.status, 200);
  assert.ok(distributionResponse.body.total_matches > 0);

  const rerunResponse = await requestJson(app, 'POST', `/api/match/run-for-property/${targetProperty.id}`, {
    dryRun: true
  });
  assert.equal(rerunResponse.status, 201);
  assert.ok(rerunResponse.body.total > 0);

  const ingestResponse = await requestJson(app, 'POST', '/api/ingest', {
    message: 'Jordan Lee wants a fast-moving distressed industrial deal in the same city as our top asset.',
    source: 'api'
  });
  assert.equal(ingestResponse.status, 200);
  assert.ok(ingestResponse.body.matches.length > 0);

  const searchByIdentifier = await requestJson(
    app,
    'GET',
    `/api/match/${encodeURIComponent('Jordan Lee')}`
  );
  assert.equal(searchByIdentifier.status, 200);
  assert.ok(searchByIdentifier.body.total > 0);
});
