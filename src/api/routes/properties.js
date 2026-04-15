const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const multer = require('multer');
const propertiesApp = require('../../app/properties');
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

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  return String(value).trim().toLowerCase() === 'true';
}

router.get('/api/properties/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    return res.json(await propertiesApp.getPropertyDetail(req.params.id));
  } catch (error) {
    return next(error);
  }
});

router.get('/api/properties/:id/group', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    return res.json(await propertiesApp.getPropertyGroupForProperty(req.params.id));
  } catch (error) {
    return next(error);
  }
});

router.get('/api/property-groups/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    return res.json(await propertiesApp.getPropertyGroup(req.params.id));
  } catch (error) {
    return next(error);
  }
});

router.get('/api/properties/:id/documents', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    const documents = await propertiesApp.listPropertyDocuments(req.params.id);
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

    const document = await propertiesApp.attachPropertyDocument({
      property_id: req.params.id,
      file_path: req.file.path,
      file_name: req.file.originalname,
      mime_type: req.file.mimetype,
      document_type: typeof req.body?.document_type === 'string' ? req.body.document_type : 'other',
      source: typeof req.body?.source === 'string' ? req.body.source : 'manual',
      notes: typeof req.body?.notes === 'string' ? req.body.notes : null,
      create_knowledge_entry: parseBoolean(req.body?.create_knowledge_entry, true),
      auto_promote: parseBoolean(req.body?.auto_promote, true),
      queue_promotion: parseBoolean(req.body?.queue_promotion, true),
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
