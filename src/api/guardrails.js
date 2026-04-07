const buckets = new Map();

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
  const configuredKey = process.env.ADMIN_API_KEY;

  if (!configuredKey) {
    return next();
  }

  const providedKey = req.get('x-api-key');

  if (providedKey !== configuredKey) {
    return res.status(401).json({ error: 'Valid x-api-key is required' });
  }

  return next();
}

module.exports = {
  createRateLimiter,
  requireAdminApiKey
};
