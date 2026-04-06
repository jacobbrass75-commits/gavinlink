const { query } = require('../db/connection');
const { generateEmbedding, getKnowledgeCollection } = require('./embeddings');
const { getKnowledgeEntry } = require('./extract');

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

function metadataMatchesFilters(metadata = {}, options = {}) {
  const entityIds = cleanStringArray(options.entity_ids);
  const entryTypes = cleanStringArray(options.entry_types);

  if (entityIds.length > 0) {
    const metadataEntityIds = cleanStringArray(metadata.entity_ids || []);

    if (!entityIds.some((id) => metadataEntityIds.includes(id))) {
      return false;
    }
  }

  if (entryTypes.length > 0) {
    const classifications = cleanStringArray(metadata.classifications || []);

    if (!entryTypes.some((value) => classifications.includes(value))) {
      return false;
    }
  }

  return true;
}

async function fetchKnowledgeResultsByIds(idsWithScore) {
  const results = [];

  for (const item of idsWithScore) {
    const knowledgeEntry = await getKnowledgeEntry(item.id);

    if (!knowledgeEntry) {
      continue;
    }

    results.push({
      knowledge_entry: {
        id: knowledgeEntry.id,
        title: knowledgeEntry.title,
        content: knowledgeEntry.content,
        source: knowledgeEntry.source,
        created_at: knowledgeEntry.created_at
      },
      relevance_score: item.score,
      linked_entities: knowledgeEntry.linked_entities,
      linked_properties: knowledgeEntry.linked_properties
    });
  }

  return results;
}

async function keywordSearch(searchQuery, options = {}) {
  const q = cleanText(searchQuery, null);

  if (!q) {
    return [];
  }

  const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 50);
  const entityIds = cleanStringArray(options.entity_ids);
  const entryTypes = cleanStringArray(options.entry_types);
  const rowsResult = await query(
    `
      WITH scored AS (
        SELECT
          ke.id,
          ke.created_at,
          GREATEST(
            similarity(COALESCE(ke.title, ''), $1),
            similarity(COALESCE(ke.ai_summary, ''), $1),
            CASE
              WHEN ke.content ILIKE $2 THEN 0.9
              WHEN COALESCE(ke.summary, '') ILIKE $2 THEN 0.8
              WHEN COALESCE(e.name, '') ILIKE $2 THEN 0.8
              WHEN COALESCE(p.address, '') ILIKE $2 THEN 0.75
              WHEN COALESCE(p.apn, '') ILIKE $2 THEN 0.75
              ELSE 0
            END
          ) AS score
        FROM knowledge_entries ke
        LEFT JOIN knowledge_entities links_e ON links_e.knowledge_entry_id = ke.id
        LEFT JOIN entities e ON e.id = links_e.entity_id
        LEFT JOIN knowledge_properties links_p ON links_p.knowledge_entry_id = ke.id
        LEFT JOIN properties p ON p.id = links_p.property_id
        WHERE (
            ke.content ILIKE $2
            OR COALESCE(ke.summary, '') ILIKE $2
            OR COALESCE(ke.ai_summary, '') ILIKE $2
            OR COALESCE(e.name, '') ILIKE $2
            OR COALESCE(p.address, '') ILIKE $2
            OR COALESCE(p.apn, '') ILIKE $2
            OR similarity(COALESCE(ke.title, ''), $1) >= 0.2
            OR similarity(COALESCE(ke.ai_summary, ''), $1) >= 0.2
          )
          AND ($3::uuid[] = ARRAY[]::uuid[] OR links_e.entity_id = ANY($3::uuid[]))
          AND ($4::text[] = ARRAY[]::text[] OR ke.ai_classifications && $4::text[])
      )
      SELECT DISTINCT ON (id)
        id,
        score,
        created_at
      FROM scored
      ORDER BY id, score DESC, created_at DESC
    `,
    [q, `%${q}%`, entityIds, entryTypes]
  );
  const orderedRows = rowsResult.rows
    .sort((left, right) => {
      const scoreDelta = Number(right.score) - Number(left.score);

      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      return new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
    })
    .slice(0, limit);

  return fetchKnowledgeResultsByIds(
    orderedRows.map((row) => ({
      id: row.id,
      score: Number(row.score)
    }))
  );
}

async function semanticSearch(searchQuery, options = {}) {
  const q = cleanText(searchQuery, null);

  if (!q) {
    return [];
  }

  const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 50);

  try {
    const collection = await getKnowledgeCollection();
    const embedding = await generateEmbedding(q);
    const queryResult = await collection.query({
      queryEmbeddings: [embedding],
      nResults: Math.max(limit * 3, limit),
      include: ['documents', 'metadatas', 'distances']
    });
    const ids = queryResult.ids?.[0] || [];
    const metadatas = queryResult.metadatas?.[0] || [];
    const distances = queryResult.distances?.[0] || [];
    const filtered = ids
      .map((id, index) => ({
        id,
        metadata: metadatas[index] || {},
        score: Number.isFinite(Number(distances[index]))
          ? 1 / (1 + Number(distances[index]))
          : 0.5
      }))
      .filter((item) => metadataMatchesFilters(item.metadata, options))
      .slice(0, limit);

    if (filtered.length === 0) {
      return [];
    }

    return fetchKnowledgeResultsByIds(filtered);
  } catch (_error) {
    return keywordSearch(q, options);
  }
}

async function hybridSearch(searchQuery, options = {}) {
  const [semanticResults, keywordResults] = await Promise.all([
    semanticSearch(searchQuery, {
      ...options,
      limit: Math.max(Number(options.limit) || 10, 10)
    }),
    keywordSearch(searchQuery, {
      ...options,
      limit: Math.max(Number(options.limit) || 10, 10)
    })
  ]);
  const merged = new Map();

  for (const result of [...semanticResults, ...keywordResults]) {
    const existing = merged.get(result.knowledge_entry.id);

    if (!existing) {
      merged.set(result.knowledge_entry.id, result);
      continue;
    }

    existing.relevance_score = Math.max(existing.relevance_score, result.relevance_score);
  }

  return [...merged.values()]
    .sort((left, right) => right.relevance_score - left.relevance_score)
    .slice(0, Math.min(Math.max(Number(options.limit) || 10, 1), 50));
}

module.exports = {
  semanticSearch,
  hybridSearch
};
