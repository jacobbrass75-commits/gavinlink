const express = require('express');
const { hybridSearch } = require('../../knowledge/search');

const router = express.Router();

router.post('/api/search', async (req, res, next) => {
  try {
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';

    if (!query) {
      return res.status(400).json({ error: 'query is required' });
    }

    const results = await hybridSearch(query, {
      limit: req.body?.limit,
      entity_ids: Array.isArray(req.body?.entity_ids) ? req.body.entity_ids : [],
      entry_types: Array.isArray(req.body?.entry_types) ? req.body.entry_types : []
    });

    return res.json({
      results,
      total: results.length
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/brain/search', (_req, res) => {
  res.status(501).json({
    status: 'not_implemented',
    module: 'Module 2',
    message: 'This endpoint will be implemented in Module 2: Entity Extraction'
  });
});

module.exports = router;
