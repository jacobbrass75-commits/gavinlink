const provider = require('../inference/provider');
const { classifyEntityType, normalizeName } = require('../entities/extract');
const { normalizeEntityType, findEntitiesFuzzy } = require('./merge');
const { query } = require('../db/connection');

const SYSTEM_PROMPT = `You are the ingestion engine for a commercial real estate Second Brain. The user (a broker) is going to tell you something. Your job is to classify what they said and extract structured data from it.

You must respond with ONLY a JSON object. No other text, no markdown code fences.

Classify the message into one or more of these types:
- "buyer_intel" — info about someone who wants to BUY property
- "seller_intel" — info about someone who wants to SELL or is in distress
- "property_note" — info about a specific property
- "relationship" — info about how people/companies connect to each other
- "market_insight" — general market observation, trend, or data point
- "deal_update" — update on an active deal or negotiation
- "action_item" — something the broker needs to do
- "general_note" — doesn't fit the above, just store it

For each classification, extract all relevant structured data.

Response format:
{
  "classifications": ["buyer_intel"],
  "entities": [
    {
      "name": "Mike Chen",
      "type": "person",
      "phone": null,
      "email": null
    },
    {
      "name": "Pacific Industrial Group",
      "type": "company"
    }
  ],
  "relationships": [
    {
      "entity_a": "Mike Chen",
      "entity_b": "Pacific Industrial Group",
      "relationship": "principal_of"
    }
  ],
  "buyer_profile": {
    "entity_name": "Mike Chen",
    "target_property_types": ["industrial"],
    "target_cities": ["Carson", "Compton"],
    "min_sq_feet": 30000,
    "max_price": 4000000,
    "financing_preference": "sba",
    "investment_strategy": "owner_user",
    "urgency": "actively_looking",
    "sensibilities": "Numbers-driven, direct communicator, don't waste time with fluff"
  },
  "seller_profile": null,
  "property_ref": null
}

When the message is about a seller or distressed property, use this seller_profile format instead:
{
  "classifications": ["seller_intel", "property_note"],
  "entities": [...],
  "relationships": [...],
  "buyer_profile": null,
  "seller_profile": {
    "entity_name": "Jane Smith",
    "motivation": "foreclosure",
    "distress_level": 4,
    "timeline": "30 days",
    "lender_status": "not cooperating",
    "minimum_acceptable": 10000000,
    "asking_price": null,
    "sensibilities": "Desperate, willing to take cash below market",
    "notes": null
  },
  "property_ref": { "apn": null, "address": "8122 Maie Ave", "raw": "8122 Maie Ave" },
  "action_items": [
    "Run matching for Mike Chen against current inventory",
    "Send Mike 2-3 property options within 48 hours"
  ],
  "summary": "New buyer contact: Mike Chen of Pacific Industrial Group seeking 30k+ sqft industrial in Carson/Compton, $4M budget, SBA financing."
}

Rules:
- Only include fields where you extracted real data. Use null for missing.
- For property_ref, use APN if mentioned, otherwise address.
- For relationship types, use: principal_of, member_of, manages, partner_of, lender_to, trustee_for, employee_of, attorney_for
- For investment_strategy, use: value_add, stabilized, development, owner_user, flip, 1031_exchange
- For financing_preference, use: cash, conventional, sba, bridge, seller_financing
- For urgency, use: actively_looking, opportunistic, long_term
- Extract sensibilities verbatim — preserve the broker's exact observations about communication style, preferences, deal-breakers
- Be conservative — if you're not sure, omit the field rather than guess
- For seller_profile.motivation, use: foreclosure, bankruptcy, divorce, estate, relocation, retirement, market_timing
- For seller_profile.distress_level, use 1-5 (1=not distressed, 5=extremely distressed)
- When a message mentions a property owner wanting to sell, in distress, or facing foreclosure, ALWAYS include a seller_profile
- When a message references a specific property address or APN, ALWAYS include property_ref

IMPORTANT — Follow-up messages:
- If "Known entities" context is provided below, the broker is adding NEW information about people/companies already in the system.
- When a message mentions a known entity with an existing buyer profile, classify as "buyer_intel" and include a buyer_profile with ONLY the new/changed fields (the system will merge them).
- When a message mentions a known entity with an existing seller profile, classify as "seller_intel".
- Always extract ALL people mentioned — including new people introduced alongside known ones (e.g. "his partner Dave" means Dave is a new entity).
- When a message updates an existing contact (new cities, new preferences, new relationships), this is NOT a "general_note" — classify it by what the update is about.`;

