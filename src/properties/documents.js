const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db/connection');
const { getPropertyGroupForProperty } = require('./grouping');
const { createKnowledgeEntry, getKnowledgeEntry } = require('../knowledge/extract');
const { storeEmbedding } = require('../knowledge/embeddings');
const {
  promoteKnowledgeEntry,
  buildPropertyPageRelativePath,
  slugify
} = require('../wiki/promote');
const { enqueueKnowledgeEntryPromotion } = require('../wiki/queue');

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  return String(value).trim().toLowerCase() === 'true';
}

function sanitizeFileName(fileName) {
  return path.basename(String(fileName || 'document'))
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function getStorageRoot() {
  return path.resolve(process.cwd(), process.env.ISG_PROPERTY_DOCUMENT_ROOT || 'data/property-documents');
}

function getRawStorageRoot() {
  return path.resolve(process.cwd(), process.env.ISG_RAW_ROOT || 'raw', 'property-documents');
}

async function ensureProperty(propertyId) {
  const result = await query(
    `
      SELECT
        id,
        apn,
        address,
        city,
        state,
        property_group_id,
        owner_entity_id,
        trustee_entity_id,
        lender_entity_id
      FROM properties
      WHERE id = $1
    `,
    [propertyId]
  );

  if (!result.rows[0]) {
    const error = new Error('Property not found');
    error.statusCode = 404;
    throw error;
  }

  return result.rows[0];
}

async function computeSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);

  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  return hash.digest('hex');
}

