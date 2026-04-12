const { v4: uuidv4 } = require('uuid');
const { query } = require('../db/connection');
const { findOrCreateEntity, findEntityExact } = require('./merge');
const { createKnowledgeEntry, linkEntityToKnowledge, linkPropertyToKnowledge } = require('../knowledge/extract');
const { storeEmbedding } = require('../knowledge/embeddings');
const { createBuyerProfile, updateBuyerProfile, getBuyerProfileByEntity } = require('../buyers/profiles');
const { createSellerProfile, updateSellerProfile, getSellerProfileByProperty } = require('../sellers/profiles');
const { validateClassification } = require('./classifier');
const { normalizeName } = require('../entities/extract');
const { buildContainsPattern } = require('../utils/sql');
const { enqueueKnowledgeEntryPromotion, shouldAutoPromoteEntry } = require('../wiki/queue');

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function cleanStringArray(values = []) {
  if (!Array.isArray(values)) {
    return [];
  }

  return [...new Set(values.map((value) => cleanText(value, null)).filter(Boolean))];
}

async function findExistingKnowledgeEntryForIngest(source, options = {}) {
  const messageId = cleanText(options.metadata?.message_id, null);
  const channel = cleanText(options.channel, null);

  if (!messageId) {
    return null;
  }

  const result = await query(
    `
      SELECT id, title, ai_summary
      FROM knowledge_entries
      WHERE source = $1
        AND metadata -> 'ingest_context' ->> 'message_id' = $2
        AND (
          $3::text IS NULL
          OR metadata ->> 'channel' = $3
        )
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [source, messageId, channel]
  );

  return result.rows[0] || null;
}

async function findPropertyByReference(propertyRef) {
  if (!propertyRef) {
    return null;
  }

  const apn = cleanText(propertyRef.apn, null);
  const address = cleanText(propertyRef.address, null);

  if (apn) {
    const exactApn = await query(
      `
        SELECT *
        FROM properties
        WHERE apn = $1
        ORDER BY created_at ASC
        LIMIT 1
      `,
      [apn]
    );

    if (exactApn.rows[0]) {
      return exactApn.rows[0];
    }
  }

  if (!address) {
    return null;
  }

  const fuzzyAddress = await query(
    `
      SELECT *,
             similarity(COALESCE(address, ''), $1) AS score
      FROM properties
      WHERE similarity(COALESCE(address, ''), $1) >= 0.35
         OR COALESCE(address, '') ILIKE $2 ESCAPE '\\'
      ORDER BY score DESC, address ASC
      LIMIT 1
    `,
    [address, buildContainsPattern(address)]
  );

  return fuzzyAddress.rows[0] || null;
}

async function createRelationship(parentId, childId, relationshipType, source) {
  if (!parentId || !childId || !relationshipType || parentId === childId) {
    return false;
  }

  await query(
    `
      INSERT INTO entity_relationships (
        id,
        parent_entity_id,
        child_entity_id,
        relationship_type,
        source,
        confidence,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, 0.9, '{}'::jsonb)
      ON CONFLICT (parent_entity_id, child_entity_id, relationship_type)
      DO NOTHING
    `,
    [uuidv4(), parentId, childId, relationshipType, source]
  );

  return true;
}

async function processBuyerProfile(profile, entityDirectory, created, updated) {
  if (!profile?.entity_name) {
    return { profile: null, entity: null };
  }

  const entityRecord =
    entityDirectory.get(normalizeName(profile.entity_name)) ||
    (await findOrCreateEntity({
      name: profile.entity_name,
      type: 'person'
    }));
  const entity = entityRecord.entity || entityRecord;
  const existingProfile = await getBuyerProfileByEntity(entity.id);
  let buyerProfile;

  if (existingProfile) {
    buyerProfile = await updateBuyerProfile(existingProfile.id, profile);
    updated.push(`Updated buyer profile for ${buyerProfile.entity_name}`);
  } else {
    buyerProfile = await createBuyerProfile({
      ...profile,
      entity_name: entity.name
    });
    created.push(`Created buyer profile for ${buyerProfile.entity_name}`);
  }

  return { profile: buyerProfile, entity };
}

async function processSellerProfile(profile, property, created, updated) {
  if (!profile || !property?.id) {
    return null;
  }

  const existingProfile = await getSellerProfileByProperty(property.id);

  if (existingProfile) {
    const nextProfile = await updateSellerProfile(existingProfile.id, profile);
    updated.push(`Updated seller profile for ${property.address || property.apn}`);
    return nextProfile;
  }

  const nextProfile = await createSellerProfile({
    ...profile,
    property_id: property.id,
    entity_id: property.owner_entity_id || null
  });
  created.push(`Created seller profile for ${property.address || property.apn}`);
  return nextProfile;
}

async function safeRunMatching(entityId) {
  if (!entityId) {
    return [];
  }

  try {
    const matching = require('../matching/runner.js');

    if (matching && typeof matching.runMatchingForBuyer === 'function') {
      return await matching.runMatchingForBuyer(entityId);
    }
  } catch (_error) {
    // Module 6 not built yet.
  }

  return [];
}

async function routeClassifiedMessage(classified, rawMessage, options = {}) {
  const normalized = validateClassification(classified);
  const source = cleanText(options.source, 'api');
  const existingKnowledgeEntry = await findExistingKnowledgeEntryForIngest(source, options);

  if (existingKnowledgeEntry) {
    return {
      created: [],
      updated: [
        `Skipped duplicate ingest event for message ${cleanText(options.metadata?.message_id, 'unknown')}`
      ],
      linked: [],
      matches: [],
      action_items: [],
      knowledge_entry_id: existingKnowledgeEntry.id,
      summary: existingKnowledgeEntry.ai_summary || existingKnowledgeEntry.title || null,
      deduplicated: true
    };
  }

  const created = [];
  const updated = [];
  const linked = [];
  const entityDirectory = new Map();

  for (const entityData of normalized.entities) {
    const result = await findOrCreateEntity(entityData);
    entityDirectory.set(normalizeName(result.entity.name), result);

    if (result.action === 'created') {
      created.push(`Created entity: ${result.entity.name} (${result.entity.entity_type})`);
    } else if (result.action === 'fuzzy_matched') {
      updated.push(`Matched entity: ${entityData.name} -> ${result.entity.name}`);
    }
  }

  for (const relationship of normalized.relationships) {
    const left =
      entityDirectory.get(normalizeName(relationship.entity_a)) ||
      (await findOrCreateEntity({ name: relationship.entity_a, type: 'person' }));
    const right =
      entityDirectory.get(normalizeName(relationship.entity_b)) ||
      (await findOrCreateEntity({ name: relationship.entity_b, type: 'company' }));
    const createdLink = await createRelationship(
      left.entity.id,
      right.entity.id,
      relationship.relationship,
      source
    );

    entityDirectory.set(normalizeName(left.entity.name), left);
    entityDirectory.set(normalizeName(right.entity.name), right);

    if (createdLink) {
      linked.push(`${left.entity.name} → ${relationship.relationship} → ${right.entity.name}`);
    }
  }

  const property = await findPropertyByReference(normalized.property_ref);
  const buyerResult = normalized.buyer_profile
    ? await processBuyerProfile(normalized.buyer_profile, entityDirectory, created, updated)
    : { profile: null, entity: null };
  const sellerProfile = normalized.seller_profile
    ? await processSellerProfile(normalized.seller_profile, property, created, updated)
    : null;

  if (buyerResult.entity) {
    entityDirectory.set(normalizeName(buyerResult.entity.name), {
      entity: buyerResult.entity,
      action: 'found'
    });
  }

  const entityIds = cleanStringArray(
    [
      ...[...entityDirectory.values()].map((entry) => entry.entity?.id || entry.id || null),
      property?.owner_entity_id || null,
      property?.trustee_entity_id || null,
      property?.lender_entity_id || null,
      sellerProfile?.entity_id || null
    ]
  );
  const propertyIds = cleanStringArray([
    property?.id || null,
    sellerProfile?.property_id || null
  ]);
  const aiTags = cleanStringArray([
    ...normalized.classifications,
    ...normalized.entities.map((entity) => entity.type),
    property?.city || null
  ]);
  const knowledgeEntry = await createKnowledgeEntry({
    title: normalized.summary,
    content: rawMessage,
    summary: normalized.summary,
    source,
    source_file: cleanText(options.source_file, null),
    property_id: property?.id || null,
    entity_id: buyerResult.entity?.id || entityIds[0] || null,
    metadata: {
      classifications: normalized.classifications,
      property_ref: normalized.property_ref,
      routed_by: 'module_05',
      ...(options.channel ? { channel: options.channel } : {}),
      ...(options.metadata ? { ingest_context: options.metadata } : {})
    },
    ai_summary: normalized.summary,
    ai_action_items: normalized.action_items,
    ai_tags: aiTags,
    ai_classifications: normalized.classifications,
    entity_ids: entityIds,
    property_ids: propertyIds
  });

  for (const entityId of entityIds) {
    await linkEntityToKnowledge(knowledgeEntry.id, entityId);
  }

  for (const propertyId of propertyIds) {
    await linkPropertyToKnowledge(knowledgeEntry.id, propertyId);
  }

  try {
    const chroma = await storeEmbedding(knowledgeEntry.id, rawMessage, {
      entity_ids: entityIds,
      property_ids: propertyIds,
      source,
      classifications: normalized.classifications
    });

    await query(
      `
        UPDATE knowledge_entries
        SET chroma_id = $2,
            embedding_ref = $2,
            updated_at = NOW()
        WHERE id = $1
      `,
      [knowledgeEntry.id, chroma.chroma_id]
    );
  } catch (_error) {
    // Keep the ingestion path usable even if Chroma is temporarily unavailable.
  }

  if (shouldAutoPromoteEntry(knowledgeEntry)) {
    try {
      await enqueueKnowledgeEntryPromotion({
        knowledge_entry_id: knowledgeEntry.id,
        reason: 'ingestion_high_signal'
      });
    } catch (_error) {
      // Keep ingestion usable even if the narrative queue has a transient issue.
    }
  }

  let matches = [];

  if (normalized.classifications.includes('buyer_intel') && options.runMatching !== false) {
    matches = await safeRunMatching(buyerResult.entity?.id || null);
  }

  return {
    created,
    updated,
    linked,
    matches,
    action_items: normalized.action_items,
    knowledge_entry_id: knowledgeEntry.id,
    summary: normalized.summary
  };
}

module.exports = {
  routeClassifiedMessage
};
