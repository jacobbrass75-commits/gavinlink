const db = require('../db/connection');
const classifier = require('../ingestion/classifier');
const ingestionRouter = require('../ingestion/router');
const transcribe = require('../knowledge/transcribe');
const knowledgeSearch = require('../knowledge/search');
const entityCluster = require('../entities/cluster');
const ingestionMerge = require('../ingestion/merge');
const sqlUtils = require('../utils/sql');
const matchingRunner = require('../matching/runner');

function createAppError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

async function getEntityDetail(id) {
  const entityResult = await db.query(
    `
      SELECT id, name, entity_type, source, metadata, created_at, updated_at
      FROM entities
      WHERE id = $1
    `,
    [id]
  );
  const entity = entityResult.rows[0];

  if (!entity) {
    return null;
  }

  const relationshipsResult = await db.query(
    `
      SELECT
        er.id,
        er.relationship_type,
        er.source,
        er.confidence,
        CASE
          WHEN er.parent_entity_id = $1 THEN child.id
          ELSE parent.id
        END AS related_entity_id,
        CASE
          WHEN er.parent_entity_id = $1 THEN child.name
          ELSE parent.name
        END AS related_entity_name,
        CASE
          WHEN er.parent_entity_id = $1 THEN child.entity_type
          ELSE parent.entity_type
        END AS related_entity_type,
        CASE
          WHEN er.parent_entity_id = $1 THEN 'outbound'
          ELSE 'inbound'
        END AS direction
      FROM entity_relationships er
      JOIN entities parent ON parent.id = er.parent_entity_id
      JOIN entities child ON child.id = er.child_entity_id
      WHERE er.parent_entity_id = $1
         OR er.child_entity_id = $1
      ORDER BY er.created_at ASC
    `,
    [id]
  );
  const propertiesResult = await db.query(
    `
      SELECT DISTINCT
        p.id,
        p.apn,
        p.address,
        p.city,
        p.state,
        p.assessed_value,
        p.property_type,
        CASE
          WHEN p.owner_entity_id = $1 THEN 'owner'
          WHEN p.trustee_entity_id = $1 THEN 'trustee'
          ELSE 'lender'
        END AS role
      FROM properties p
      WHERE p.owner_entity_id = $1
         OR p.trustee_entity_id = $1
         OR p.lender_entity_id = $1
      ORDER BY p.address NULLS LAST, p.apn
    `,
    [id]
  );

  return {
    entity: {
      id: entity.id,
      name: entity.name,
      type: entity.entity_type,
      source: entity.source,
      metadata: entity.metadata,
      created_at: entity.created_at,
      updated_at: entity.updated_at
    },
    relationships: relationshipsResult.rows.map((row) => ({
      id: row.id,
      relationship: row.relationship_type,
      source: row.source,
      confidence: row.confidence == null ? null : Number(row.confidence),
      direction: row.direction,
      entity: {
        id: row.related_entity_id,
        name: row.related_entity_name,
        type: row.related_entity_type
      }
    })),
    properties: propertiesResult.rows.map((row) => ({
      id: row.id,
      apn: row.apn,
      address: row.address,
      city: row.city,
      state: row.state,
      assessed_value: row.assessed_value == null ? null : Number(row.assessed_value),
      property_type: row.property_type,
      role: row.role
    }))
  };
}

async function getKnowledgeForEntity(entityId) {
  const result = await db.query(
    `
      SELECT ke.id, ke.title, ke.ai_summary, ke.created_at
      FROM knowledge_entities links
      JOIN knowledge_entries ke ON ke.id = links.knowledge_entry_id
      WHERE links.entity_id = $1
      ORDER BY ke.created_at DESC
      LIMIT 25
    `,
    [entityId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    ai_summary: row.ai_summary,
    created_at: row.created_at
  }));
}

async function getKnowledgeForProperty(propertyId) {
  const result = await db.query(
    `
      SELECT ke.id, ke.title, ke.ai_summary, ke.created_at
      FROM knowledge_properties links
      JOIN knowledge_entries ke ON ke.id = links.knowledge_entry_id
      WHERE links.property_id = $1
      ORDER BY ke.created_at DESC
      LIMIT 25
    `,
    [propertyId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    ai_summary: row.ai_summary,
    created_at: row.created_at
  }));
}

