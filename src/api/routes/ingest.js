const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const { classifyMessage } = require('../../ingestion/classifier');
const { routeClassifiedMessage } = require('../../ingestion/router');
const { processAudioFile } = require('../../knowledge/transcribe');

const router = express.Router();
const upload = multer({
  dest: path.join(os.tmpdir(), 'isg-second-brain-audio'),
  limits: {
    fileSize: 25 * 1024 * 1024
  }
});

router.post('/api/ingest', async (req, res, next) => {
  try {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';

    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    const classified = await classifyMessage(message);
    const result = await routeClassifiedMessage(classified, message, {
      source: typeof req.body?.source === 'string' ? req.body.source : 'api'
    });

    return res.json({
      ok: true,
      ...result
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/ingest/audio', upload.single('audio'), async (req, res, next) => {
  const cleanupTargets = [req.file?.path].filter(Boolean);

  try {
    const filePath = req.file?.path;

    if (!filePath) {
      return res.status(400).json({ error: 'audio file upload is required' });
    }

    const result = await processAudioFile(filePath, {
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

router.post('/brain/ingest', (_req, res) => {
  res.status(501).json({
    status: 'not_implemented',
    module: 'Module 2',
    message: 'This endpoint will be implemented in Module 2: Entity Extraction'
  });
});

module.exports = router;
