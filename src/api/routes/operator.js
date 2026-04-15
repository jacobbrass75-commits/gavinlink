const express = require('express');
const operatorApp = require('../../app/operator');

const router = express.Router();

function parseLimit(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildOptions(query = {}) {
  return {
    actionLimit: parseLimit(query.action_limit, 5),
    queueLimit: parseLimit(query.queue_limit, 5),
    matchLimit: parseLimit(query.match_limit, 5),
    sellerLimit: parseLimit(query.seller_limit, 5),
    limit: parseLimit(query.limit, 5)
  };
}

router.get('/api/operator', async (req, res, next) => {
  try {
    return res.json(await operatorApp.getOperatorOverview(buildOptions(req.query)));
  } catch (error) {
    return next(error);
  }
});

router.get('/api/operator/overview', async (req, res, next) => {
  try {
    return res.json(await operatorApp.getOperatorOverview(buildOptions(req.query)));
  } catch (error) {
    return next(error);
  }
});

router.get('/api/operator/backlog', async (req, res, next) => {
  try {
    return res.json(await operatorApp.getBacklogSnapshot(buildOptions(req.query)));
  } catch (error) {
    return next(error);
  }
});

router.get('/api/operator/alerts', async (req, res, next) => {
  try {
    return res.json(await operatorApp.getAlertSnapshot(buildOptions(req.query)));
  } catch (error) {
    return next(error);
  }
});

router.get('/api/operator/workflows', async (req, res, next) => {
  try {
    return res.json(await operatorApp.getWorkflowSnapshot());
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
