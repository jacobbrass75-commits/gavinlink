#!/usr/bin/env node

require('dotenv').config();

const BASE_URL = String(process.env.ISG_API_URL || 'http://localhost:3100').replace(/\/$/, '');

function withAdminHeaders(headers = {}) {
  if (!process.env.ADMIN_API_KEY) {
    return headers;
  }

  return {
    ...headers,
    'x-api-key': process.env.ADMIN_API_KEY
  };
}

async function request(method, route, { body, headers } = {}) {
  const url = `${BASE_URL}${route}`;
  const options = {
    method,
    headers: { ...(headers || {}) }
  };

  if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const text = await response.text();
  let payload = text;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      payload = text;
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    route,
    payload
  };
}

function summarizePayload(payload) {
  if (payload == null) {
    return 'null';
  }

  if (typeof payload === 'string') {
    return payload.slice(0, 140);
  }

  const summary = {};

  for (const key of ['status', 'total', 'ok', 'summary', 'message']) {
    if (payload[key] !== undefined) {
      summary[key] = payload[key];
    }
  }

  return JSON.stringify(Object.keys(summary).length > 0 ? summary : payload).slice(0, 200);
}

async function assertStep(name, response, predicate = () => true) {
  const passed = response.ok && predicate(response.payload);
  return {
    name,
    passed,
    status: response.status,
    route: response.route,
    summary: summarizePayload(response.payload)
  };
}

async function bootstrapLiveData() {
  const steps = [];

  steps.push(
    await assertStep(
      'Bootstrap sellers',
      await request('POST', '/api/sellers/auto-generate', {
        headers: withAdminHeaders()
      }),
      (payload) => typeof payload?.created === 'number' || typeof payload?.existing === 'number'
    )
  );

  steps.push(
    await assertStep(
      'Bootstrap matching',
      await request('POST', '/api/match/run', {
        headers: withAdminHeaders(),
        body: { minScore: 1, dryRun: false, generateNarratives: false }
      }),
      (payload) => typeof payload?.buyers_processed === 'number'
    )
  );

  steps.push(
    await assertStep(
      'Bootstrap knowledge',
      await request('POST', '/api/ingest', {
        body: {
          message:
            'IOC sweep note: Mike Chen is still targeting industrial in Carson and Los Angeles, wants 20k+ square feet, values a quick and numbers-driven process.',
          source: 'ioc_sweep'
        }
      }),
      (payload) => payload?.ok === true && typeof payload?.knowledge_entry_id === 'string'
    )
  );

  return steps;
}

async function collectContext() {
  const buyers = await request('GET', '/api/buyers?limit=5');
  const sellers = await request('GET', '/api/sellers?limit=5');
  const entities = await request('GET', '/api/entities?limit=5');
  const knowledge = await request('GET', '/api/knowledge?limit=5');

  const buyerId = buyers.payload?.profiles?.[0]?.id || null;
  const sellerId = sellers.payload?.profiles?.[0]?.id || null;
  const propertyId =
    sellers.payload?.profiles?.[0]?.property_id ||
    entities.payload?.results?.[0]?.properties?.[0]?.id ||
    null;
  const entityId = entities.payload?.results?.[0]?.id || null;
  const knowledgeId = knowledge.payload?.results?.[0]?.id || null;

  return {
    buyerId,
    sellerId,
    propertyId,
    entityId,
    knowledgeId,
    counts: {
      buyers: buyers.payload?.total ?? 0,
      sellers: sellers.payload?.total ?? 0,
      entities: entities.payload?.total ?? 0,
      knowledge: knowledge.payload?.total ?? 0
    }
  };
}

