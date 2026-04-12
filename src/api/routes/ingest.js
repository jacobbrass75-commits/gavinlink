const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const { ingestMessage, ingestAudio } = require('../../app/brain');
const { requireAdminApiKey } = require('../guardrails');
const { validateBody, z } = require('../validation');

const router = express.Router();
const upload = multer({
  dest: path.join(os.tmpdir(), 'isg-second-brain-audio'),
  limits: {
    fileSize: 25 * 1024 * 1024
  }
});
const ingestSchema = z.object({
  message: z.string().trim().min(1, 'message is required'),
  source: z.string().trim().min(1).optional()
});

router.post('/api/ingest', requireAdminApiKey, validateBody(ingestSchema), async (req, res, next) => {
  try {
    const { message, source } = req.validatedBody;
    const result = await ingestMessage({ message, source: source || 'api' });

    return res.json({
      ok: true,
      ...result
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/ingest/audio', requireAdminApiKey, upload.single('audio'), async (req, res, next) => {
  const cleanupTargets = [req.file?.path].filter(Boolean);

  try {
    const filePath = req.file?.path;

    if (!filePath) {
      return res.status(400).json({ error: 'audio file upload is required' });
    }

    const result = await ingestAudio({
      filePath,
      source: typeof req.body?.source === 'string' ? req.body.source : 'voice_memo'
    });

    return res.json({
      ok: true,
      ...result
    });
  } catch (error) {
    return next(error);
  } finally {
    await Promise.all(
      cleanupTargets.map(async (targetPath) => {
        try {
          await fs.promises.unlink(targetPath);
        } catch (_error) {
          // Ignore cleanup issues.
        }
      })
    );
  }
});

router.post('/brain/ingest', requireAdminApiKey, validateBody(ingestSchema), async (req, res, next) => {
  try {
    const result = await ingestMessage({
      message: req.validatedBody.message,
      source: req.validatedBody.source || 'brain_api'
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
