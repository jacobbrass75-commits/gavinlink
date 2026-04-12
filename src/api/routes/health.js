const express = require('express');
const { getRuntimeStatus } = require('../../app/runtime');

const router = express.Router();

router.get('/health', async (_req, res) => {
  const payload = await getRuntimeStatus();
  res.status(payload.status === 'ok' ? 200 : 503).json(payload);
});

module.exports = router;
