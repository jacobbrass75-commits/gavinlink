const express = require('express');
const {
  runFullMatching,
  runMatchingForBuyer,
  runMatchingForProperty,
  getMatchDistribution
} = require('../../matching/runner');
const { matchIdentifier, toNumber } = require('../../app/brain');
const { createRateLimiter, requireAdminApiKey } = require('../guardrails');
const { validateBody, z } = require('../validation');

const router = express.Router();
const matchingLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 6,
  message: 'Too many matching requests. Please wait a minute and try again.'
});

function parseLimit(value, fallback = 10) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }

  return String(value).trim().toLowerCase() === 'true';
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

const matchingRunSchema = z.object({
  minScore: z.coerce.number().min(0).max(100).optional(),
  dryRun: z.coerce.boolean().optional(),
  generateNarratives: z.coerce.boolean().optional()
}).partial();

router.post('/api/match/run', requireAdminApiKey, matchingLimiter, validateBody(matchingRunSchema), async (req, res, next) => {
  try {
    const body = req.validatedBody || {};
    const result = await runFullMatching({
      minScore: body.minScore ?? req.query.minScore,
      dryRun: parseBoolean(body.dryRun ?? req.query.dryRun, false),
      generateNarratives: parseBoolean(
        body.generateNarratives ?? req.query.generateNarratives,
        false
      )
    });
    return res.status(201).json(result);
  } catch (error) {
    return next(error);
  }
});

router.post('/api/match/run-for-buyer/:buyerId', requireAdminApiKey, matchingLimiter, validateBody(matchingRunSchema), async (req, res, next) => {
  try {
    if (!isUuid(req.params.buyerId)) {
      return res.status(400).json({ error: 'buyerId must be a valid UUID' });
    }

    const body = req.validatedBody || {};
    const matches = await runMatchingForBuyer(req.params.buyerId, {
      minScore: body.minScore ?? req.query.minScore,
      dryRun: parseBoolean(body.dryRun ?? req.query.dryRun, false),
      generateNarratives: parseBoolean(
        body.generateNarratives ?? req.query.generateNarratives,
        false
      )
    });
    return res.status(201).json({ matches, total: matches.length });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/match/run-for-property/:propertyId', requireAdminApiKey, matchingLimiter, validateBody(matchingRunSchema), async (req, res, next) => {
  try {
    if (!isUuid(req.params.propertyId)) {
      return res.status(400).json({ error: 'propertyId must be a valid UUID' });
    }

    const body = req.validatedBody || {};
    const matches = await runMatchingForProperty(req.params.propertyId, {
      minScore: body.minScore ?? req.query.minScore,
      dryRun: parseBoolean(body.dryRun ?? req.query.dryRun, false),
      generateNarratives: parseBoolean(
        body.generateNarratives ?? req.query.generateNarratives,
        false
      )
    });
    return res.status(201).json({ matches, total: matches.length });
  } catch (error) {
    return next(error);
  }
});

router.get('/api/match/distribution', async (_req, res, next) => {
  try {
    return res.json(await getMatchDistribution());
  } catch (error) {
    return next(error);
  }
});

router.get('/api/match/:identifier', matchingLimiter, async (req, res, next) => {
  try {
    return res.json(
      await matchIdentifier({
        identifier: req.params.identifier,
        limit: parseLimit(req.query.limit, 10),
        minScore: toNumber(req.query.minScore),
        dryRun: parseBoolean(req.query.dryRun, false),
        generateNarratives: parseBoolean(req.query.generateNarratives, false)
      })
    );
  } catch (error) {
    return next(error);
  }
});

router.get('/brain/match/:identifier', matchingLimiter, async (req, res, next) => {
  try {
    return res.json(
      await matchIdentifier({
        identifier: req.params.identifier,
        limit: parseLimit(req.query.limit, 10),
        minScore: toNumber(req.query.minScore),
        dryRun: parseBoolean(req.query.dryRun, false),
        generateNarratives: parseBoolean(req.query.generateNarratives, false)
      })
    );
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
