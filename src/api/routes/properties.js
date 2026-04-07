const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { query } = require('../../db/connection');
const { getPropertyGroupForProperty, getPropertyGroup } = require('../../properties/grouping');
const { attachPropertyDocument, listPropertyDocuments } = require('../../properties/documents');
const { createRateLimiter, requireAdminApiKey } = require('../guardrails');

const router = express.Router();
const upload = multer({
  dest: path.join(os.tmpdir(), 'isg-second-brain-property-documents'),
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});
const propertyDocumentLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many property document uploads. Please wait a minute and try again.'
});

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

router.get('/api/properties/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    const result = await query(
      `
        SELECT
          p.*,
          owner.name AS owner_entity_name,
          trustee.name AS trustee_entity_name,
          lender.name AS lender_entity_name
        FROM properties p
        LEFT JOIN entities owner ON owner.id = p.owner_entity_id
        LEFT JOIN entities trustee ON trustee.id = p.trustee_entity_id
        LEFT JOIN entities lender ON lender.id = p.lender_entity_id
        WHERE p.id = $1
      `,
      [req.params.id]
    );
    const property = result.rows[0];

    if (!property) {
      return res.status(404).json({ error: 'Property not found' });
    }

    const documents = await listPropertyDocuments(req.params.id);

    return res.json({
      ...property,
      assessed_value: property.assessed_value == null ? null : Number(property.assessed_value),
      sq_feet: property.sq_feet == null ? null : Number(property.sq_feet),
      lot_size: property.lot_size == null ? null : Number(property.lot_size),
      owner_entity_name: property.owner_entity_name || null,
      trustee_entity_name: property.trustee_entity_name || null,
      lender_entity_name: property.lender_entity_name || null,
      documents
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/api/properties/:id/group', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    const group = await getPropertyGroupForProperty(req.params.id);

    if (!group) {
      return res.status(404).json({ error: 'Property group not found' });
    }

    return res.json(group);
  } catch (error) {
    return next(error);
  }
});

router.get('/api/property-groups/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    const group = await getPropertyGroup(req.params.id);

    if (!group) {
      return res.status(404).json({ error: 'Property group not found' });
    }

    return res.json(group);
  } catch (error) {
    return next(error);
  }
});

router.get('/api/properties/:id/documents', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    const documents = await listPropertyDocuments(req.params.id);
    return res.json({ results: documents, total: documents.length });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/properties/:id/documents', requireAdminApiKey, propertyDocumentLimiter, upload.single('document'), async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    if (!req.file?.path) {
      return res.status(400).json({ error: 'document upload is required' });
    }

    const document = await attachPropertyDocument({
      property_id: req.params.id,
      file_path: req.file.path,
      file_name: req.file.originalname,
      mime_type: req.file.mimetype,
      document_type: typeof req.body?.document_type === 'string' ? req.body.document_type : 'other',
      source: typeof req.body?.source === 'string' ? req.body.source : 'manual',
      notes: typeof req.body?.notes === 'string' ? req.body.notes : null,
      metadata: {
        uploaded_via: 'api',
        original_name: req.file.originalname
      }
    });

    return res.status(201).json(document);
  } catch (error) {
    return next(error);
  } finally {
    if (req.file?.path) {
      try {
        await fs.promises.unlink(req.file.path);
      } catch (_error) {
        // Best effort cleanup.
      }
    }
  }
});

module.exports = router;
