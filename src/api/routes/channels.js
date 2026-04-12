const express = require('express');
const { createChannelService } = require('../../app/channels');
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

function buildChannelMessage(normalized) {
  const lines = [];

  if (normalized.subject && normalized.subject !== normalized.message) {
    lines.push(`Subject: ${normalized.subject}`);
  }

  if (normalized.message) {
    lines.push(normalized.message);
  }

  if (normalized.actor?.name) {
    lines.push(`Actor: ${normalized.actor.name}`);
  }

  if (normalized.actor?.email) {
    lines.push(`Actor Email: ${normalized.actor.email}`);
  }

  if (normalized.occurred_at) {
    lines.push(`Occurred At: ${normalized.occurred_at}`);
  }

  if (Array.isArray(normalized.tags) && normalized.tags.length > 0) {
    lines.push(`Tags: ${normalized.tags.join(', ')}`);
  }

  return lines.filter(Boolean).join('\n');
}

function createIngestFn(defaultSource) {
  return async (_ingestable, normalized) => {
    const message = buildChannelMessage(normalized);

    if (!message) {
      throw brainApp.createAppError(400, 'No usable message content found in payload');
    }

    return brainApp.ingestMessage({
      message,
      source: normalized.source || defaultSource
    });
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
      const result = await getChannelService(process.env.VERMES_DEFAULT_SOURCE || 'vermes').ingestChannelPayload(
        'vermes',
        req.body,
        {
          provider: 'vermes',
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
