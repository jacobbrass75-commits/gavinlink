const express = require('express');
const {
  listKnowledgeEntries,
  getKnowledgeEntry,
  deleteKnowledgeEntry
} = require('../../knowledge/extract');

const router = express.Router();

function parseLimit(value, fallback = 50) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOffset(value, fallback = 0) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

router.get('/api/knowledge/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    const entry = await getKnowledgeEntry(req.params.id);

    if (!entry) {
      return res.status(404).json({ error: 'Knowledge entry not found' });
    }

    return res.json(entry);
  } catch (error) {
    return next(error);
  }
});

router.get('/api/knowledge', async (req, res, next) => {
  try {
    const result = await listKnowledgeEntries({
      source: req.query.source,
      entity_id: req.query.entity_id,
      property_id: req.query.property_id,
      classifications:
        typeof req.query.classifications === 'string' && req.query.classifications.trim() !== ''
          ? req.query.classifications.split(',').map((value) => value.trim())
          : [],
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset)
    });

    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

router.delete('/api/knowledge/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    const deleted = await deleteKnowledgeEntry(req.params.id);

    if (!deleted) {
      return res.status(404).json({ error: 'Knowledge entry not found' });
    }

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
