const provider = require('../inference/provider');
const { query } = require('../db/connection');
const { getPortfolio } = require('../entities/cluster');

const DEFAULT_RESULT = {
  motivation: 'unknown',
  distress_level: 1,
  likely_timeline: 'flexible',
  lender_status: 'unknown',
  reasoning: 'Inference was unavailable, so this seller needs manual review.',
  approach_suggestions: []
};

const SYSTEM_PROMPT = `You are a commercial real estate analyst. Given property data, infer the most likely
seller motivation and situation. Respond with ONLY a JSON object, no other text.

Response format:
{
  "motivation": "foreclosure|estate|retirement|partnership_dissolution|relocation|financial_distress|portfolio_rebalance|1031_exchange|market_timing|unknown",
  "distress_level": 1-5,
  "likely_timeline": "urgent|30_days|60_days|90_days|flexible",
  "lender_status": "cooperating|non_responsive|pursuing_foreclosure|open_to_short_sale|unknown",
  "reasoning": "2-3 sentence explanation of your analysis",
  "approach_suggestions": ["suggestion 1", "suggestion 2"]
}`;

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function clampDistress(value, fallback = 1) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.min(5, Math.round(parsed)));
}

function parseProviderJson(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    throw new Error('Inference provider did not return a JSON object');
  }

  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');

  if (start === -1 || end === -1 || end < start) {
    throw new Error('Inference provider returned malformed JSON');
  }

  return JSON.parse(value.slice(start, end + 1));
}

function normalizeInferenceResult(result, fallbackReasoning = DEFAULT_RESULT.reasoning) {
  const suggestions = Array.isArray(result?.approach_suggestions)
    ? result.approach_suggestions
        .map((value) => cleanText(value, null))
        .filter(Boolean)
    : [];

  return {
    motivation: cleanText(result?.motivation, DEFAULT_RESULT.motivation),
    distress_level: clampDistress(result?.distress_level, DEFAULT_RESULT.distress_level),
    likely_timeline: cleanText(result?.likely_timeline, DEFAULT_RESULT.likely_timeline),
    lender_status: cleanText(result?.lender_status, DEFAULT_RESULT.lender_status),
    reasoning: cleanText(result?.reasoning, fallbackReasoning),
    approach_suggestions: suggestions
  };
}

async function inferMotivation(property, ownerContext = {}) {
  try {
    const payload = {
      owner_name: property.owner_name || ownerContext?.entity?.name || null,
      owner_entity_type: ownerContext?.entity?.type || ownerContext?.entity_type || null,
      property_address: property.address || null,
      property_city: property.city || null,
      assessed_value: property.assessed_value ?? null,
      loan_amount: property.loan_amount ?? null,
      ltv: property.ltv ?? null,
      default_amount: property.default_amount ?? null,
      default_date: property.default_date || null,
      foreclosure: property.foreclosure ?? null,
      use_code: property.use_code || null,
      sq_feet: property.sq_feet ?? null,
      trustee_name: property.trustee_name || null,
      ai_summary: property.ai_summary || null,
      portfolio: ownerContext?.properties || ownerContext?.portfolio || null
    };
    const response = await provider.complete(
      `${SYSTEM_PROMPT}\n\nProperty context:\n${JSON.stringify(payload, null, 2)}`
    );

    return normalizeInferenceResult(parseProviderJson(response));
  } catch (error) {
    return normalizeInferenceResult(null, `Inference failed: ${error.message}`);
  }
}

async function batchInferMotivation({ limit = 5 } = {}) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 5, 1), 50);
  const candidatesResult = await query(
    `
      SELECT
        sp.id AS seller_profile_id,
        sp.entity_id,
        p.*,
        e.name AS entity_name,
        e.entity_type
      FROM seller_profiles sp
      JOIN properties p ON p.id = sp.property_id
      LEFT JOIN entities e ON e.id = sp.entity_id
      WHERE sp.active = TRUE
        AND (sp.inferred_at IS NULL OR COALESCE(sp.motivation, 'unknown') = 'unknown')
      ORDER BY sp.distress_level DESC NULLS LAST, p.assessed_value DESC NULLS LAST, p.address ASC
      LIMIT $1
    `,
    [normalizedLimit]
  );

  let processed = 0;
  let failed = 0;

  for (const row of candidatesResult.rows) {
    try {
      const portfolio = row.entity_id ? await getPortfolio(row.entity_id) : null;
      const inference = await inferMotivation(row, portfolio || {});

      await query(
        `
          UPDATE seller_profiles
          SET
            motivation = $2,
            timeline = $3,
            lender_status = $4,
            ai_reasoning = $5,
            approach_suggestions = $6::text[],
            inferred_at = NOW(),
            updated_at = NOW(),
            metadata = metadata || jsonb_build_object('ai_distress_level', $7::int)
          WHERE id = $1
        `,
        [
          row.seller_profile_id,
          inference.motivation,
          inference.likely_timeline,
          inference.lender_status,
          inference.reasoning,
          inference.approach_suggestions,
          inference.distress_level
        ]
      );

      processed += 1;
    } catch (_error) {
      failed += 1;
    }
  }

  const remainingResult = await query(
    `
      SELECT COUNT(*)::int AS count
      FROM seller_profiles
      WHERE active = TRUE
        AND (inferred_at IS NULL OR COALESCE(motivation, 'unknown') = 'unknown')
    `
  );

  return {
    processed,
    failed,
    remaining: remainingResult.rows[0].count
  };
}

module.exports = {
  inferMotivation,
  batchInferMotivation
};
