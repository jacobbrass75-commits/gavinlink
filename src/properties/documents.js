const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db/connection');
const { getPropertyGroupForProperty } = require('./grouping');

const STORAGE_ROOT = path.resolve(process.cwd(), 'data', 'property-documents');

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function sanitizeFileName(fileName) {
  return path.basename(String(fileName || 'document'))
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

async function ensureProperty(propertyId) {
  const result = await query(
    `
      SELECT id, property_group_id
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
    metadata: row.metadata || {},
    created_at: row.created_at,
    updated_at: row.updated_at
  };
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
  metadata
}) {
  const property = await ensureProperty(propertyId);
  const group = await getPropertyGroupForProperty(propertyId);
  const sha256 = await computeSha256(filePath);
  const extension = path.extname(fileName || filePath) || '';
  const storedName = `${sha256}${extension.toLowerCase()}`;
  const targetDir = path.join(STORAGE_ROOT, group?.id || propertyId);
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

  return toApiDocument(insertResult.rows[0]);
}

module.exports = {
  attachPropertyDocument,
  listPropertyDocuments
};
