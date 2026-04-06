const provider = require('../inference/provider');

const COLLECTION_NAME = process.env.CHROMA_COLLECTION || 'knowledge_entries';
let chromaClientPromise;
let collectionPromise;

function getChromaUrl() {
  return process.env.CHROMA_URL || `http://${process.env.CHROMA_HOST || 'localhost'}:${process.env.CHROMA_PORT || 8000}`;
}

function cleanArray(values = []) {
  return values.filter((value) => value !== null && value !== undefined);
}

function normalizeVector(vector) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  if (!Number.isFinite(magnitude) || magnitude === 0) {
    return vector;
  }

  return vector.map((value) => value / magnitude);
}

function deterministicEmbedding(text, dimensions = 32) {
  const vector = new Array(dimensions).fill(0);
  const normalized = String(text || '').toLowerCase();

  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    const bucket = index % dimensions;
    vector[bucket] += (code % 31) / 31;
  }

  return normalizeVector(vector);
}

async function getChromaModule() {
  return import('chromadb');
}

async function getChromaClient() {
  if (!chromaClientPromise) {
    chromaClientPromise = (async () => {
      const { ChromaClient } = await getChromaModule();
      const url = new URL(getChromaUrl());
      return new ChromaClient({
        host: url.hostname,
        port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
        ssl: url.protocol === 'https:'
      });
    })();
  }

  return chromaClientPromise;
}

async function getKnowledgeCollection() {
  if (!collectionPromise) {
    collectionPromise = (async () => {
      const client = await getChromaClient();
      return client.getOrCreateCollection({
        name: COLLECTION_NAME,
        embeddingFunction: null,
        metadata: {
          module: 'module_05',
          domain: 'knowledge'
        }
      });
    })();
  }

  return collectionPromise;
}

async function resetEmbeddingsCollection() {
  const client = await getChromaClient();

  try {
    await client.deleteCollection({ name: COLLECTION_NAME });
  } catch (_error) {
    // Collection may not exist yet.
  }

  collectionPromise = null;
  await getKnowledgeCollection();
}

async function generateEmbedding(text) {
  const cleanText = String(text || '').trim();

  if (cleanText === '') {
    throw new Error('text must be a non-empty string');
  }

  try {
    const embedding = await provider.embed(cleanText);

    if (Array.isArray(embedding) && embedding.every((value) => Number.isFinite(Number(value)))) {
      return embedding.map((value) => Number(value));
    }
  } catch (_error) {
    // Fall through to deterministic local embedding so semantic search still works
    // when the external provider is unavailable.
  }

  return deterministicEmbedding(cleanText);
}

async function storeEmbedding(knowledgeEntryId, text, metadata = {}) {
  const collection = await getKnowledgeCollection();
  const embedding = await generateEmbedding(text);
  const chromaId = knowledgeEntryId;
  const normalizedMetadata = {
    entity_ids: cleanArray(metadata.entity_ids || []).map(String),
    property_ids: cleanArray(metadata.property_ids || []).map(String),
    source: String(metadata.source || 'api'),
    classifications: cleanArray(metadata.classifications || []).map(String)
  };

  await collection.add({
    ids: [chromaId],
    documents: [text],
    embeddings: [embedding],
    metadatas: [normalizedMetadata]
  });

  return { chroma_id: chromaId };
}

async function deleteEmbedding(chromaId) {
  if (!chromaId) {
    return false;
  }

  const collection = await getKnowledgeCollection();
  await collection.delete({
    ids: [chromaId]
  });
  return true;
}

module.exports = {
  generateEmbedding,
  storeEmbedding,
  deleteEmbedding,
  getKnowledgeCollection,
  resetEmbeddingsCollection
};
