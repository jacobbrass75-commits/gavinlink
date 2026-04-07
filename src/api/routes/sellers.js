const express = require('express');
const {
  getSellerProfile,
  getSellerProfileByProperty,
  updateSellerProfile,
  listSellerProfiles,
  searchSellerProfiles,
  autoGenerateSellerProfiles,
  getSellerDistribution
} = require('../../sellers/profiles');
const {
  batchScoreProperties
} = require('../../sellers/distress-score');
const {
  batchInferMotivation
} = require('../../sellers/motivation');
const {
  findPortfolioDistress,
  findLenderOwnerPatterns
} = require('../../sellers/portfolio-distress');
const { createRateLimiter, requireAdminApiKey } = require('../guardrails');
const { validateBody, z } = require('../validation');

const router = express.Router();
const sellerLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 6,
  message: 'Too many seller batch requests. Please wait a minute and try again.'
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

function parseBoolean(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }

  return String(value).trim().toLowerCase() === 'true';
}

const sellerUpdateSchema = z.object({
  motivation: z.string().trim().min(1).optional(),
  distress_level: z.coerce.number().min(1).max(5).optional(),
  timeline: z.string().trim().min(1).optional(),
  foreclosure_stage: z.string().trim().min(1).optional(),
  outstanding_debt: z.coerce.number().nonnegative().optional(),
  estimated_equity: z.coerce.number().optional(),
  asking_price: z.coerce.number().nonnegative().optional(),
  minimum_acceptable: z.coerce.number().nonnegative().optional(),
  lender_status: z.string().trim().min(1).optional(),
  legal_issues: z.string().trim().min(1).optional(),
  sensibilities: z.string().trim().min(1).optional(),
  notes: z.string().trim().min(1).optional(),
  active: z.coerce.boolean().optional()
}).partial();

router.get('/api/sellers/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();

    if (!q) {
      return res.status(400).json({ error: 'q is required' });
    }

    const results = await searchSellerProfiles(q);
    return res.json({ results, total: results.length });
  } catch (error) {
    return next(error);
  }
});

router.get('/api/sellers/by-property/:propertyId', async (req, res, next) => {
  try {
    if (!isUuid(req.params.propertyId)) {
      return res.status(400).json({ error: 'propertyId must be a valid UUID' });
    }

    const profile = await getSellerProfileByProperty(req.params.propertyId);

    if (!profile) {
      return res.status(404).json({ error: 'Seller profile not found' });
    }

    return res.json(profile);
  } catch (error) {
    return next(error);
  }
});

router.get('/api/sellers/distressed', async (_req, res, next) => {
  try {
    const results = await findPortfolioDistress();
    return res.json({ results, total: results.length });
  } catch (error) {
    return next(error);
  }
});

router.get('/api/sellers/lender-patterns', async (_req, res, next) => {
  try {
    const results = await findLenderOwnerPatterns();
    return res.json({ results, total: results.length });
  } catch (error) {
    return next(error);
  }
});

router.get('/api/sellers/distribution', async (_req, res, next) => {
  try {
    const distribution = await getSellerDistribution();
    return res.json(distribution);
  } catch (error) {
    return next(error);
  }
});

router.post('/api/sellers/auto-generate', requireAdminApiKey, sellerLimiter, async (_req, res, next) => {
  try {
    const result = await autoGenerateSellerProfiles();
    return res.status(201).json(result);
  } catch (error) {
    return next(error);
  }
});

router.post('/api/sellers/score', requireAdminApiKey, sellerLimiter, async (req, res, next) => {
  try {
    const result = await batchScoreProperties({
      limit: parseLimit(req.query.limit, 0),
      rescore: parseBoolean(req.query.rescore, false)
    });
    return res.status(201).json(result);
  } catch (error) {
    return next(error);
  }
});

router.post('/api/sellers/infer', requireAdminApiKey, sellerLimiter, async (req, res, next) => {
  try {
    const result = await batchInferMotivation({
      limit: parseLimit(req.query.limit, 5)
    });
    return res.status(201).json(result);
  } catch (error) {
    return next(error);
  }
});

router.get('/api/sellers/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    const profile = await getSellerProfile(req.params.id);

    if (!profile) {
      return res.status(404).json({ error: 'Seller profile not found' });
    }

    return res.json(profile);
  } catch (error) {
    return next(error);
  }
});

router.get('/api/sellers', async (req, res, next) => {
  try {
    const result = await listSellerProfiles({
      min_distress: req.query.min_distress,
      max_distress: req.query.max_distress,
      motivation: req.query.motivation,
      foreclosure_stage: req.query.foreclosure_stage,
      city: req.query.city,
      property_type: req.query.property_type,
      sort_by: req.query.sort_by,
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset)
    });

    return res.json({
      profiles: result.profiles,
      total: result.total,
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset)
    });
  } catch (error) {
    return next(error);
  }
});

router.put('/api/sellers/:id', validateBody(sellerUpdateSchema), async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    const profile = await updateSellerProfile(req.params.id, req.validatedBody || {});
    return res.json(profile);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
