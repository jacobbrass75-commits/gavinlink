const { v4: uuidv4 } = require('uuid');
const { query } = require('../db/connection');
const { deleteEmbedding } = require('./embeddings');

const ALLOWED_ENTRY_TYPES = new Set([
  'call_transcript',
  'call_note',
  'meeting_note',
  'market_insight',
  'email',
  'document',
  'other'
]);

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function cleanStringArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return [...new Set(values.map((value) => cleanText(value, null)).filter(Boolean))];
}

function normalizeEntryType(data = {}) {
  const explicit = cleanText(data.entry_type, null);

  if (explicit && ALLOWED_ENTRY_TYPES.has(explicit)) {
    return explicit;
  }

  if (data.source === 'voice_memo') {
    return 'call_transcript';
  }

  if (Array.isArray(data.ai_classifications) && data.ai_classifications.includes('market_insight')) {
    return 'market_insight';
  }

  if (Array.isArray(data.ai_classifications) && data.ai_classifications.includes('deal_update')) {
    return 'meeting_note';
  }

  if (data.source === 'email') {
    return 'email';
  }

  return 'call_note';
}

function toKnowledgeEntry(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    entry_type: row.entry_type,
    title: row.title,
    content: row.content,
    summary: row.summary,
    source: row.source,
    source_file: row.source_file,
    property_id: row.property_id,
    entity_id: row.entity_id,
    author_entity_id: row.author_entity_id,
    chroma_id: row.chroma_id || row.embedding_ref,
    recorded_at: row.recorded_at,
    duration_seconds: row.duration_seconds,
    ai_summary: row.ai_summary,
    ai_action_items: row.ai_action_items || [],
    ai_tags: row.ai_tags || [],
    ai_classifications: row.ai_classifications || [],
    metadata: row.metadata || {},
    occurred_at: row.occurred_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function linkEntityToKnowledge(knowledgeEntryId, entityId) {
  if (!knowledgeEntryId || !entityId) {
    return false;
  }

  await query(
    `
      INSERT INTO knowledge_entities (knowledge_entry_id, entity_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `,
    [knowledgeEntryId, entityId]
  );

  return true;
}

async function linkPropertyToKnowledge(knowledgeEntryId, propertyId) {
  if (!knowledgeEntryId || !propertyId) {
    return false;
  }

  await query(
    `
      INSERT INTO knowledge_properties (knowledge_entry_id, property_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `,
    [knowledgeEntryId, propertyId]
  );

  return true;
}

async function createKnowledgeEntry(data) {
  const content = cleanText(data.content, null);

  if (!content) {
    throw new Error('content is required');
  }

  const id = uuidv4();
  const result = await query(
    `
      INSERT INTO knowledge_entries (
        id,
        entry_type,
        title,
        content,
        summary,
        source,
        source_file,
        property_id,
        entity_id,
        author_entity_id,
        embedding_ref,
        chroma_id,
        metadata,
        occurred_at,
        recorded_at,
        duration_seconds,
        ai_summary,
        ai_action_items,
        ai_tags,
        ai_classifications
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16,
        $17, $18::jsonb, $19::text[], $20::text[]
      )
      RETURNING *
    `,
    [
      id,
      normalizeEntryType(data),
      cleanText(data.title, content.slice(0, 80)),
      content,
      cleanText(data.summary, null),
      cleanText(data.source, 'api'),
      cleanText(data.source_file, null),
      data.property_id || null,
      data.entity_id || null,
      data.author_entity_id || null,
      cleanText(data.embedding_ref, null),
      cleanText(data.chroma_id, null),
      JSON.stringify(data.metadata || {}),
      data.occurred_at || null,
      data.recorded_at || null,
      data.duration_seconds == null ? null : Number(data.duration_seconds),
      cleanText(data.ai_summary, null),
      JSON.stringify(Array.isArray(data.ai_action_items) ? data.ai_action_items : []),
      cleanStringArray(data.ai_tags),
      cleanStringArray(data.ai_classifications)
    ]
  );

  const entry = result.rows[0];

  for (const entityId of cleanStringArray(data.entity_ids)) {
    await linkEntityToKnowledge(id, entityId);
  }

  for (const propertyId of cleanStringArray(data.property_ids)) {
    await linkPropertyToKnowledge(id, propertyId);
  }

  return getKnowledgeEntry(entry.id);
}

async function getLinkedEntities(knowledgeEntryId) {
  const result = await query(
    `
      SELECT e.id, e.name, e.entity_type
      FROM knowledge_entities ke
      JOIN entities e ON e.id = ke.entity_id
      WHERE ke.knowledge_entry_id = $1
      ORDER BY e.name ASC
    `,
    [knowledgeEntryId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.entity_type
  }));
}