async function ingestMessage({
  message,
  source = 'app',
  sourceFile = null,
  metadata = null,
  channel = null,
  runMatching,
  raw = null
}) {
  const normalizedMessage = String(message || '').trim();

  if (!normalizedMessage) {
    throw createAppError(400, 'message is required');
  }

  const classified = await classifier.classifyMessage(normalizedMessage);
  return ingestionRouter.routeClassifiedMessage(classified, normalizedMessage, {
    source,
    source_file: sourceFile,
    metadata,
    channel,
    runMatching,
    raw
  });
}

async function ingestChannelEvent({ message, source = 'app', metadata = null, channel = null, raw = null }) {
  return ingestMessage({
    message,
    source,
    metadata,
    channel,
    raw
  });
}

async function ingestAudio({ filePath, source = 'voice_memo' }) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw createAppError(400, 'filePath is required');
  }

  return transcribe.processAudioFile(filePath, { source });
}

async function searchBrain({ query, limit, entityIds = [], entryTypes = [] }) {
  const normalizedQuery = String(query || '').trim();

  if (!normalizedQuery) {
    throw createAppError(400, 'query is required');
  }

  const results = await knowledgeSearch.hybridSearch(normalizedQuery, {
    limit,
    entity_ids: entityIds,
    entry_types: entryTypes
  });

  return {
    results,
    total: results.length
  };
}

async function lookupBrain({ name }) {
  const normalizedName = String(name || '').trim();

  if (!normalizedName) {
    throw createAppError(400, 'name is required');
  }

  const exact = await ingestionMerge.findEntityExact(normalizedName);
  const fuzzy = exact ? [] : await ingestionMerge.findEntitiesFuzzy(normalizedName, 0.4);
  const matchedEntity = exact || fuzzy[0] || null;

  if (matchedEntity) {
    const entityDetail = await getEntityDetail(matchedEntity.id);
    const portfolio = await entityCluster.getPortfolio(matchedEntity.id);
    const buyerProfileResult = await db.query(
      `
        SELECT id
        FROM buyer_profiles
        WHERE entity_id = $1
        LIMIT 1
      `,
      [matchedEntity.id]
    );
    const sellerProfilesResult = await db.query(
      `
        SELECT id, property_id, distress_level, motivation
        FROM seller_profiles
        WHERE entity_id = $1
        ORDER BY distress_level DESC NULLS LAST, created_at DESC
      `,
      [matchedEntity.id]
    );

    return {
      kind: 'entity',
      match_type: exact ? 'exact' : 'fuzzy',
      entity: entityDetail.entity,
      relationships: entityDetail.relationships,
      properties: entityDetail.properties,
      portfolio,
      buyer_profile_id: buyerProfileResult.rows[0]?.id || null,
      seller_profiles: sellerProfilesResult.rows,
      knowledge_entries: await getKnowledgeForEntity(matchedEntity.id)
    };
  }

  const propertyResult = await db.query(
    `
      SELECT *,
             similarity(COALESCE(address, ''), $1) AS score
      FROM properties
      WHERE apn = $1
         OR COALESCE(address, '') ILIKE $2 ESCAPE '\\'
         OR similarity(COALESCE(address, ''), $1) >= 0.35
      ORDER BY
        CASE WHEN apn = $1 THEN 1 ELSE 2 END,
        score DESC,
        address ASC
      LIMIT 1
    `,
    [normalizedName, sqlUtils.buildContainsPattern(normalizedName)]
  );
  const property = propertyResult.rows[0];

  if (!property) {
    throw createAppError(404, 'No entity or property found for lookup');
  }

  const sellerProfileResult = await db.query(
    `
      SELECT id, distress_level, motivation, foreclosure_stage
      FROM seller_profiles
      WHERE property_id = $1
      LIMIT 1
    `,
    [property.id]
  );
  const relatedEntitiesResult = await db.query(
    `
      SELECT id, name, entity_type
      FROM entities
      WHERE id IN ($1, $2, $3)
    `,
    [property.owner_entity_id, property.trustee_entity_id, property.lender_entity_id]
  );

  return {
    kind: 'property',
    property: {
      id: property.id,
      apn: property.apn,
      address: property.address,
      city: property.city,
      property_type: property.property_type,
      assessed_value: property.assessed_value == null ? null : Number(property.assessed_value),
      foreclosure: property.foreclosure
    },
    seller_profile: sellerProfileResult.rows[0] || null,
    linked_entities: relatedEntitiesResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.entity_type
    })),
    knowledge_entries: await getKnowledgeForProperty(property.id)
  };
}