const ALLOWED_CLASSIFICATIONS = new Set([
  'buyer_intel',
  'seller_intel',
  'property_note',
  'relationship',
  'market_insight',
  'deal_update',
  'action_item',
  'general_note'
]);

const ALLOWED_RELATIONSHIPS = new Set([
  'principal_of',
  'member_of',
  'manages',
  'partner_of',
  'lender_to',
  'trustee_for',
  'employee_of',
  'attorney_for'
]);

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function cleanStringArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return [...new Set(values.map((value) => cleanText(value, null)).filter(Boolean))];
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number(String(value).replace(/[$,]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePriceToken(rawValue) {
  const value = cleanText(rawValue, null);

  if (!value) {
    return null;
  }

  const normalized = value.toUpperCase().replace(/[$,\s]/g, '');
  const millionMatch = normalized.match(/^(\d+(?:\.\d+)?)M$/);

  if (millionMatch) {
    return Math.round(Number(millionMatch[1]) * 1000000);
  }

  const thousandMatch = normalized.match(/^(\d+(?:\.\d+)?)K$/);

  if (thousandMatch) {
    return Math.round(Number(thousandMatch[1]) * 1000);
  }

  return nullableNumber(normalized);
}

function parseSquareFeetToken(rawValue) {
  const value = cleanText(rawValue, null);

  if (!value) {
    return null;
  }

  const normalized = value.toUpperCase().replace(/[,\s]/g, '');
  const thousandMatch = normalized.match(/^(\d+(?:\.\d+)?)K$/);

  if (thousandMatch) {
    return Math.round(Number(thousandMatch[1]) * 1000);
  }

  return nullableNumber(normalized);
}

function normalizeClassificationList(values) {
  const cleaned = cleanStringArray(values)
    .map((value) => value.toLowerCase())
    .filter((value) => ALLOWED_CLASSIFICATIONS.has(value));

  return cleaned.length > 0 ? cleaned : ['general_note'];
}

function normalizeRelationshipType(value) {
  const cleaned = cleanText(value, null);

  if (!cleaned) {
    return null;
  }

  return ALLOWED_RELATIONSHIPS.has(cleaned) ? cleaned : null;
}

function normalizeEntity(entity = {}) {
  const name = cleanText(entity.name, null);

  if (!name) {
    return null;
  }

  const inferredType = normalizeEntityType(entity.type, name);

  return {
    name,
    type: inferredType || classifyEntityType(name, 'owner_name'),
    phone: cleanText(entity.phone, null),
    email: cleanText(entity.email, null)
  };
}

function extractCapitalizedNames(message) {
  const matches = message.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
  return [...new Set(matches)];
}

function extractCompanyNames(message) {
  const matches =
    message.match(
      /\b[A-Z][A-Za-z&.\s]+(?:LLC|L\.L\.C\.|INC|INCORPORATED|CORP|CORPORATION|GROUP|PARTNERS|PARTNERSHIP|HOLDINGS|CAPITAL|PROPERTIES|COMPANY)\b/g
    ) || [];

  return [...new Set(matches.map((value) => value.trim()))];
}

function extractCities(message) {
  const matches = [];
  const cityPattern = /\b(?:in|around|near)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*(?:,\s*[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)*)/g;
  let cityMatch;

  while ((cityMatch = cityPattern.exec(message)) !== null) {
    const segment = cityMatch[1];
    for (const part of segment.split(/,| and /i)) {
      const city = cleanText(part, null);

      if (city) {
        matches.push(city);
      }
    }
  }

  return [...new Set(matches)];
}

function extractPropertyRef(message) {
  const apnMatch = message.match(/\b\d[\d-]{5,}\b/);

  if (apnMatch) {
    return {
      apn: apnMatch[0],
      address: null,
      raw: apnMatch[0]
    };
  }

  const addressMatch = message.match(
    /\b\d{2,6}\s+[A-Z0-9][A-Za-z0-9.\-']*(?:\s+[A-Z0-9][A-Za-z0-9.\-']*)*\s(?:AVE|AVENUE|BLVD|BOULEVARD|ST|STREET|RD|ROAD|DR|DRIVE|PL|PLACE|WAY|LN|LANE|CT|COURT|HWY|HIGHWAY)\b/i
  );

  if (addressMatch) {
    return {
      apn: null,
      address: addressMatch[0],
      raw: addressMatch[0]
    };
  }

  return null;
}

function fallbackClassify(message) {
  const text = cleanText(message, '') || '';
  const lowered = text.toLowerCase();
  const classifications = new Set();
  const entities = [];
  const relationships = [];
  const propertyRef = extractPropertyRef(text);
  const personNames = extractCapitalizedNames(text);
  const companyNames = extractCompanyNames(text);

  if (
    /\b(wants?|looking for|buyer|buy|budget|sba|cash buyer|owner[- ]user|1031)\b/i.test(text)
  ) {
    classifications.add('buyer_intel');
  }

  if (
    /\b(seller|owner of|distress|desperate|take\s+\$?\d|foreclosure|motivated|wants to sell)\b/i.test(
      text
    ) ||
    propertyRef
  ) {
    classifications.add(propertyRef ? 'property_note' : 'seller_intel');
  }

  if (/\b(controls|principal of|member of|partner with|manages)\b/i.test(text)) {
    classifications.add('relationship');
  }

  if (/\b(rents?|market|cap rates?|pricing|jumping|trend)\b/i.test(text)) {
    classifications.add('market_insight');
  }

  if (/\b(follow up|send|call|email|need to|todo|task)\b/i.test(text)) {
    classifications.add('action_item');
  }

  if (classifications.size === 0) {
    classifications.add('general_note');
  }

  for (const name of personNames) {
    if (companyNames.includes(name)) {
      continue;
    }

    entities.push({
      name,
      type: 'person'
    });
  }

  for (const name of companyNames) {
    entities.push({
      name,
      type: classifyEntityType(name, 'owner_name')
    });
  }

  if (classifications.has('relationship')) {
    if (/\bcontrols\b/i.test(text) && personNames.length >= 1 && companyNames.length >= 1) {
      for (const companyName of companyNames) {
        relationships.push({
          entity_a: personNames[0],
          entity_b: companyName,
          relationship: 'principal_of'
        });
      }
    }

    if (/\bmember of\b/i.test(text) && personNames.length >= 1 && companyNames.length >= 1) {
      relationships.push({
        entity_a: personNames[0],
        entity_b: companyNames[0],
        relationship: 'member_of'
      });
    }
  }

  const propertyTypes = [];

  for (const propertyType of ['industrial', 'multifamily', 'retail', 'office', 'commercial']) {
    if (lowered.includes(propertyType)) {
      propertyTypes.push(propertyType);
    }
  }

  let financingPreference = null;

  for (const option of ['sba', 'cash', 'conventional', 'bridge']) {
    if (new RegExp(`\\b${option.replace('_', ' ')}\\b`, 'i').test(text)) {
      financingPreference = option;
      break;
    }
  }

  let investmentStrategy = null;

  for (const [pattern, mapped] of [
    [/\bowner[- ]user\b/i, 'owner_user'],
    [/\bvalue[- ]add\b/i, 'value_add'],
    [/\bstabilized\b/i, 'stabilized'],
    [/\bdevelopment\b/i, 'development'],
    [/\bflip\b/i, 'flip'],
    [/\b1031\b/i, '1031_exchange']
  ]) {
    if (pattern.test(text)) {
      investmentStrategy = mapped;
      break;
    }
  }

  let urgency = null;

  if (/\b(active|asap|urgently|soon|this quarter|q[1-4])\b/i.test(text)) {
    urgency = 'actively_looking';
  } else if (/\bopportunistic\b/i.test(text)) {
    urgency = 'opportunistic';
  } else if (/\blong term\b/i.test(text)) {
    urgency = 'long_term';
  }

  const budgetMatch =
    text.match(/\$?\s*(\d+(?:\.\d+)?)\s*([MK])\b/i) ||
    text.match(/\bbudget\s*(?:is|around|at)?\s*\$?\s*([\d,.]+)\b/i);
  const sqftMatch = text.match(/\b(\d+(?:\.\d+)?)\s*(K)?\s*(?:sq\.?\s*ft\.?|sqft|square feet)\b/i);
  const sensibilitySentence = text
    .split(/(?<=[.!?])\s+/)
    .find((sentence) => /\b(direct|numbers-driven|communicator|fluff|deal-breaker|waste time)\b/i.test(sentence));

  const buyerProfile =
    classifications.has('buyer_intel') && personNames[0]
      ? {
          entity_name: personNames[0],
          target_property_types: propertyTypes,
          target_cities: extractCities(text),
          min_sq_feet: sqftMatch
            ? parseSquareFeetToken(`${sqftMatch[1]}${sqftMatch[2] || ''}`)
            : null,
          max_price: budgetMatch
            ? parsePriceToken(`${budgetMatch[1]}${budgetMatch[2] || ''}`)
            : null,
          financing_preference: financingPreference,
          investment_strategy: investmentStrategy,
          urgency,
          sensibilities: cleanText(sensibilitySentence, null)
        }
      : null;

  const sellerProfile =
    classifications.has('seller_intel') || classifications.has('property_note')
      ? {
          entity_name: companyNames[0] || personNames[0] || null,
          motivation: /\bforeclosure|desperate|motivated\b/i.test(text) ? 'foreclosure' : null,
          distress_level: /\bdesperate|urgent|foreclosure\b/i.test(text) ? 4 : null,
          minimum_acceptable: (() => {
            const takeMatch = text.match(/\btake\s+\$?\s*(\d+(?:\.\d+)?)\s*([MK])?\b/i);
            return takeMatch ? parsePriceToken(`${takeMatch[1]}${takeMatch[2] || ''}`) : null;
          })(),
          sensibilities: cleanText(sensibilitySentence, null)
        }
      : null;

  const actionItems =
    classifications.has('action_item')
      ? text
          .split(/(?:\.|\band\b)/i)
          .map((value) => cleanText(value, null))
          .filter((value) => value && /\b(send|call|email|follow up|run)\b/i.test(value))
      : [];

  return {
    classifications: [...classifications],
    entities,
    relationships,
    buyer_profile: buyerProfile,
    seller_profile: sellerProfile,
    property_ref: propertyRef,
    action_items: actionItems,
    summary: cleanText(text.slice(0, 240), 'General note captured')
  };
}

function validateClassification(response) {
  let parsed = response;

  if (typeof response === 'string') {
    const start = response.indexOf('{');
    const end = response.lastIndexOf('}');

    if (start === -1 || end === -1 || end < start) {
      throw new Error('Classification response was not valid JSON');
    }

    try {
      parsed = JSON.parse(response.slice(start, end + 1));
    } catch (_error) {
      throw new Error('Classification response contained malformed JSON');
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Classification response must be an object');
  }

  const entities = Array.isArray(parsed.entities)
    ? parsed.entities.map(normalizeEntity).filter(Boolean)
    : [];
  const relationships = Array.isArray(parsed.relationships)
    ? parsed.relationships
        .map((relationship) => ({
          entity_a: cleanText(relationship?.entity_a, null),
          entity_b: cleanText(relationship?.entity_b, null),
          relationship: normalizeRelationshipType(relationship?.relationship)
        }))
        .filter(
          (relationship) =>
            relationship.entity_a && relationship.entity_b && relationship.relationship
        )
    : [];

  const buyerProfile =
    parsed.buyer_profile && typeof parsed.buyer_profile === 'object'
      ? {
          entity_name: cleanText(parsed.buyer_profile.entity_name, null),
          target_property_types: cleanStringArray(parsed.buyer_profile.target_property_types),
          target_cities: cleanStringArray(parsed.buyer_profile.target_cities),
          target_markets: cleanStringArray(parsed.buyer_profile.target_markets),
          target_zip_codes: cleanStringArray(parsed.buyer_profile.target_zip_codes),
          min_price: nullableNumber(parsed.buyer_profile.min_price),
          min_sq_feet: nullableNumber(parsed.buyer_profile.min_sq_feet),
          max_sq_feet: nullableNumber(parsed.buyer_profile.max_sq_feet),
          max_price: nullableNumber(parsed.buyer_profile.max_price),
          financing_preference: cleanText(parsed.buyer_profile.financing_preference, null),
          investment_strategy: cleanText(parsed.buyer_profile.investment_strategy, null),
          urgency: cleanText(parsed.buyer_profile.urgency, null),
          sensibilities: cleanText(parsed.buyer_profile.sensibilities, null)
        }
      : null;

  const sellerProfile =
    parsed.seller_profile && typeof parsed.seller_profile === 'object'
      ? {
          entity_name: cleanText(parsed.seller_profile.entity_name, null),
          motivation: cleanText(parsed.seller_profile.motivation, null),
          distress_level: nullableNumber(parsed.seller_profile.distress_level),
          timeline: cleanText(parsed.seller_profile.timeline, null),
          lender_status: cleanText(parsed.seller_profile.lender_status, null),
          minimum_acceptable: nullableNumber(parsed.seller_profile.minimum_acceptable),
          asking_price: nullableNumber(parsed.seller_profile.asking_price),
          sensibilities: cleanText(parsed.seller_profile.sensibilities, null),
          notes: cleanText(parsed.seller_profile.notes, null)
        }
      : null;

  const propertyRef =
    parsed.property_ref && typeof parsed.property_ref === 'object'
      ? {
          apn: cleanText(parsed.property_ref.apn, null),
          address: cleanText(parsed.property_ref.address, null),
          raw: cleanText(parsed.property_ref.raw, null)
        }
      : null;

  const classifications = normalizeClassificationList(parsed.classifications);
  const actionItems = cleanStringArray(parsed.action_items);
  const summary = cleanText(parsed.summary, 'General note captured');

  return {
    classifications,
    entities,
    relationships,
    buyer_profile: buyerProfile,
    seller_profile: sellerProfile,
    property_ref: propertyRef,
    action_items: actionItems,
    summary
  };
}

async function buildEntityContext(message) {
  const names = extractCapitalizedNames(message);

  if (names.length === 0) {
    return '';
  }

  const seen = new Set();
  const contextLines = [];

  for (const name of names) {
    const normalized = normalizeName(name);

    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);

    let matches;

    try {
      matches = await findEntitiesFuzzy(normalized, 0.5);
    } catch (_error) {
      continue;
    }

    if (!matches || matches.length === 0) {
      continue;
    }

    const entity = matches[0];

    if (entity.score < 0.5) {
      continue;
    }

    let line = `- ${entity.name} (${entity.entity_type})`;

    try {
      const buyerResult = await query(
        `SELECT bp.id, bp.preferred_property_types, bp.target_cities, bp.urgency,
                bp.financing_preference, bp.investment_strategy, bp.max_price
         FROM buyer_profiles bp WHERE bp.entity_id = $1 AND bp.active = TRUE LIMIT 1`,
        [entity.id]
      );

      if (buyerResult.rows[0]) {
        const bp = buyerResult.rows[0];
        const details = [];

        if (bp.preferred_property_types?.length) {
          details.push(`looking for: ${bp.preferred_property_types.join(', ')}`);
        }

        if (bp.target_cities?.length) {
          details.push(`in: ${bp.target_cities.join(', ')}`);
        }

        if (bp.max_price) {
          details.push(`budget: $${Number(bp.max_price).toLocaleString()}`);
        }

        if (details.length) {
          line += ` [EXISTING BUYER: ${details.join('; ')}]`;
        }
      }

      const sellerResult = await query(
        `SELECT sp.id FROM seller_profiles sp
         JOIN entities e ON e.id = sp.entity_id
         WHERE sp.entity_id = $1 LIMIT 1`,
        [entity.id]
      );

      if (sellerResult.rows[0]) {
        line += ' [EXISTING SELLER]';
      }
    } catch (_error) {
      // DB lookup failed — still include the entity without profile details
    }

    contextLines.push(line);
  }

  if (contextLines.length === 0) {
    return '';
  }

  return `\n\nKnown entities mentioned in this message:\n${contextLines.join('\n')}`;
}

async function classifyMessage(message) {
  const cleanMessage = cleanText(message, null);

  if (!cleanMessage) {
    throw new Error('message must be a non-empty string');
  }

  let entityContext = '';

  try {
    entityContext = await buildEntityContext(cleanMessage);
  } catch (_error) {
    // If context lookup fails, proceed without it
  }

  try {
    const response = await provider.complete(
      `${SYSTEM_PROMPT}${entityContext}\n\nBroker message:\n${cleanMessage}`
    );

    return validateClassification(response);
  } catch (_error) {
    return validateClassification(fallbackClassify(cleanMessage));
  }
}

module.exports = {
  classifyMessage,
  validateClassification,
  SYSTEM_PROMPT
};