function toApiDocument(row) {
  return {
    id: row.id,
    property_id: row.property_id,
    property_group_id: row.property_group_id,
    file_name: row.file_name,
    mime_type: row.mime_type,
    file_size: Number(row.file_size || 0),
    document_type: row.document_type,
    source: row.source,
    notes: row.notes,
    knowledge_entry_id: row.knowledge_entry_id || null,
    wiki_page_path: row.wiki_page_path || null,
    promoted_at: row.promoted_at || null,
    metadata: row.metadata || {},
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function buildDocumentTitle(property, documentType) {
  const propertyLabel = cleanText(property.address, null) || cleanText(property.apn, null) || property.id;
  return `Property document: ${documentType} for ${propertyLabel}`;
}

function buildDocumentSummary(property, documentType) {
  const propertyLabel = cleanText(property.address, null) || cleanText(property.apn, null) || property.id;
  return `Document attached: ${documentType} for ${propertyLabel}`;
}

async function mirrorDocumentIntoRaw(storedPath, property, document) {
  const extension = path.extname(document.file_name || storedPath).toLowerCase();
  const targetDir = path.join(getRawStorageRoot(), property.property_group_id || property.id);
  const targetPath = path.join(
    targetDir,
    `${document.sha256}-${slugify(path.basename(document.file_name || 'document'), 'document')}${extension}`
  );

  await fs.promises.mkdir(targetDir, { recursive: true });

  try {
    await fs.promises.access(targetPath, fs.constants.F_OK);
  } catch (_error) {
    await fs.promises.copyFile(storedPath, targetPath);
  }

  return targetPath;
}

async function storeKnowledgeEmbedding(knowledgeEntryId, content, metadata) {
  try {
    const chroma = await storeEmbedding(knowledgeEntryId, content, metadata);
    await query(
      `
        UPDATE knowledge_entries
        SET chroma_id = $2,
            embedding_ref = $2,
            updated_at = NOW()
        WHERE id = $1
      `,
      [knowledgeEntryId, chroma.chroma_id]
    );
  } catch (_error) {
    // Best effort only.
  }
}

async function ensureDocumentKnowledgeEntry(documentRow, property, rawSourcePath) {
  if (documentRow.knowledge_entry_id) {
    return getKnowledgeEntry(documentRow.knowledge_entry_id);
  }

  const documentType = cleanText(documentRow.document_type, 'other');
  const title = buildDocumentTitle(property, documentType);
  const summary = buildDocumentSummary(property, documentType);
  const contentLines = [
    summary,
    `Property: ${cleanText(property.address, property.apn || property.id)}`,
    cleanText(property.city, null) ? `City: ${property.city}` : null,
    cleanText(property.apn, null) ? `APN: ${property.apn}` : null,
    `Document type: ${documentType}`,
    cleanText(documentRow.file_name, null) ? `File: ${documentRow.file_name}` : null,
    cleanText(documentRow.notes, null) ? `Notes: ${documentRow.notes}` : null
  ].filter(Boolean);

  const entityIds = [
    property.owner_entity_id,
    property.trustee_entity_id,
    property.lender_entity_id
  ].filter(Boolean);
  const content = contentLines.join('\n');
  const knowledgeEntry = await createKnowledgeEntry({
    entry_type: 'document',
    title,
    content,
    summary,
    source: 'property_document',
    source_file: rawSourcePath,
    property_id: property.id,
    entity_id: property.owner_entity_id || property.trustee_entity_id || property.lender_entity_id || null,
    metadata: {
      property_document_id: documentRow.id,
      document_type: documentType,
      sha256: documentRow.sha256
    },
    ai_summary: summary,
    ai_action_items: [],
    ai_tags: [documentType, 'property_document', cleanText(property.city, null)].filter(Boolean),
    ai_classifications: ['property_note'],
    entity_ids: entityIds,
    property_ids: [property.id]
  });

  await storeKnowledgeEmbedding(knowledgeEntry.id, content, {
    entity_ids: entityIds,
    property_ids: [property.id],
    source: 'property_document',
    classifications: ['property_note']
  });

  await query(
    `
      UPDATE property_documents
      SET knowledge_entry_id = $2,
          updated_at = NOW()
      WHERE id = $1
    `,
    [documentRow.id, knowledgeEntry.id]
  );

  return knowledgeEntry;
}

async function maybePromoteDocumentKnowledge(knowledgeEntry, property, options = {}) {
  const targetPage = buildPropertyPageRelativePath(property);
  const title = cleanText(property.address, null) || `Property ${property.apn || property.id}`;

  if (parseBoolean(options.autoPromote, true)) {
    return promoteKnowledgeEntry(knowledgeEntry, {
      page: targetPage,
      title
    });
  }

  if (parseBoolean(options.queuePromotion, true)) {
    await enqueueKnowledgeEntryPromotion({
      knowledge_entry_id: knowledgeEntry.id,
      target_page: targetPage,
      title_override: title,
      reason: 'property_document'
    });
  }

  return null;
}

async function listPropertyDocuments(propertyId) {
  await ensureProperty(propertyId);

  const result = await query(
    `
      SELECT *
      FROM property_documents
      WHERE property_id = $1
      ORDER BY created_at DESC
    `,
    [propertyId]
  );

  return result.rows.map(toApiDocument);
}

async function attachPropertyDocument({
  property_id: propertyId,
  file_path: filePath,
  file_name: fileName,
  mime_type: mimeType,
  document_type: documentType,
  source,
  notes,
  metadata,
  create_knowledge_entry: createKnowledgeEntryFlag = true,
  auto_promote: autoPromote = true,
  queue_promotion: queuePromotion = true
}) {
  const property = await ensureProperty(propertyId);
  const group = await getPropertyGroupForProperty(propertyId);
  const sha256 = await computeSha256(filePath);
  const extension = path.extname(fileName || filePath) || '';
  const storedName = `${sha256}${extension.toLowerCase()}`;
  const targetDir = path.join(getStorageRoot(), group?.id || propertyId);
  const targetPath = path.join(targetDir, storedName);

  await fs.promises.mkdir(targetDir, { recursive: true });

  try {
    await fs.promises.access(targetPath, fs.constants.F_OK);
  } catch (_error) {
    await fs.promises.copyFile(filePath, targetPath);
  }

  const stat = await fs.promises.stat(targetPath);
  const insertResult = await query(
    `
      INSERT INTO property_documents (
        id,
        property_id,
        property_group_id,
        file_name,
        storage_path,
        mime_type,
        file_size,
        sha256,
        document_type,
        source,
        notes,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
      ON CONFLICT (property_id, sha256)
      DO UPDATE SET
        property_group_id = COALESCE(EXCLUDED.property_group_id, property_documents.property_group_id),
        file_name = EXCLUDED.file_name,
        storage_path = EXCLUDED.storage_path,
        mime_type = EXCLUDED.mime_type,
        file_size = EXCLUDED.file_size,
        document_type = EXCLUDED.document_type,
        source = EXCLUDED.source,
        notes = COALESCE(EXCLUDED.notes, property_documents.notes),
        metadata = property_documents.metadata || EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *
    `,
    [
      uuidv4(),
      propertyId,
      group?.id || property.property_group_id || null,
      sanitizeFileName(fileName || path.basename(filePath)),
      targetPath,
      cleanText(mimeType, 'application/octet-stream'),
      stat.size,
      sha256,
      cleanText(documentType, 'other'),
      cleanText(source, 'manual'),
      cleanText(notes, null),
      JSON.stringify(metadata || {})
    ]
  );

  const storedDocument = insertResult.rows[0];

  if (parseBoolean(createKnowledgeEntryFlag, true)) {
    const rawSourcePath = await mirrorDocumentIntoRaw(targetPath, property, storedDocument);
    const knowledgeEntry = await ensureDocumentKnowledgeEntry(storedDocument, property, rawSourcePath);
    const promotion = await maybePromoteDocumentKnowledge(knowledgeEntry, property, {
      autoPromote,
      queuePromotion
    });

    await query(
      `
        UPDATE property_documents
        SET wiki_page_path = COALESCE($2, wiki_page_path),
            promoted_at = CASE WHEN $2::text IS NULL THEN promoted_at ELSE NOW() END,
            metadata = property_documents.metadata || $3::jsonb,
            updated_at = NOW()
        WHERE id = $1
      `,
      [
        storedDocument.id,
        promotion?.relative_page_path || null,
        JSON.stringify({
          raw_source_file: rawSourcePath
        })
      ]
    );
  }

  const refreshedResult = await query(
    `
      SELECT *
      FROM property_documents
      WHERE id = $1
    `,
    [storedDocument.id]
  );

  return toApiDocument(refreshedResult.rows[0]);
}

module.exports = {
  attachPropertyDocument,
  listPropertyDocuments
};