async function runSweep() {
  const bootstrapSteps = await bootstrapLiveData();
  const context = await collectContext();

  if (!context.buyerId || !context.sellerId || !context.entityId || !context.knowledgeId) {
    throw new Error(`Unable to collect live IOC context: ${JSON.stringify(context)}`);
  }

  const checks = [
    ['GET /health', () => request('GET', '/health'), (payload) => payload?.status === 'ok'],
    ['GET /api/entities', () => request('GET', '/api/entities?limit=10'), (payload) => payload?.total >= 1],
    ['GET /api/entities/search', () => request('GET', '/api/entities/search?q=MAIE'), (payload) => payload?.total >= 1],
    ['GET /api/entities/:id/portfolio', () => request('GET', `/api/entities/${context.entityId}/portfolio`), (payload) => Array.isArray(payload?.properties)],
    ['GET /api/entities/lookup', () => request('GET', '/api/entities/lookup?name=MAIE'), (payload) => payload?.kind === 'entity' || payload?.kind === 'property'],
    ['GET /api/buyers', () => request('GET', '/api/buyers?limit=10'), (payload) => payload?.total >= 1],
    ['GET /api/buyers/search', () => request('GET', '/api/buyers/search?q=Mike'), (payload) => payload?.total >= 1],
    ['GET /api/buyers/:id', () => request('GET', `/api/buyers/${context.buyerId}`), (payload) => payload?.id === context.buyerId],
    ['GET /api/buyers/:id/stats', () => request('GET', `/api/buyers/${context.buyerId}/stats`), (payload) => typeof payload?.total_purchases === 'number'],
    ['GET /api/lenders', () => request('GET', '/api/lenders'), (payload) => typeof payload?.total === 'number'],
    ['GET /api/lenders/overlaps', () => request('GET', '/api/lenders/overlaps'), (payload) => typeof payload?.total === 'number'],
    ['GET /api/sellers', () => request('GET', '/api/sellers?limit=10'), (payload) => payload?.total >= 1],
    ['GET /api/sellers/:id', () => request('GET', `/api/sellers/${context.sellerId}`), (payload) => payload?.id === context.sellerId],
    ['GET /api/sellers/by-property/:propertyId', () => request('GET', `/api/sellers/by-property/${context.propertyId}`), (payload) => payload?.property_id === context.propertyId],
    ['GET /api/sellers/distribution', () => request('GET', '/api/sellers/distribution'), (payload) => typeof payload?.scored === 'number'],
    ['GET /api/sellers/distressed', () => request('GET', '/api/sellers/distressed'), (payload) => typeof payload?.total === 'number'],
    ['GET /api/sellers/lender-patterns', () => request('GET', '/api/sellers/lender-patterns'), (payload) => typeof payload?.total === 'number'],
    ['GET /api/knowledge', () => request('GET', '/api/knowledge?limit=10'), (payload) => payload?.total >= 1],
    ['GET /api/knowledge/:id', () => request('GET', `/api/knowledge/${context.knowledgeId}`), (payload) => payload?.id === context.knowledgeId],
    ['POST /api/search', () => request('POST', '/api/search', { body: { query: 'industrial Carson Mike', limit: 5 } }), (payload) => typeof payload?.total === 'number'],
    ['GET /api/properties/:id', () => request('GET', `/api/properties/${context.propertyId}`), (payload) => payload?.id === context.propertyId],
    ['GET /api/matches', () => request('GET', `/api/matches?buyer_profile_id=${context.buyerId}&limit=10`), (payload) => typeof payload?.total === 'number'],
    ['GET /api/matches/top', () => request('GET', '/api/matches/top?limit=10'), (payload) => typeof payload?.total === 'number'],
    ['GET /api/match/distribution', () => request('GET', '/api/match/distribution'), (payload) => typeof payload?.total_matches === 'number']
  ];

  const results = [];

  for (const [name, requestFactory, predicate] of checks) {
    results.push(await assertStep(name, await requestFactory(), predicate));
  }

  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;

  console.log(JSON.stringify({
    base_url: BASE_URL,
    bootstrap: bootstrapSteps,
    context,
    passed,
    failed,
    results
  }, null, 2));

  process.exitCode = failed === 0 && bootstrapSteps.every((step) => step.passed) ? 0 : 1;
}

runSweep().catch((error) => {
  console.error(JSON.stringify({
    error: error.message
  }, null, 2));
  process.exitCode = 1;
});
