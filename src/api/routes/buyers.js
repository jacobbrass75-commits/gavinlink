const express = require('express');
const {
  createBuyerProfile,
  getBuyerProfile,
  updateBuyerProfile,
  listBuyerProfiles,
  searchBuyerProfiles,
  deactivateBuyerProfile
} = require('../../buyers/profiles');
const {
  recordPurchase,
  getPurchaseHistory,
  getBuyerStats
} = require('../../buyers/activity');
const {
  getLenderReport,
  getLenderDetail,
  getLenderOwnerOverlaps
} = require('../../buyers/lender-report');
const { validateBody, z } = require('../validation');

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

const buyerCreateSchema = z.object({
  entity_name: z.string().trim().min(1, 'entity_name is required'),
  target_property_types: z.array(z.string().trim().min(1)).optional(),
  target_cities: z.array(z.string().trim().min(1)).optional(),
  target_zip_codes: z.array(z.string().trim().min(1)).optional(),
  min_price: z.coerce.number().nonnegative().optional(),
  max_price: z.coerce.number().nonnegative().optional(),
  min_sq_feet: z.coerce.number().nonnegative().optional(),
  max_sq_feet: z.coerce.number().nonnegative().optional(),
  min_units: z.coerce.number().nonnegative().optional(),
  max_units: z.coerce.number().nonnegative().optional(),
  min_cap_rate: z.coerce.number().optional(),
  investment_strategy: z.string().trim().min(1).optional(),
  financing_preference: z.string().trim().min(1).optional(),
  typical_close_timeline: z.string().trim().min(1).optional(),
  urgency: z.string().trim().min(1).optional(),
  sensibilities: z.string().trim().min(1).optional(),
  notes: z.string().trim().min(1).optional()
});

const buyerUpdateSchema = buyerCreateSchema
  .omit({ entity_name: true })
  .extend({
    active: z.coerce.boolean().optional()
  })
  .partial();

router.get('/api/buyers/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();

    if (!q) {
      return res.status(400).json({ error: 'q is required' });
    }

    const results = await searchBuyerProfiles(q);
    return res.json({ results, total: results.length });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/buyers/:id/purchases', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    const purchase = await recordPurchase({
      ...req.body,
      buyer_profile_id: req.params.id
    });
    return res.status(201).json(purchase);
  } catch (error) {
    return next(error);
  }
});

router.get('/api/buyers/:id/purchases', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    const purchases = await getPurchaseHistory(req.params.id);
    return res.json({ results: purchases, total: purchases.length });
  } catch (error) {
    return next(error);
  }
});

router.get('/api/buyers/:id/stats', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    const stats = await getBuyerStats(req.params.id);
    return res.json(stats);
  } catch (error) {
    return next(error);
  }
});

router.get('/api/buyers/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    const profile = await getBuyerProfile(req.params.id);

    if (!profile) {
      return res.status(404).json({ error: 'Buyer profile not found' });
    }

    return res.json(profile);
  } catch (error) {
    return next(error);
  }
});

router.post('/api/buyers', validateBody(buyerCreateSchema), async (req, res, next) => {
  try {
    const profile = await createBuyerProfile(req.validatedBody || {});
    return res.status(201).json(profile);
  } catch (error) {
    return next(error);
  }
});

router.get('/api/buyers', async (req, res, next) => {
  try {
    const result = await listBuyerProfiles({
      property_type: req.query.property_type,
      city: req.query.city,
      strategy: req.query.strategy,
      urgency: req.query.urgency,
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

router.put('/api/buyers/:id', validateBody(buyerUpdateSchema), async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    const profile = await updateBuyerProfile(req.params.id, req.validatedBody || {});
    return res.json(profile);
  } catch (error) {
    return next(error);
  }
});

router.delete('/api/buyers/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    const profile = await deactivateBuyerProfile(req.params.id);
    return res.json(profile);
  } catch (error) {
    return next(error);
  }
});

router.get('/api/lenders/overlaps', async (_req, res, next) => {
  try {
    const results = await getLenderOwnerOverlaps();
    return res.json({ results, total: results.length });
  } catch (error) {
    return next(error);
  }
});

router.get('/api/lenders/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'id must be a valid UUID' });
    }

    const detail = await getLenderDetail(req.params.id);

    if (!detail) {
      return res.status(404).json({ error: 'Lender not found' });
    }

    return res.json(detail);
  } catch (error) {
    return next(error);
  }
});

router.get('/api/lenders', async (_req, res, next) => {
  try {
    const results = await getLenderReport();
    return res.json({ results, total: results.length });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
