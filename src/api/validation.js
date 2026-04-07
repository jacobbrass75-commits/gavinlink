const { z } = require('zod');

function formatZodError(error) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message
  }));
}

function validateBody(schema) {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body || {});

    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid request body',
        details: formatZodError(parsed.error)
      });
    }

    req.validatedBody = parsed.data;
    return next();
  };
}

module.exports = {
  z,
  validateBody
};
