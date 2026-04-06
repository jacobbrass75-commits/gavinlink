const path = require('path');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../db/connection');
const { classifyEntityType, normalizeName } = require('./extract');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function firstString(record, keys) {
  for (const key of keys) {
    const value = record?.[key];

    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }

  return null;
}

function toMembers(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') {
          return item.trim();
        }

        return firstString(item, ['name', 'member_name', 'memberName']);
      })
      .filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(/[,;\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeSearchPayload(payload, entityName) {
  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.results)
      ? payload.results
      : Array.isArray(payload?.businesses)
        ? payload.businesses
        : payload && typeof payload === 'object'
          ? [payload]
          : [];
  const normalizedTarget = normalizeName(entityName);
  const match = candidates.find((candidate) => {
    const candidateName = normalizeName(
      firstString(candidate, ['name', 'business_name', 'businessName', 'entity_name', 'entityName'])
    );

    return candidateName !== '' && (
      candidateName.includes(normalizedTarget) ||
      normalizedTarget.includes(candidateName)
    );
  }) || candidates[0];

  if (!match) {
    return null;
  }

  return {
    agent_name: firstString(match, ['agent_name', 'agentName', 'service_of_process', 'agent']),
    agent_address: firstString(match, ['agent_address', 'agentAddress', 'address']),
    members: toMembers(match.members || match.member_names || match.memberNames),
    status: firstString(match, ['status', 'standing']),
    filing_date: firstString(match, ['filing_date', 'filingDate', 'registration_date', 'registrationDate'])
  };
}

function parseHtmlResponse(html, entityName) {
  if (/captcha|g-recaptcha|cloudflare/i.test(html)) {
    console.warn(`SOS lookup unavailable for ${entityName}, manual resolution needed`);
    return null;
  }

  if (!html.toUpperCase().includes(normalizeName(entityName))) {
    return null;
  }

  const agentNameMatch = html.match(/Agent(?: Name)?[^<]*<\/[^>]+>\s*<[^>]*>([^<]+)/i);
  const agentAddressMatch = html.match(/Agent Address[^<]*<\/[^>]+>\s*<[^>]*>([^<]+)/i);
  const statusMatch = html.match(/Status[^<]*<\/[^>]+>\s*<[^>]*>([^<]+)/i);
  const filingDateMatch = html.match(/(?:Filed|Filing Date)[^<]*<\/[^>]+>\s*<[^>]*>([^<]+)/i);

  if (!agentNameMatch && !statusMatch) {
    return null;
  }

  return {
    agent_name: agentNameMatch?.[1]?.trim() || null,
    agent_address: agentAddressMatch?.[1]?.trim() || null,
    members: [],
    status: statusMatch?.[1]?.trim() || null,
    filing_date: filingDateMatch?.[1]?.trim() || null
  };
}

async function fetchSearchResponse(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json, text/html, */*'
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return {
    contentType: response.headers.get('content-type') || '',
    body: await response.text()
  };
}

async function searchSecretaryOfState(entityName) {
  if (typeof entityName !== 'string' || entityName.trim() === '') {
    return null;
  }

  const query = entityName.trim();
  const endpoints = [];

  if (process.env.CA_SOS_SEARCH_URL) {
    endpoints.push(process.env.CA_SOS_SEARCH_URL);
  }

  endpoints.push('https://bizfileonline.sos.ca.gov/search/business');

  for (const endpoint of endpoints) {
    try {
      const url = new URL(endpoint);

      if (url.hostname === 'bizfileonline.sos.ca.gov') {
        url.searchParams.set('SearchType', 'Keyword');
        url.searchParams.set('SearchCriteria', query);
      } else if (!url.searchParams.has('q') && !url.searchParams.has('query')) {
        url.searchParams.set('q', query);
      }

      const response = await fetchSearchResponse(url);

      if (
        response.contentType.includes('application/json') ||
        response.body.trim().startsWith('{') ||
        response.body.trim().startsWith('[')
      ) {
        return normalizeSearchPayload(JSON.parse(response.body), query);
      }

      const parsed = parseHtmlResponse(response.body, query);

      if (parsed) {
        return parsed;
      }
    } catch (error) {
      console.warn(`SOS lookup unavailable for ${query}, manual resolution needed (${error.message})`);
    }
  }

  return null;
}

async function upsertRelationship(client, parentEntityId, childEntityId, relationshipType) {
  const result = await client.query(
    `
      INSERT INTO entity_relationships (
        id,
        parent_entity_id,
        child_entity_id,
        relationship_type,
        source,
        confidence
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (parent_entity_id, child_entity_id, relationship_type)
      DO NOTHING
    `,
    [uuidv4(), parentEntityId, childEntityId, relationshipType, 'secretary_of_state', 0.8]
  );

  return result.rowCount;
}

async function upsertRelatedEntity(client, name) {
  const normalizedName = normalizeName(name);
  const entityType = classifyEntityType(name);
  const result = await client.query(
    `
      INSERT INTO entities (
        id,
        name,
        normalized_name,
        entity_type,
        source,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (normalized_name, entity_type)
      DO UPDATE SET
        updated_at = NOW(),
        metadata = entities.metadata || EXCLUDED.metadata
      RETURNING id, (xmax = 0) AS inserted
    `,
    [
      uuidv4(),
      name.trim(),
      normalizedName,
      entityType,
      'secretary_of_state',
      JSON.stringify({
        source: 'secretary_of_state'
      })
    ]
  );

  return result.rows[0];
}

async function updateSosMetadata(client, entityId, payload) {
  await client.query(
    `
      UPDATE entities
      SET metadata = metadata || $2::jsonb,
          updated_at = NOW()
      WHERE id = $1
    `,
    [entityId, JSON.stringify(payload)]
  );
}

async function resolveLLC(entityId, entityName) {
  const pool = getPool();
  const client = await pool.connect();
  let peopleCreated = 0;
  let relationshipsCreated = 0;

  try {
    await client.query('BEGIN');

    const searchResult = await searchSecretaryOfState(entityName);

    if (!searchResult) {
      await updateSosMetadata(client, entityId, {
        sos_status: 'manual_needed'
      });
      await client.query('COMMIT');
      return {
        people_created: 0,
        relationships_created: 0
      };
    }

    await updateSosMetadata(client, entityId, {
      sos_status: 'resolved',
      sos_agent_name: searchResult.agent_name,
      sos_agent_address: searchResult.agent_address,
      sos_status_text: searchResult.status,
      sos_filing_date: searchResult.filing_date
    });

    const people = [];

    if (searchResult.agent_name) {
      people.push({
        name: searchResult.agent_name,
        relationship_type: 'registered_agent'
      });
    }

    for (const memberName of searchResult.members) {
      people.push({
        name: memberName,
        relationship_type: 'member'
      });
    }

    for (const person of people) {
      const upserted = await upsertRelatedEntity(client, person.name);

      if (upserted.inserted) {
        peopleCreated += 1;
      }

      relationshipsCreated += await upsertRelationship(
        client,
        upserted.id,
        entityId,
        person.relationship_type
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return {
    people_created: peopleCreated,
    relationships_created: relationshipsCreated
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function batchResolveLLCs({ limit = 50, delayMs = 1000 } = {}) {
  const pool = getPool();
  const entitiesResult = await pool.query(
    `
      SELECT id, name
      FROM entities
      WHERE entity_type IN ('llc', 'corporation')
        AND COALESCE(metadata->>'sos_status', 'pending') <> 'resolved'
      ORDER BY created_at ASC
      LIMIT $1
    `,
    [limit]
  );
  let resolved = 0;
  let failed = 0;
  let skipped = 0;

  for (const entity of entitiesResult.rows) {
    try {
      const result = await resolveLLC(entity.id, entity.name);

      if (result.people_created > 0 || result.relationships_created > 0) {
        resolved += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      failed += 1;
      console.warn(`SOS lookup unavailable for ${entity.name}, manual resolution needed (${error.message})`);
    }

    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return {
    resolved,
    failed,
    skipped
  };
}

module.exports = {
  searchSecretaryOfState,
  resolveLLC,
  batchResolveLLCs
};
