const express = require('express');
const {
  listMatches,
  getMatch,
  getTopMatches,
  updateMatchStatus,
  generateNarrativeForMatch
} = require('../../matching/runner');

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

router.get('/api/matches/top', async (req, res, next) => {
  try {
    const results = await getTopMatches({
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

    const result = await listMatches({
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

    const result = await listMatches({
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

    const match = await getMatch(req.params.id);

    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }

    return res.json(match);
  } catch (error) {
    return next(error);
  }
});

router.put('/api/matches/:id/status', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    const match = await updateMatchStatus(req.params.id, req.body?.status);
    return res.json(match);
  } catch (error) {
    return next(error);
  }
});

router.post('/api/matches/:id/narrative', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    const match = await generateNarrativeForMatch(req.params.id);
    return res.status(201).json(match);
  } catch (error) {
    return next(error);
  }
});

router.get('/api/matches', async (req, res, next) => {
  try {
    const result = await listMatches({
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
