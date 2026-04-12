const buckets = new Map();

function cleanText(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

function isTruthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function isProduction() {
  return cleanText(process.env.NODE_ENV).toLowerCase() === 'production';
}

function allowsUnauthenticatedWrite() {
  return isTruthyEnv(process.env.ALLOW_UNAUTHENTICATED_WRITE);
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

  if (configuredKey) {
    const providedKey = req.get('x-api-key');

    if (providedKey !== configuredKey) {
      return res.status(401).json({ error: 'Valid x-api-key is required' });
    }

    return next();
  }

  if (!isProduction() || allowsUnauthenticatedWrite()) {
    return next();
  }

  return res.status(503).json({
    error: 'ADMIN_API_KEY must be configured for write routes in production'
  });
}

module.exports = {
  createRateLimiter,
  requireAdminApiKey,
  allowsUnauthenticatedWrite,
  isProduction
};
