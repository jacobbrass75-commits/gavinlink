const express = require('express');
const matchingApp = require('../../app/matching');
const { createRateLimiter, requireAdminApiKey } = require('../guardrails');
const { z } = require('../validation');

const router = express.Router();
const narrativeLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 4,
  message: 'Too many narrative requests. Please wait a minute and try again.'
});

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

const updateStatusSchema = z.object({
  status: z.string().trim().min(1, 'status is required')
});

router.get('/api/matches/top', async (req, res, next) => {
  try {
    const results = await matchingApp.getTopMatches({
      limit: parseLimit(req.query.limit, 10),
      status: req.query.status
    });
    return res.json({ results, total: results.length });
  } catch (error) {
    return next(error);
  }
});

router.get('/api/matches/buyer/:buyerId', async (req, res, next) => {
  try {
    if (!isUuid(req.params.buyerId)) {
      return res.status(400).json({ error: 'buyerId must be a valid UUID' });
    }

    const result = await matchingApp.listMatches({
      buyer_profile_id: req.params.buyerId,
      status: req.query.status,
      min_score: req.query.min_score,
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset)
    });
    return res.json({ results: result.results, total: result.total });
  } catch (error) {
    return next(error);
  }
});

router.get('/api/matches/property/:propertyId', async (req, res, next) => {
  try {
    if (!isUuid(req.params.propertyId)) {
      return res.status(400).json({ error: 'propertyId must be a valid UUID' });
    }

    const result = await matchingApp.listMatches({
      property_id: req.params.propertyId,
      status: req.query.status,
      min_score: req.query.min_score,
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset)
    });
    return res.json({ results: result.results, total: result.total });
  } catch (error) {
    return next(error);
  }
});

router.get('/api/matches/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    const match = await matchingApp.getMatchById(req.params.id);

    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }

    return res.json(match);
  } catch (error) {
    return next(error);
  }
});

router.put('/api/matches/:id/status', requireAdminApiKey, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    if (req.body?.status === undefined) {
      return res.status(400).json({ error: 'status is required' });
    }

    const parsed = updateStatusSchema.safeParse(req.body || {});

    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid request body',
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message
        }))
      });
    }

    const match = await matchingApp.updateMatchStatus(req.params.id, parsed.data.status);
    return res.json(match);
  } catch (error) {
    return next(error);
  }
});

router.post('/api/matches/:id/narrative', requireAdminApiKey, narrativeLimiter, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    const match = await matchingApp.generateNarrativeForMatch(req.params.id);
    return res.status(201).json(match);
  } catch (error) {
    return next(error);
  }
});

router.get('/api/matches', async (req, res, next) => {
  try {
    const result = await matchingApp.listMatches({
      buyer_profile_id: req.query.buyer_profile_id,
      property_id: req.query.property_id,
      status: req.query.status,
      min_score: req.query.min_score,
      sort_by: req.query.sort_by,
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset)
    });

    return res.json({
      results: result.results,
      total: result.total,
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset)
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
