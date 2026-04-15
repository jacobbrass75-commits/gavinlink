const express = require('express');
const entitiesApp = require('../../app/entities');

const router = express.Router();

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

router.get('/api/entities/lookup', async (req, res, next) => {
  try {
    return res.json(await entitiesApp.lookupEntity({ name: req.query.name }));
  } catch (error) {
    return next(error);
  }
});

router.get('/api/entities/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();

    if (q === '') {
      return res.status(400).json({
        error: 'q is required'
      });
    }

    const limit = Math.min(entitiesApp.parsePositiveInteger(req.query.limit, 25) || 25, 100);
    const offset = entitiesApp.parsePositiveInteger(req.query.offset, 0);
    return res.json(await entitiesApp.searchEntities({ query: q, limit, offset }));
  } catch (error) {
    return next(error);
  }
});

router.get('/api/entities/distressed', async (_req, res, next) => {
  try {
    const results = await entitiesApp.getDistressedEntities();
    res.json({
      results,
      total: results.length
    });
  } catch (error) {
    next(error);
  }
});

router.get('/api/entities/:id/portfolio', async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isUuid(id)) {
      return res.status(400).json({
        error: 'id must be a valid UUID'
      });
    }

    const portfolio = await entitiesApp.getEntityPortfolio(id);

    if (!portfolio) {
      return res.status(404).json({
        error: 'Entity not found'
      });
    }

    return res.json(portfolio);
  } catch (error) {
    return next(error);
  }
});

router.get('/api/entities/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isUuid(id)) {
      return res.status(400).json({
        error: 'id must be a valid UUID'
      });
    }

    const entityDetail = await entitiesApp.getEntityDetailById(id);

    if (!entityDetail) {
      return res.status(404).json({
        error: 'Entity not found'
      });
    }

    return res.json(entityDetail);
  } catch (error) {
    return next(error);
  }
});

router.get('/api/entities', async (req, res, next) => {
  try {
    const limit = Math.min(entitiesApp.parsePositiveInteger(req.query.limit, 25) || 25, 100);
    const offset = entitiesApp.parsePositiveInteger(req.query.offset, 0);
    const entityType = typeof req.query.type === 'string' && req.query.type.trim() !== ''
      ? req.query.type.trim().toLowerCase()
      : null;
    return res.json(await entitiesApp.listEntities({ type: entityType, limit, offset }));
  } catch (error) {
    return next(error);
  }
});

router.get('/brain/entity/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isUuid(id)) {
      return res.status(400).json({
        error: 'id must be a valid UUID'
      });
    }

    const entityDetail = await entitiesApp.getEntityDetailById(id);

    if (!entityDetail) {
      return res.status(404).json({
        error: 'Entity not found'
      });
    }

    return res.json(entityDetail);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
