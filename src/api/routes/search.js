const express = require('express');
const { searchBrain } = require('../../app/brain');
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
    return res.json(
      await searchBrain({
        query: body.query,
        limit: body.limit,
        entityIds: body.entity_ids || [],
        entryTypes: body.entry_types || []
      })
    );
  } catch (error) {
    return next(error);
  }
});

router.get('/brain/search', searchLimiter, async (req, res, next) => {
  try {
    return res.json(
      await searchBrain({
        query: req.query.q || req.query.query,
        limit: req.query.limit
      })
    );
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
