const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { previewForeclosureImport, importForeclosureFile } = require('../../import-export/foreclosure-import');
const { createRateLimiter, requireAdminApiKey } = require('../guardrails');

const router = express.Router();
const upload = multer({
  dest: path.join(os.tmpdir(), 'isg-second-brain-imports'),
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});
const importLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 5,
  message: 'Too many import requests. Please wait a minute and try again.'
});

function parseLimit(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }

  return String(value).trim().toLowerCase() === 'true';
}

async function cleanupUploadedFile(file) {
  if (!file?.path && !file?.storedPath) {
    return;
  }

  try {
    await fs.promises.unlink(file.storedPath || file.path);
  } catch (_error) {
    // Ignore cleanup issues.
  }
}

async function prepareUploadedFile(file) {
  if (!file?.path) {
    return null;
  }

  const extension = path.extname(file.originalname || '');

  if (!extension) {
    file.storedPath = file.path;
    return file.path;
  }

  const storedPath = `${file.path}${extension.toLowerCase()}`;
  await fs.promises.rename(file.path, storedPath);
  file.storedPath = storedPath;
  return storedPath;
}

router.post('/api/import/foreclosure/preview', requireAdminApiKey, importLimiter, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file?.path) {
      return res.status(400).json({ error: 'file upload is required' });
    }

    const uploadedPath = await prepareUploadedFile(req.file);
    const preview = await previewForeclosureImport(uploadedPath, {
      limit: parseLimit(req.body?.limit)
    });
    return res.status(200).json(preview);
  } catch (error) {
    return next(error);
  } finally {
    await cleanupUploadedFile(req.file);
  }
});

router.post('/api/import/foreclosure', requireAdminApiKey, importLimiter, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file?.path) {
      return res.status(400).json({ error: 'file upload is required' });
    }

    const uploadedPath = await prepareUploadedFile(req.file);
    const result = await importForeclosureFile(uploadedPath, {
      limit: parseLimit(req.body?.limit),
      dryRun: parseBoolean(req.body?.dryRun, false),
      skipSellers: parseBoolean(req.body?.skipSellers, false)
    });

    return res.status(201).json(result);
  } catch (error) {
    return next(error);
  } finally {
    await cleanupUploadedFile(req.file);
  }
});

router.post('/brain/import', (_req, res) => {
  res.status(501).json({
    status: 'not_implemented',
    module: 'Module 2',
    message: 'This endpoint will be implemented in Module 2: Entity Extraction'
  });
});

router.get('/brain/export', (_req, res) => {
  res.status(501).json({
    status: 'not_implemented',
    module: 'Module 2',
    message: 'This endpoint will be implemented in Module 2: Entity Extraction'
  });
});

module.exports = router;