async function getDailyBrief() {
  const actionItemsResult = await db.query(
    `
      SELECT id, ai_summary, ai_action_items, created_at
      FROM knowledge_entries
      WHERE jsonb_array_length(ai_action_items) > 0
      ORDER BY created_at DESC
      LIMIT 10
    `
  );
  const sellerResult = await db.query(
    `
      SELECT sp.id, e.name AS entity_name, p.address, sp.distress_level
      FROM seller_profiles sp
      JOIN entities e ON e.id = sp.entity_id
      JOIN properties p ON p.id = sp.property_id
      WHERE sp.active = TRUE
      ORDER BY sp.distress_level DESC NULLS LAST, p.assessed_value DESC NULLS LAST
      LIMIT 5
    `
  );

  return {
    action_items: actionItemsResult.rows.flatMap((row) =>
      (row.ai_action_items || []).map((item) => ({
        knowledge_entry_id: row.id,
        summary: row.ai_summary,
        action: item,
        created_at: row.created_at
      }))
    ),
    distressed_sellers: sellerResult.rows.map((row) => ({
      seller_profile_id: row.id,
      entity_name: row.entity_name,
      address: row.address,
      distress_level: row.distress_level
    }))
  };
}

async function matchIdentifier({
  identifier,
  limit = 10,
  minScore,
  dryRun = false,
  generateNarratives = false
}) {
  const normalizedIdentifier = String(identifier || '').trim();

  if (!normalizedIdentifier) {
    throw createAppError(400, 'identifier is required');
  }

  const target = await matchingRunner.lookupIdentifier(normalizedIdentifier);

  if (!target) {
    throw createAppError(404, 'No buyer or property matched that identifier.');
  }

  const matchOptions = {
    minScore,
    dryRun: Boolean(dryRun),
    generateNarratives: Boolean(generateNarratives)
  };
  const matches =
    target.kind === 'buyer'
      ? await matchingRunner.runMatchingForBuyer(target.entity_id, matchOptions)
      : await matchingRunner.runMatchingForProperty(target.property_id, matchOptions);

  return {
    identifier: normalizedIdentifier,
    kind: target.kind,
    matches: matches.slice(0, Math.min(parsePositiveInteger(limit, 10) || 10, 50)),
    total: matches.length
  };
}

async function lookupLocalEntityForRealNex({ entityId, name, email, phone, company }) {
  if (entityId && !isUuid(entityId)) {
    throw createAppError(400, 'entityId must be a valid UUID');
  }

  if (!entityId) {
    return {
      entity: null,
      disambiguation_input: {
        name: name || null,
        email: email || null,
        phone: phone || null,
        company: company || null
      }
    };
  }

  const result = await db.query(
    `
      SELECT id, name, entity_type, phone, metadata
      FROM entities
      WHERE id = $1
      LIMIT 1
    `,
    [entityId]
  );
  const entity = result.rows[0];

  if (!entity) {
    throw createAppError(404, 'Entity not found');
  }

  const metadata = entity.metadata || {};
  return {
    entity,
    disambiguation_input: {
      name: name || entity.name || null,
      email: email || metadata.email || null,
      phone: phone || entity.phone || metadata.phone || null,
      company: company || metadata.company || null
    }
  };
}

module.exports = {
  createAppError,
  toNumber,
  getEntityDetail,
  ingestMessage,
  ingestChannelEvent,
  ingestAudio,
  searchBrain,
  lookupBrain,
  getDailyBrief,
  matchIdentifier,
  lookupLocalEntityForRealNex
};
