const express = require('express');

const router = express.Router();

router.get('/api/match/:identifier', (req, res) => {
  res.json({
    identifier: req.params.identifier,
    matches: [],
    message: 'Matching engine is not available yet.'
  });
});

router.get('/brain/match/:identifier', (_req, res) => {
  res.status(501).json({
    status: 'not_implemented',
    module: 'Module 2',
    message: 'This endpoint will be implemented in Module 2: Entity Extraction'
  });
});

module.exports = router;
