const express = require('express');
const {
  createChannelService,
  buildChannelIngestMessage,
  looksLikeAssistantRequest
} = require('../../app/channels');
const assistantApp = require('../../app/assistant');
const brainApp = require('../../app/brain');
const { requireAdminApiKey } = require('../guardrails');

const router = express.Router();

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function matchesSecret(req, candidates = []) {
  const provided = cleanText(
    req.get('x-webhook-secret') ||
      req.get('x-omi-secret') ||
      req.get('x-hermes-secret') ||
      req.get('x-vermes-secret'),
    null
  );

  if (!provided) {
    return false;
  }

  return candidates.some((candidate) => cleanText(candidate, null) === provided);
}

function requireChannelAccess(secretEnvNames = []) {
  return (req, res, next) => {
    const configuredSecrets = secretEnvNames
      .map((name) => cleanText(process.env[name], null))
      .filter(Boolean);

    if (configuredSecrets.length > 0) {
      if (matchesSecret(req, configuredSecrets)) {
        return next();
      }

      return res.status(401).json({ error: 'Valid webhook secret is required' });
    }

    return requireAdminApiKey(req, res, next);
  };
}

function createIngestFn(defaultSource) {
  return async (_ingestable, normalized) => {
    if (looksLikeAssistantRequest(normalized)) {
      return {
        mode: 'assistant',
        ...(await assistantApp.answerMessage({
          message: normalized.message,
          source: normalized.source || defaultSource,
          surface: 'assistant',
          allowSave: false,
          limit: 5
        }))
      };
    }

    const message = buildChannelIngestMessage(normalized);

    if (!message) {
      throw brainApp.createAppError(400, 'No usable message content found in payload');
    }

    return {
      mode: 'ingest',
      ...(await brainApp.ingestChannelEvent({
        message,
        source: normalized.source || defaultSource,
        metadata: normalized.metadata,
        channel: normalized.channel,
        raw: normalized.raw
      }))
    };
  };
}

function getChannelService(defaultSource) {
  return createChannelService({
    ingestFn: createIngestFn(defaultSource)
  });
}

function buildChannelResponse(result) {
  return {
    ok: true,
    channel: result.channel,
    provider: result.provider,
    source: result.source,
    event_type: result.event_type,
    message: result.message,
    subject: result.subject,
    summary: result.summary,
    message_id: result.message_id,
    conversation_id: result.conversation_id,
    occurred_at: result.occurred_at,
    tags: result.tags,
    actor: result.actor,
    metadata: result.metadata,
    processor_mode: result.ingest_result?.mode || 'ingest',
    ingest_result: result.ingest_result
  };
}

router.post('/api/channels/omi', requireChannelAccess(['OMI_WEBHOOK_SECRET']), async (req, res, next) => {
  try {
    const result = await getChannelService(process.env.OMI_DEFAULT_SOURCE || 'omi').ingestOmiPayload(
      req.body,
      {
        source: process.env.OMI_DEFAULT_SOURCE || 'omi'
      }
    );
    return res.json(buildChannelResponse(result));
  } catch (error) {
    return next(error);
  }
});

router.post(
  '/api/channels/hermes',
  requireChannelAccess(['HERMES_WEBHOOK_SECRET']),
  async (req, res, next) => {
    try {
      const result = await getChannelService(process.env.HERMES_DEFAULT_SOURCE || 'hermes').ingestHermesPayload(
        req.body,
        {
          source: process.env.HERMES_DEFAULT_SOURCE || 'hermes'
        }
      );
      return res.json(buildChannelResponse(result));
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  '/api/channels/vermes',
  requireChannelAccess(['VERMES_WEBHOOK_SECRET', 'HERMES_WEBHOOK_SECRET']),
  async (req, res, next) => {
    try {
      const result = await getChannelService(process.env.VERMES_DEFAULT_SOURCE || 'vermes').ingestVermesPayload(
        req.body,
        {
          source: process.env.VERMES_DEFAULT_SOURCE || 'vermes'
        }
      );
      return res.json(buildChannelResponse(result));
    } catch (error) {
      return next(error);
    }
  }
);

module.exports = router;
