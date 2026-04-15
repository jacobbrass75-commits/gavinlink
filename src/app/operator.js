const fs = require('fs');
const path = require('path');
const { query } = require('../db/connection');
const brainApp = require('./brain');
const runtimeApp = require('./runtime');
const matchingApp = require('./matching');

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function humanizeToken(value, fallback = null) {
  const text = cleanText(value, fallback);

  if (!text) {
    return fallback;
  }

  return text
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function getPropertyRadarFeedStateFilePath() {
  return path.resolve(
    process.cwd(),
    process.env.PROPERTYRADAR_FEED_STATE_FILE || 'data/propertyradar-feed-state.json'
  );
}

async function getPropertyRadarFeedState() {
  try {
    const raw = await fs.promises.readFile(getPropertyRadarFeedStateFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    const seenMessageIds = Array.isArray(parsed?.seen_message_ids)
      ? parsed.seen_message_ids.filter((value) => typeof value === 'string' && value.trim() !== '')
      : [];

    return {
      state_file: getPropertyRadarFeedStateFilePath(),
      seen_message_count: seenMessageIds.length
    };
  } catch (_error) {
    return {
      state_file: getPropertyRadarFeedStateFilePath(),
      seen_message_count: 0
    };
  }
}

async function getBacklogSnapshot(options = {}) {
  const actionLimit = parsePositiveInteger(options.actionLimit, 5);
  const queueLimit = parsePositiveInteger(options.queueLimit, 5);
  const matchLimit = parsePositiveInteger(options.matchLimit, 5);
  const sellerLimit = parsePositiveInteger(options.sellerLimit, 5);
  const daily = await brainApp.getDailyBrief();
  const topMatches = await matchingApp.getTopMatches({
    limit: matchLimit,
    status: 'suggested'
  });
  const queueResult = await query(
    `
      SELECT
        q.id,
        q.knowledge_entry_id,
        q.target_page,
        q.title_override,
        q.priority,
        q.reason,
        q.status,
        q.created_at,
        ke.title AS knowledge_title
      FROM wiki_promotion_queue q
      JOIN knowledge_entries ke ON ke.id = q.knowledge_entry_id
      WHERE q.status IN ('pending', 'processing', 'failed')
      ORDER BY
        CASE q.status
          WHEN 'failed' THEN 0
          WHEN 'processing' THEN 1
          ELSE 2
        END,
        q.priority DESC,
        q.created_at ASC
      LIMIT $1
    `,
    [queueLimit]
  );

  return {
    action_items: Array.isArray(daily.action_items) ? daily.action_items.slice(0, actionLimit) : [],
    distressed_sellers: Array.isArray(daily.distressed_sellers)
      ? daily.distressed_sellers.slice(0, sellerLimit)
      : [],
    pending_promotions: queueResult.rows,
    top_matches: Array.isArray(topMatches) ? topMatches.slice(0, matchLimit) : []
  };
}

async function getAlertSnapshot(options = {}) {
  const limit = parsePositiveInteger(options.limit, 5);
  const recentCountsResult = await query(
    `
      SELECT
        COALESCE(normalized_change_type, 'other') AS change_type,
        COUNT(*)::int AS count
      FROM property_alert_events
      WHERE COALESCE(occurred_at, created_at) >= NOW() - INTERVAL '7 days'
      GROUP BY 1
      ORDER BY count DESC, change_type ASC
      LIMIT 10
    `
  );
  const totalsResult = await query(
    `
      SELECT
        COUNT(*)::int AS total,
        COUNT(property_id)::int AS matched,
        (COUNT(*) - COUNT(property_id))::int AS unmatched
      FROM property_alert_events
      WHERE COALESCE(occurred_at, created_at) >= NOW() - INTERVAL '7 days'
    `
  );
  const recentAlertsResult = await query(
    `
      SELECT
        pae.id,
        pae.change_summary,
        pae.normalized_change_type,
        COALESCE(pae.occurred_at, pae.created_at) AS occurred_at,
        COALESCE(p.address, pae.street) AS property_address,
        COALESCE(p.city, pae.city) AS city,
        p.id AS matched_property_id,
        sp.distress_level
      FROM property_alert_events pae
      LEFT JOIN properties p ON p.id = pae.property_id
      LEFT JOIN seller_profiles sp ON sp.id = pae.seller_profile_id
      ORDER BY
        CASE COALESCE(pae.normalized_change_type, '')
          WHEN 'reo' THEN 0
          WHEN 'auction_pending' THEN 1
          WHEN 'notice_of_sale' THEN 2
          WHEN 'notice_of_default' THEN 3
          ELSE 4
        END,
        COALESCE(pae.occurred_at, pae.created_at) DESC
      LIMIT $1
    `,
    [limit]
  );

  return {
    last_7_days: totalsResult.rows[0] || {
      total: 0,
      matched: 0,
      unmatched: 0
    },
    by_change_type: recentCountsResult.rows.map((row) => ({
      change_type: row.change_type,
      label: humanizeToken(row.change_type, row.change_type),
      count: row.count
    })),
    recent_alerts: recentAlertsResult.rows
  };
}

async function getWorkflowSnapshot() {
  const [wikiQueueCountsResult, matchStatusCountsResult, propertyRadarFeed] = await Promise.all([
    query(
      `
        SELECT status, COUNT(*)::int AS count
        FROM wiki_promotion_queue
        GROUP BY status
        ORDER BY status ASC
      `
    ),
    query(
      `
        SELECT status, COUNT(*)::int AS count
        FROM matches
        GROUP BY status
        ORDER BY status ASC
      `
    ),
    getPropertyRadarFeedState()
  ]);

  return {
    wiki_queue: wikiQueueCountsResult.rows,
    match_pipeline: matchStatusCountsResult.rows,
    propertyradar_feed: propertyRadarFeed
  };
}

async function getOperatorOverview(options = {}) {
  const [runtime, backlog, alerts, workflows] = await Promise.all([
    runtimeApp.getRuntimeStatus(),
    getBacklogSnapshot(options),
    getAlertSnapshot(options),
    getWorkflowSnapshot()
  ]);

  return {
    runtime,
    backlog,
    alerts,
    workflows
  };
}

module.exports = {
  getBacklogSnapshot,
  getAlertSnapshot,
  getWorkflowSnapshot,
  getOperatorOverview
};