async function getLinkedProperties(knowledgeEntryId) {
  const result = await query(
    `
      SELECT p.id, p.apn, p.address, p.city, p.property_type
      FROM knowledge_properties kp
      JOIN properties p ON p.id = kp.property_id
      WHERE kp.knowledge_entry_id = $1
      ORDER BY p.address NULLS LAST, p.apn
    `,
    [knowledgeEntryId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    apn: row.apn,
    address: row.address,
    city: row.city,
    property_type: row.property_type
  }));
}

async function getKnowledgeEntry(id) {
  const result = await query(
    `
      SELECT *
      FROM knowledge_entries
      WHERE id = $1
    `,
    [id]
  );
  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return {
    ...toKnowledgeEntry(row),
    linked_entities: await getLinkedEntities(id),
    linked_properties: await getLinkedProperties(id)
  };
}

async function listKnowledgeEntries(filters = {}) {
  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 100);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  const source = cleanText(filters.source, null);
  const entityId = cleanText(filters.entity_id, null);
  const propertyId = cleanText(filters.property_id, null);
  const classifications = cleanStringArray(filters.classifications);

  const countResult = await query(
    `
      SELECT COUNT(DISTINCT ke.id)::int AS count
      FROM knowledge_entries ke
      LEFT JOIN knowledge_entities links_e ON links_e.knowledge_entry_id = ke.id
      LEFT JOIN knowledge_properties links_p ON links_p.knowledge_entry_id = ke.id
      WHERE ($1::text IS NULL OR ke.source = $1)
        AND ($2::uuid IS NULL OR links_e.entity_id = $2)
        AND ($3::uuid IS NULL OR links_p.property_id = $3)
        AND ($4::text[] = ARRAY[]::text[] OR ke.ai_classifications && $4::text[])
    `,
    [source, entityId, propertyId, classifications]
  );
  const rowsResult = await query(
    `
      SELECT DISTINCT ke.*
      FROM knowledge_entries ke
      LEFT JOIN knowledge_entities links_e ON links_e.knowledge_entry_id = ke.id
      LEFT JOIN knowledge_properties links_p ON links_p.knowledge_entry_id = ke.id
      WHERE ($1::text IS NULL OR ke.source = $1)
        AND ($2::uuid IS NULL OR links_e.entity_id = $2)
        AND ($3::uuid IS NULL OR links_p.property_id = $3)
        AND ($4::text[] = ARRAY[]::text[] OR ke.ai_classifications && $4::text[])
      ORDER BY COALESCE(ke.recorded_at, ke.created_at) DESC, ke.id DESC
      LIMIT $5
      OFFSET $6
    `,
    [source, entityId, propertyId, classifications, limit, offset]
  );

  return {
    results: await Promise.all(rowsResult.rows.map((row) => getKnowledgeEntry(row.id))),
    total: countResult.rows[0].count,
    limit,
    offset
  };
}

async function deleteKnowledgeEntry(id) {
  const existing = await getKnowledgeEntry(id);

  if (!existing) {
    return false;
  }

  if (existing.chroma_id) {
    try {
      await deleteEmbedding(existing.chroma_id);
    } catch (_error) {
      // Best effort; DB delete still proceeds.
    }
  }

  await query(
    `
      DELETE FROM knowledge_entries
      WHERE id = $1
    `,
    [id]
  );

  return true;
}

module.exports = {
  createKnowledgeEntry,
  getKnowledgeEntry,
  listKnowledgeEntries,
  deleteKnowledgeEntry,
  linkEntityToKnowledge,
  linkPropertyToKnowledge
};
