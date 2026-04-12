const express = require('express');
const { getDailyBrief } = require('../../app/brain');

const router = express.Router();

router.get('/api/daily', async (_req, res, next) => {
  try {
    return res.json(await getDailyBrief());
  } catch (error) {
    return next(error);
  }
});

router.get('/brain/daily', async (_req, res, next) => {
  try {
    return res.json(await getDailyBrief());
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
