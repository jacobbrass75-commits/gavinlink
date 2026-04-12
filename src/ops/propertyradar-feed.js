const fs = require('fs');
const path = require('path');
const { importPropertyRadarAlerts } = require('../import-export/propertyradar-alerts');
const { sendTelegramMessage } = require('../integrations/telegram');

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  const normalized = String(value).trim().toLowerCase();

  if (['1', 'true', 'yes', 'on', 'y'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off', 'n'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function toNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }

  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFeedStateFilePath() {
  return path.resolve(
    process.cwd(),
    process.env.PROPERTYRADAR_FEED_STATE_FILE || 'data/propertyradar-feed-state.json'
  );
}

async function loadFeedState() {
  const filePath = getFeedStateFilePath();

  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      seen_message_ids: Array.isArray(parsed?.seen_message_ids)
        ? parsed.seen_message_ids.map((value) => cleanText(value, null)).filter(Boolean)
        : []
    };
  } catch (_error) {
    return {
      seen_message_ids: []
    };
  }
}

async function saveFeedState(state) {
  const filePath = getFeedStateFilePath();
  const normalized = {
    seen_message_ids: Array.isArray(state?.seen_message_ids)
      ? [...new Set(state.seen_message_ids.map((value) => cleanText(value, null)).filter(Boolean))].slice(-1000)
      : []
  };

  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(`${filePath}.tmp`, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await fs.promises.rename(`${filePath}.tmp`, filePath);
}

function formatErrorList(errors = [], limit = 2) {
  const preview = Array.isArray(errors) ? errors.slice(0, limit) : [];
  return preview
    .map((error) => {
      if (!error) {
        return null;
      }

      if (typeof error === 'string') {
        return error;
      }

      if (typeof error.error === 'string') {
        return error.error;
      }

      if (typeof error.message === 'string') {
        return error.message;
      }

      return null;
    })
    .filter(Boolean);
}

function getUrgencyRank(changeType) {
  switch (String(changeType || '').trim().toLowerCase()) {
    case 'reo':
      return 5;
    case 'auction_pending':
      return 4;
    case 'notice_of_sale':
      return 3;
    case 'notice_of_default':
      return 2;
    case 'pre_foreclosure':
      return 1;
    default:
      return 0;
  }
}

function humanizeToken(value, fallback = null) {
  const text = cleanText(value, null);

  if (!text) {
    return fallback;
  }

  return text
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function formatTimeline(value) {
  const text = cleanText(value, null);

  if (!text) {
    return null;
  }

  if (text === '30_days') {
    return '30-day';
  }

  if (text === '60_days') {
    return '60-day';
  }

  if (text === '90_days') {
    return '90-day';
  }

  return text === 'urgent' ? 'urgent' : humanizeToken(text, text);
}

function sortAlertsByPriority(left, right) {
  const leftMatched = Boolean(left?.matched_property_id || left?.matched_property_address || left?.property_apn);
  const rightMatched = Boolean(right?.matched_property_id || right?.matched_property_address || right?.property_apn);
  const rankDelta = getUrgencyRank(right?.normalized_change_type) - getUrgencyRank(left?.normalized_change_type);

  if (rankDelta !== 0) {
    return rankDelta;
  }

  const distressDelta = (Number(right?.distress_level) || 0) - (Number(left?.distress_level) || 0);

  if (distressDelta !== 0) {
    return distressDelta;
  }

  if (rightMatched !== leftMatched) {
    return Number(rightMatched) - Number(leftMatched);
  }

  return String(left?.matched_property_address || left?.street || '')
    .localeCompare(String(right?.matched_property_address || right?.street || ''));
}

function summarizeAlertMix(alerts = []) {
  const counts = new Map();

  for (const alert of alerts) {
    const label = humanizeToken(alert?.normalized_change_type, cleanText(alert?.what_changed, 'Other'));
    counts.set(label, (counts.get(label) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 4)
    .map(([label, count]) => `${label} ${count}`)
    .join(' | ');
}

function formatActionableAlert(alert) {
  const prefix = alert.status === 'preview' ? '[preview] ' : '';

  if (cleanText(alert?.broker_summary, null)) {
    return `- ${prefix}${alert.broker_summary}`;
  }

  const parts = [
    `${alert.what_changed || alert.normalized_change_type || 'Alert'}: ${alert.matched_property_address || alert.street || alert.radar_id || 'unknown property'}`,
    alert.city ? `${alert.city}${alert.state ? `, ${alert.state}` : ''}` : alert.state || null,
    formatTimeline(alert.timeline) ? `${formatTimeline(alert.timeline)} timeline` : null,
    alert.distress_level != null ? `distress ${alert.distress_level}` : null,
    alert.property_apn ? `APN ${alert.property_apn}` : null,
    alert.owner_name ? `owner ${alert.owner_name}` : null
  ].filter(Boolean);

  return `- ${prefix}${parts.join(' | ')}`;
}

function formatUnmatchedAlert(alert) {
  const prefix = alert.status === 'preview' ? '[preview] ' : '';

  if (cleanText(alert?.broker_summary, null)) {
    return `- ${prefix}${alert.broker_summary}`;
  }

  const parts = [
    `${alert.what_changed || alert.normalized_change_type || 'Alert'}: ${alert.street || alert.radar_id || 'unknown property'}`,
    alert.city ? `${alert.city}${alert.state ? `, ${alert.state}` : ''}` : alert.state || null,
    alert.zip ? `ZIP ${alert.zip}` : null
  ].filter(Boolean);

  return `- ${prefix}${parts.join(' | ')}`;
}

function buildPropertyRadarFeedSummary({
  result,
  runNumber = 1,
  dryRun = false,
  query = null,
  maxResults = null,
  intervalMs = null,
  loop = false
}) {
  const lines = [
    `PropertyRadar feed run #${runNumber} ${dryRun ? '(dry run)' : 'complete'}`,
    `Messages: ${Number(result?.messages_processed) || 0} processed | ${Number(result?.messages_skipped) || 0} skipped | Alerts: ${Number(result?.alerts_parsed) || 0}`,
    `Recorded: ${Number(result?.recorded) || 0} | Duplicates: ${Number(result?.duplicates) || 0} | Previews: ${Number(result?.previews) || 0}`,
    `Matched properties: ${Number(result?.matched_properties) || 0} | Refreshed: ${Number(result?.refreshed_with_realestatetool) || 0}`
  ];
  const outcomes = Array.isArray(result?.results) ? result.results : [];
  const brokerVisible = outcomes.filter((item) => item?.status === 'recorded' || item?.status === 'preview');
  const actionable = brokerVisible
    .filter((item) => item?.matched_property_id || item?.matched_property_address || item?.property_apn)
    .sort(sortAlertsByPriority)
    .slice(0, 5);
  const unmatched = brokerVisible
    .filter((item) => !item?.matched_property_id && !item?.matched_property_address && !item?.property_apn)
    .sort(sortAlertsByPriority)
    .slice(0, 3);
  const alertMix = summarizeAlertMix(brokerVisible);

  if (Number(result?.recorded) === 0 && Number(result?.duplicates) > 0) {
    lines.push('Status: no new alerts recorded; all parsed alerts were already in the brain.');
  } else if (Number(result?.messages_processed) === 0 && Number(result?.messages_skipped) > 0) {
    lines.push('Status: no new Gmail messages since the last successful feed checkpoint.');
  }

  if (query) {
    lines.push(`Query: ${query}`);
  }

  if (maxResults != null) {
    lines.push(`Max results: ${maxResults}`);
  }

  if (loop) {
    lines.push(`Loop interval: ${intervalMs || 0}ms`);
  }

  const errors = formatErrorList(result?.errors || [], 2);

  lines.push(`Errors: ${Array.isArray(result?.errors) ? result.errors.length : 0}`);

  if (alertMix) {
    lines.push(`Alert mix: ${alertMix}`);
  }

  if (actionable.length > 0) {
    lines.push('', 'Broker priorities:');
    for (const alert of actionable) {
      lines.push(formatActionableAlert(alert));
    }
  }

  if (unmatched.length > 0) {
    lines.push('', 'Needs matching:');
    for (const alert of unmatched) {
      lines.push(formatUnmatchedAlert(alert));
    }
  }

  if (actionable.length === 0 && unmatched.length === 0 && brokerVisible.length === 0) {
    lines.push('Broker priorities: none from this run.');
  }

  if (errors.length > 0) {
    lines.push(`Error preview: ${errors.join(' | ')}`);
  }

  return lines.join('\n');
}

async function publishTelegramSummary({
  result,
  runNumber = 1,
  dryRun = false,
  query = null,
  maxResults = null,
  intervalMs = null,
  loop = false
}) {
  const text = buildPropertyRadarFeedSummary({
    result,
    runNumber,
    dryRun,
    query,
    maxResults,
    intervalMs,
    loop
  });

  const telegramResult = await sendTelegramMessage({
    text
  });

  return {
    ok: true,
    message_id: telegramResult?.message_id || null,
    chat_id: telegramResult?.chat?.id || null
  };
}

async function runPropertyRadarFeed({
  query = process.env.GMAIL_PROPERTYRADAR_QUERY || '"Daily Digest Alert:"',
  maxResults = process.env.GMAIL_PROPERTYRADAR_MAX_RESULTS,
  dryRun = false,
  refreshWithRealEstateTool = true,
  messageId = null,
  loop = false,
  intervalMs = process.env.PROPERTYRADAR_FEED_INTERVAL_MS,
  iterations = process.env.PROPERTYRADAR_FEED_ITERATIONS,
  sendTelegramSummary = false
} = {}) {
  const resolvedQuery = cleanText(query, process.env.GMAIL_PROPERTYRADAR_QUERY || '"Daily Digest Alert:"');
  const resolvedMaxResults = Math.max(1, toNumber(maxResults, 25) || 25);
  const resolvedIntervalMs = Math.max(0, toNumber(intervalMs, 0) || 0);
  const resolvedIterations = toNumber(iterations, null);
  const shouldLoop = toBoolean(loop, false);
  const shouldSendTelegramSummary = toBoolean(sendTelegramSummary, false);
  const feedState = messageId ? { seen_message_ids: [] } : await loadFeedState();
  const runs = [];
  const errors = [];
  let runNumber = 0;
  let keepRunning = true;

  while (keepRunning) {
    runNumber += 1;
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    let result;
    let telegramSummary = null;

    try {
      result = await importPropertyRadarAlerts({
        query: resolvedQuery,
        maxResults: resolvedMaxResults,
        dryRun,
        refreshWithRealEstateTool,
        messageId,
        skipMessageIds: messageId ? [] : feedState.seen_message_ids
      });
    } catch (error) {
      result = {
        query,
        query: resolvedQuery,
        dry_run: dryRun,
        messages_processed: 0,
        messages_skipped: 0,
        processed_message_ids: [],
        alerts_parsed: 0,
        recorded: 0,
        duplicates: 0,
        previews: 0,
        matched_properties: 0,
        refreshed_with_realestatetool: 0,
        errors: [{ message: error.message }],
        results: []
      };
    }

    if (!messageId && Array.isArray(result?.processed_message_ids) && result.processed_message_ids.length > 0) {
      feedState.seen_message_ids = [...feedState.seen_message_ids, ...result.processed_message_ids];
      await saveFeedState(feedState);
    }

    if (shouldSendTelegramSummary) {
      try {
        telegramSummary = await publishTelegramSummary({
          result,
          runNumber,
          dryRun,
          query: resolvedQuery,
          maxResults: resolvedMaxResults,
          intervalMs: resolvedIntervalMs,
          loop: shouldLoop
        });
      } catch (error) {
        telegramSummary = {
          ok: false,
          error: error.message
        };
      }
    }

    const finishedMs = Date.now();
    const finishedAt = new Date().toISOString();

    const run = {
      run: runNumber,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: finishedMs - startedMs,
      result,
      telegram_summary: telegramSummary
    };

    runs.push(run);

    if (Array.isArray(result?.errors) && result.errors.length > 0) {
      errors.push(
        ...result.errors.map((error) => ({
          run: runNumber,
          source: 'propertyradar',
          ...(typeof error === 'string' ? { message: error } : error)
        }))
      );
    }

    if (telegramSummary && telegramSummary.ok === false) {
      errors.push({
        run: runNumber,
        source: 'telegram',
        message: telegramSummary.error || 'Telegram summary failed'
      });
    }

    if (!shouldLoop) {
      keepRunning = false;
      continue;
    }

    if (resolvedIterations !== null && Number.isFinite(resolvedIterations) && runNumber >= resolvedIterations) {
      keepRunning = false;
      continue;
    }

    if (resolvedIntervalMs > 0) {
      await sleep(resolvedIntervalMs);
    }
  }

  return {
    mode: shouldLoop ? 'loop' : 'once',
    loop: shouldLoop,
    interval_ms: resolvedIntervalMs,
    iterations: resolvedIterations,
    query: resolvedQuery,
    max_results: resolvedMaxResults,
    dry_run: dryRun,
    send_telegram_summary: shouldSendTelegramSummary,
    runs,
    errors
  };
}

module.exports = {
  buildPropertyRadarFeedSummary,
  publishTelegramSummary,
  runPropertyRadarFeed
};
