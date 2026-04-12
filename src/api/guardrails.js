const crypto = require('crypto');

const buckets = new Map();

function cleanText(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createRateLimiter({ windowMs, max, message }) {
  return (req, res, next) => {
    const key = `${req.ip || 'unknown'}:${req.path}`;
    const now = Date.now();
    const existing = buckets.get(key);

    if (!existing || existing.expiresAt <= now) {
      buckets.set(key, {
        count: 1,
        expiresAt: now + windowMs
      });
      return next();
    }

    if (existing.count >= max) {
      return res.status(429).json({ error: message || 'Rate limit exceeded' });
    }

    existing.count += 1;
    return next();
  };
}

function requireAdminApiKey(req, res, next) {
  const configuredKey = cleanText(process.env.ADMIN_API_KEY);

  if (!configuredKey) {
    return res.status(503).json({
      error: 'ADMIN_API_KEY must be configured for protected routes'
    });
  }

  const providedKey = req.get('x-api-key');

  if (safeEqual(providedKey, configuredKey)) {
    return next();
  }

  return res.status(401).json({ error: 'Valid x-api-key is required' });
}

module.exports = {
  createRateLimiter,
  requireAdminApiKey,
  safeEqual
};
