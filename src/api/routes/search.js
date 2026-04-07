const express = require('express');
const { hybridSearch } = require('../../knowledge/search');
const { createRateLimiter } = require('../guardrails');
const { validateBody, z } = require('../validation');

const router = express.Router();
const searchLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 12,
  message: 'Too many search requests. Please wait a minute and try again.'
});
const searchSchema = z.object({
  query: z.string().trim().min(1, 'query is required'),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  entity_ids: z.array(z.string().trim().min(1)).optional(),
  entry_types: z.array(z.string().trim().min(1)).optional()
});

router.post('/api/search', searchLimiter, validateBody(searchSchema), async (req, res, next) => {
  try {
    const body = req.validatedBody;

    const results = await hybridSearch(body.query, {
      limit: body.limit,
      entity_ids: body.entity_ids || [],
      entry_types: body.entry_types || []
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
