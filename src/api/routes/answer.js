const express = require('express');
const assistantApp = require('../../app/assistant');
const { createRateLimiter, requireAdminApiKey } = require('../guardrails');
const { validateBody, z } = require('../validation');

const router = express.Router();
const answerLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  message: 'Too many assistant requests. Please wait a minute and try again.'
});

const answerSchema = z.object({
  message: z.string().trim().min(1, 'message is required'),
  source: z.string().trim().min(1).optional(),
  surface: z.enum(['assistant', 'telegram']).optional(),
  limit: z.coerce.number().int().min(1).max(10).optional(),
  allowSave: z.coerce.boolean().optional()
});

async function handleAnswer(req, res, next, fallbackSource) {
  try {
    const body = req.validatedBody;
    const result = await assistantApp.answerMessage({
      message: body.message,
      source: body.source || fallbackSource,
      surface: body.surface || 'assistant',
      limit: body.limit,
      allowSave: body.allowSave
    });

    return res.json({
      ok: true,
      ...result
    });
  } catch (error) {
    return next(error);
  }
}

router.post(
  '/api/answer',
  requireAdminApiKey,
  answerLimiter,
  validateBody(answerSchema),
  async (req, res, next) => handleAnswer(req, res, next, 'api_answer')
);

router.post(
  '/brain/answer',
  requireAdminApiKey,
  answerLimiter,
  validateBody(answerSchema),
  async (req, res, next) => handleAnswer(req, res, next, 'brain_api')
);

module.exports = router;
