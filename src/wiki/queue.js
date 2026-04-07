const { v4: uuidv4 } = require('uuid');
const { query } = require('../db/connection');
const { getKnowledgeEntry } = require('../knowledge/extract');
const { promoteKnowledgeEntry, buildDefaultPageRelativePath } = require('./promote');

const HIGH_SIGNAL_PRIORITY = {
  seller_intel: 95,
  deal_update: 90,
  buyer_intel: 85,
  property_note: 75,
  relationship: 70,
  market_insight: 65,
  action_item: 60
};

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function getEntryClassifications(entry = {}) {
  return Array.isArray(entry.ai_classifications) ? entry.ai_classifications.filter(Boolean) : [];
}

function shouldAutoPromoteEntry(entry = {}) {
  const classifications = getEntryClassifications(entry);

  if (classifications.length === 0) {
    return false;
  }

  const hasHighSignal = classifications.some((classification) => HIGH_SIGNAL_PRIORITY[classification]);
  const hasContext =
    (Array.isArray(entry.linked_entities) && entry.linked_entities.length > 0) ||
    (Array.isArray(entry.linked_properties) && entry.linked_properties.length > 0) ||
    cleanText(entry.ai_summary, '') !== '';

  return hasHighSignal && hasContext;
}

function getPromotionPriority(entry = {}) {
  const priorities = getEntryClassifications(entry)
    .map((classification) => HIGH_SIGNAL_PRIORITY[classification] || 0)
    .filter((priority) => priority > 0);

  if (priorities.length === 0) {
    return 0;
  }

  return Math.max(...priorities);
}

async function enqueueKnowledgeEntryPromotion({
  knowledge_entry_id: knowledgeEntryId,
  target_page: targetPage,
  title_override: titleOverride,
  reason,
  priority
}) {
  const knowledgeEntry = await getKnowledgeEntry(knowledgeEntryId);

  if (!knowledgeEntry) {
    throw new Error('Knowledge entry not found for promotion queue');
  }

  if (!shouldAutoPromoteEntry(knowledgeEntry) && priority == null) {
    return null;
  }

  const resolvedPriority = priority ?? getPromotionPriority(knowledgeEntry);
  const resolvedTargetPage = cleanText(targetPage, buildDefaultPageRelativePath(knowledgeEntry));

  const result = await query(
    `
      INSERT INTO wiki_promotion_queue (
        id,
        knowledge_entry_id,
        target_page,
        title_override,
        priority,
        reason
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (knowledge_entry_id)
      DO UPDATE SET
        target_page = COALESCE(EXCLUDED.target_page, wiki_promotion_queue.target_page),
        title_override = COALESCE(EXCLUDED.title_override, wiki_promotion_queue.title_override),
        priority = GREATEST(wiki_promotion_queue.priority, EXCLUDED.priority),
        reason = COALESCE(EXCLUDED.reason, wiki_promotion_queue.reason),
        status = CASE
          WHEN wiki_promotion_queue.status = 'completed' THEN wiki_promotion_queue.status
          ELSE 'pending'
        END,
        updated_at = NOW()
      RETURNING *
    `,
    [
      uuidv4(),
      knowledgeEntryId,
      resolvedTargetPage,
      cleanText(titleOverride, null),
      resolvedPriority,
      cleanText(reason, 'auto_promote')
    ]
  );

  return result.rows[0];
}

async function listPromotionQueue({ status = null, statuses = null, limit = 50 } = {}) {
  const result = await query(
    `
      SELECT *
      FROM wiki_promotion_queue
      WHERE (
        $1::text IS NULL
        OR status = $1
      )
        AND (
          $2::text[] IS NULL
          OR status = ANY($2::text[])
        )
      ORDER BY
        CASE status
          WHEN 'pending' THEN 0
          WHEN 'failed' THEN 1
          WHEN 'processing' THEN 2
          ELSE 3
        END,
        priority DESC,
        created_at ASC
      LIMIT $3
    `,
    [
      cleanText(status, null),
      Array.isArray(statuses) && statuses.length > 0 ? statuses : null,
      Math.max(1, Math.min(Number(limit) || 50, 200))
    ]
  );

  return result.rows;
}

async function processAutoPromoteQueue(options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || 10, 100));
  const dryRun = Boolean(options.dryRun);
  const queueItems = await listPromotionQueue({
    statuses: ['pending', 'failed'],
    limit
  });
  const processed = [];
  let completed = 0;
  let failed = 0;
  let skipped = 0;

  for (const item of queueItems) {
    const knowledgeEntry = await getKnowledgeEntry(item.knowledge_entry_id);

    if (!knowledgeEntry) {
      failed += 1;
      processed.push({
        knowledge_entry_id: item.knowledge_entry_id,
        status: 'failed',
        error: 'Knowledge entry not found'
      });

      if (!dryRun) {
        await query(
          `
            UPDATE wiki_promotion_queue
            SET status = 'failed',
                attempts = attempts + 1,
                last_error = 'Knowledge entry not found',
                updated_at = NOW()
            WHERE id = $1
          `,
          [item.id]
        );
      }

      continue;
    }

    const targetPage = cleanText(item.target_page, buildDefaultPageRelativePath(knowledgeEntry, options));
    const titleOverride = cleanText(item.title_override, null);

    if (dryRun) {
      processed.push({
        knowledge_entry_id: knowledgeEntry.id,
        status: 'pending',
        target_page: targetPage,
        title_override: titleOverride
      });
      continue;
    }

    try {
      await query(
        `
          UPDATE wiki_promotion_queue
          SET status = 'processing',
              updated_at = NOW()
          WHERE id = $1
        `,
        [item.id]
      );

      const promotion = await promoteKnowledgeEntry(knowledgeEntry, {
        ...options,
        page: targetPage,
        title: titleOverride || undefined
      });

      await query(
        `
          UPDATE wiki_promotion_queue
          SET status = 'completed',
              attempts = attempts + 1,
              last_error = NULL,
              processed_at = NOW(),
              updated_at = NOW(),
              result = $2::jsonb
          WHERE id = $1
        `,
        [item.id, JSON.stringify(promotion)]
      );

      completed += 1;
      processed.push({
        knowledge_entry_id: knowledgeEntry.id,
        status: 'completed',
        page_path: promotion.relative_page_path
      });
    } catch (error) {
      failed += 1;
      processed.push({
        knowledge_entry_id: knowledgeEntry.id,
        status: 'failed',
        error: error.message
      });

      await query(
        `
          UPDATE wiki_promotion_queue
          SET status = 'failed',
              attempts = attempts + 1,
              last_error = $2,
              updated_at = NOW()
          WHERE id = $1
        `,
        [item.id, error.message]
      );
    }
  }

  if (!dryRun) {
    const pendingCountResult = await query(
      `
        SELECT COUNT(*)::int AS count
        FROM wiki_promotion_queue
        WHERE status IN ('pending', 'failed')
      `
    );
    skipped = Math.max(0, pendingCountResult.rows[0].count);
  }

  return {
    scanned: queueItems.length,
    completed,
    failed,
    skipped,
    processed
  };
}

module.exports = {
  HIGH_SIGNAL_PRIORITY,
  shouldAutoPromoteEntry,
  getPromotionPriority,
  enqueueKnowledgeEntryPromotion,
  listPromotionQueue,
  processAutoPromoteQueue
};
