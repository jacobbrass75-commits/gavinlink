const { query } = require('../db/connection');
const provider = require('../inference/provider');

const NARRATIVE_SYSTEM_PROMPT = `You are an experienced commercial real estate broker. 
You're going to be given a buyer profile, a seller profile, and a property. Generate 
a match narrative that helps another broker understand:

1. Why this buyer and seller could work together (2 sentences max)
2. Suggested approach for the broker (3-4 specific tactics)
3. Potential deal structures that could work (1-2 ideas)  
4. Red flags or watch-outs (if any)

Be concrete and tactical. Reference specific facts from the data. No fluff.

Respond with ONLY a JSON object:
{
  "match_summary": "2 sentence overview of why this works",
  "approach_strategy": ["tactic 1", "tactic 2", "tactic 3"],
  "deal_structures": ["structure idea 1", "structure idea 2"],
  "red_flags": ["concern 1", "concern 2"] or [],
  "confidence": "high|medium|low"
}`;

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function cleanStringArray(values = [], fallback = []) {
  if (!Array.isArray(values)) {
    return fallback;
  }

  const cleaned = values
    .map((value) => cleanText(value, null))
    .filter(Boolean);

  return cleaned.length > 0 ? cleaned : fallback;
}

function defaultNarrative(match, errorMessage = null) {
  const summary = errorMessage
    ? `Narrative generation fell back to a default response because the provider failed: ${errorMessage}`
    : 'This pairing shows potential, but it still needs broker review before outreach.';

  return {
    match_summary: summary,
    approach_strategy: ['Review the pricing gap and seller distress before outreach.'],
    deal_structures: ['Standard purchase with pricing tied to actual lien and payoff review.'],
    red_flags: errorMessage ? [errorMessage] : [],
    confidence: match?.score >= 85 ? 'high' : match?.score >= 70 ? 'medium' : 'low'
  };
}

function parseNarrativeResponse(response, match) {
  const payload = typeof response === 'string' ? JSON.parse(response) : response;

  return {
    match_summary: cleanText(payload?.match_summary, defaultNarrative(match).match_summary),
    approach_strategy: cleanStringArray(payload?.approach_strategy, defaultNarrative(match).approach_strategy),
    deal_structures: cleanStringArray(payload?.deal_structures, defaultNarrative(match).deal_structures),
    red_flags: cleanStringArray(payload?.red_flags, []),
    confidence: ['high', 'medium', 'low'].includes(payload?.confidence) ? payload.confidence : defaultNarrative(match).confidence
  };
}

async function generateMatchNarrative(match, buyer, seller, property) {
  if (Number(match?.score || 0) < 75) {
    throw new Error('Narratives are only generated for matches scoring 75 or higher');
  }

  try {
    const prompt = `${NARRATIVE_SYSTEM_PROMPT}

Match:
${JSON.stringify(
  {
    match: {
      id: match?.id || null,
      score: match?.score ?? null,
      breakdown: match?.breakdown || null,
      reasons: match?.reasons || null
    },
    buyer,
    seller,
    property
  },
  null,
  2
)}`;
    const response = await provider.complete(prompt);
    return parseNarrativeResponse(response, match);
  } catch (error) {
    return defaultNarrative(match, error.message);
  }
}

async function batchGenerateNarratives(options = {}) {
  const minScore = Math.max(Number(options.minScore) || 75, 0);
  const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 100);
  const rowsResult = await query(
    `
      SELECT
        m.id,
        m.score,
        m.score_breakdown,
        bp.id AS buyer_profile_id,
        bp.entity_id AS buyer_entity_id,
        buyer_entity.name AS buyer_entity_name,
        bp.preferred_property_types,
        bp.target_cities,
        bp.target_zip_codes,
        bp.max_price,
        bp.min_price,
        bp.min_sq_feet,
        bp.max_sq_feet,
        bp.investment_strategy,
        bp.urgency,
        bp.sensibilities,
        sp.id AS seller_profile_id,
        sp.entity_id AS seller_entity_id,
        seller_entity.name AS seller_entity_name,
        sp.distress_level,
        sp.motivation,
        sp.timeline,
        sp.foreclosure_stage,
        sp.lender_status,
        p.id AS property_id,
        p.apn,
        p.address,
        p.city,
        p.state,
        p.zip,
        p.property_type,
        p.sq_feet,
        p.lot_size,
        p.assessed_value,
        p.foreclosure
      FROM matches m
      JOIN buyer_profiles bp ON bp.id = m.buyer_profile_id
      JOIN entities buyer_entity ON buyer_entity.id = bp.entity_id
      JOIN seller_profiles sp ON sp.id = m.seller_profile_id
      LEFT JOIN entities seller_entity ON seller_entity.id = sp.entity_id
      JOIN properties p ON p.id = m.property_id
      WHERE m.score >= $1
        AND m.narrative IS NULL
      ORDER BY m.score DESC, m.updated_at DESC
      LIMIT $2
    `,
    [minScore, limit]
  );
  let generated = 0;
  let failed = 0;

  for (const row of rowsResult.rows) {
    try {
      const narrative = await generateMatchNarrative(
        {
          id: row.id,
          score: Number(row.score),
          breakdown: row.score_breakdown || {}
        },
        {
          id: row.buyer_profile_id,
          entity_id: row.buyer_entity_id,
          entity_name: row.buyer_entity_name,
          target_property_types: row.preferred_property_types || [],
          target_cities: row.target_cities || [],
          target_zip_codes: row.target_zip_codes || [],
          min_price: row.min_price == null ? null : Number(row.min_price),
          max_price: row.max_price == null ? null : Number(row.max_price),
          min_sq_feet: row.min_sq_feet == null ? null : Number(row.min_sq_feet),
          max_sq_feet: row.max_sq_feet == null ? null : Number(row.max_sq_feet),
          investment_strategy: row.investment_strategy,
          urgency: row.urgency,
          sensibilities: row.sensibilities
        },
        {
          id: row.seller_profile_id,
          entity_id: row.seller_entity_id,
          entity_name: row.seller_entity_name,
          distress_level: row.distress_level,
          motivation: row.motivation,
          timeline: row.timeline,
          foreclosure_stage: row.foreclosure_stage,
          lender_status: row.lender_status
        },
        {
          id: row.property_id,
          apn: row.apn,
          address: row.address,
          city: row.city,
          state: row.state,
          zip: row.zip,
          property_type: row.property_type,
          sq_feet: row.sq_feet == null ? null : Number(row.sq_feet),
          lot_size: row.lot_size == null ? null : Number(row.lot_size),
          assessed_value: row.assessed_value == null ? null : Number(row.assessed_value),
          foreclosure: row.foreclosure
        }
      );

      await query(
        `
          UPDATE matches
          SET narrative = $2::jsonb,
              narrative_generated_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
        `,
        [row.id, JSON.stringify(narrative)]
      );
      generated += 1;
    } catch (_error) {
      failed += 1;
    }
  }

  return { generated, failed };
}

module.exports = {
  generateMatchNarrative,
  batchGenerateNarratives,
  NARRATIVE_SYSTEM_PROMPT
};
