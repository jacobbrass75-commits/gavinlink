const knowledgeSearch = require('../knowledge/search');

function toNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().toUpperCase();
}

function cleanStringArray(values = []) {
  if (!Array.isArray(values)) {
    return [];
  }

  return [...new Set(values.map((value) => normalizeText(value)).filter(Boolean))];
}

function getBuyerPropertyTypes(buyer) {
  return cleanStringArray(buyer?.target_property_types || buyer?.preferred_property_types || []);
}

function getBuyerCities(buyer) {
  return cleanStringArray(buyer?.target_cities || []);
}

function getBuyerZipCodes(buyer) {
  return cleanStringArray(buyer?.target_zip_codes || []);
}

function getEffectivePrice(property) {
  return (
    toNumber(property?.asking_price) ??
    toNumber(property?.minimum_acceptable) ??
    toNumber(property?.assessed_value) ??
    null
  );
}

function getEffectiveSqFeet(property) {
  return toNumber(property?.sq_feet);
}

const ADJACENT_CITIES = new Map([
  ['CARSON', ['COMPTON', 'LONG BEACH', 'LOS ANGELES', 'TORRANCE']],
  ['COMPTON', ['CARSON', 'LONG BEACH', 'LOS ANGELES']],
  ['LONG BEACH', ['CARSON', 'COMPTON', 'LOS ANGELES']],
  ['LOS ANGELES', ['CARSON', 'COMPTON', 'LONG BEACH', 'INGLEWOOD', 'SOUTH GATE']]
]);

function isWithinPercent(distance, reference, percent) {
  if (!Number.isFinite(distance) || !Number.isFinite(reference) || reference <= 0) {
    return false;
  }

  return Math.abs(distance) <= reference * percent;
}

function scorePropertyType(buyer, property) {
  const targetTypes = getBuyerPropertyTypes(buyer);
  const propertyType = normalizeText(property?.property_type);

  if (targetTypes.length === 0) {
    return 12;
  }

  if (!propertyType) {
    return 0;
  }

  return targetTypes.includes(propertyType) ? 25 : 0;
}

function scorePrice(buyer, property) {
  const minPrice = toNumber(buyer?.min_price);
  const maxPrice = toNumber(buyer?.max_price);
  const price = getEffectivePrice(property);

  if (minPrice == null && maxPrice == null) {
    return 12;
  }

  if (price == null) {
    return 0;
  }

  if ((minPrice == null || price >= minPrice) && (maxPrice == null || price <= maxPrice)) {
    return 25;
  }

  if (maxPrice != null && price > maxPrice) {
    if (price <= maxPrice * 1.1) {
      return 15;
    }

    if (price <= maxPrice * 1.2) {
      return 8;
    }

    return 0;
  }

  if (minPrice != null && price < minPrice) {
    if (price >= minPrice * 0.9) {
      return 15;
    }

    if (price >= minPrice * 0.8) {
      return 8;
    }
  }

  return 0;
}

function scoreLocation(buyer, property) {
  const targetCities = getBuyerCities(buyer);
  const targetZipCodes = getBuyerZipCodes(buyer);
  const propertyCity = normalizeText(property?.city);
  const propertyZip = normalizeText(property?.zip);

  if (targetCities.length === 0 && targetZipCodes.length === 0) {
    return 10;
  }

  if (propertyCity && targetCities.includes(propertyCity)) {
    return 20;
  }

  if (propertyZip && targetZipCodes.includes(propertyZip)) {
    return 18;
  }

  if (propertyCity) {
    const isAdjacent = targetCities.some((city) => (ADJACENT_CITIES.get(city) || []).includes(propertyCity));

    if (isAdjacent) {
      return 10;
    }
  }

  return 0;
}

function scoreSize(buyer, property) {
  const minSqFeet = toNumber(buyer?.min_sq_feet);
  const maxSqFeet = toNumber(buyer?.max_sq_feet);
  const sqFeet = getEffectiveSqFeet(property);

  if (minSqFeet == null && maxSqFeet == null) {
    return 8;
  }

  if (sqFeet == null) {
    return 0;
  }

  const withinMin = minSqFeet == null || sqFeet >= minSqFeet;
  const withinMax = maxSqFeet == null || sqFeet <= maxSqFeet;

  if (withinMin && withinMax) {
    return 15;
  }

  if (minSqFeet != null && sqFeet < minSqFeet && isWithinPercent(minSqFeet - sqFeet, minSqFeet, 0.2)) {
    return 10;
  }

  if (maxSqFeet != null && sqFeet > maxSqFeet && isWithinPercent(sqFeet - maxSqFeet, maxSqFeet, 0.2)) {
    return 10;
  }

  return 0;
}

function scoreStrategy(buyer, seller, property) {
  const strategy = buyer?.investment_strategy || null;
  const distressLevel = toNumber(seller?.distress_level, 0);
  const price = getEffectivePrice(property) || 0;
  const lotSize = toNumber(property?.lot_size, 0);
  const sqFeet = getEffectiveSqFeet(property) || 0;

  if (!strategy) {
    return 5;
  }

  switch (strategy) {
    case 'value_add':
      return distressLevel >= 3 ? 15 : 6;
    case 'stabilized':
      return distressLevel <= 2 ? 12 : 0;
    case 'development':
      return lotSize > 20000 ? 10 : 3;
    case 'flip':
      return distressLevel >= 3 && price > 0 && price < 1000000 ? 12 : distressLevel >= 3 ? 6 : 0;
    case '1031_exchange':
      return 8;
    case 'owner_user': {
      const minSqFeet = toNumber(buyer?.min_sq_feet);
      const maxSqFeet = toNumber(buyer?.max_sq_feet);
      const withinMin = minSqFeet == null || sqFeet >= minSqFeet;
      const withinMax = maxSqFeet == null || sqFeet <= maxSqFeet;
      return withinMin && withinMax && sqFeet > 0 ? 10 : 4;
    }
    default:
      return 0;
  }
}

function scoreTiming(buyer, seller) {
  const urgency = buyer?.urgency || null;
  const timeline = seller?.timeline || null;

  if (!urgency || !timeline) {
    return 0;
  }

  if (urgency === 'urgent' && timeline === 'urgent') {
    return 10;
  }

  if (urgency === 'actively_looking' && timeline === 'urgent') {
    return 8;
  }

  if (urgency === 'actively_looking' && timeline === '30_days') {
    return 6;
  }

  if (urgency === 'opportunistic' && timeline === 'flexible') {
    return 4;
  }

  if (urgency === 'long_term' && timeline === 'flexible') {
    return 2;
  }

  return 0;
}

function normalizeContent(text) {
  return typeof text === 'string' ? text.toLowerCase() : '';
}

function extractKnowledgeSignals(results, property) {
  const propertyCity = normalizeContent(property?.city);
  const propertyZip = normalizeContent(property?.zip);
  const propertyType = normalizeContent(property?.property_type);
  const foreclosure = Boolean(property?.foreclosure);
  const positiveSignals = [];
  const negativeSignals = [];

  for (const result of results) {
    const text = normalizeContent(
      `${result.knowledge_entry?.title || ''}\n${result.knowledge_entry?.content || ''}`
    );

    if (!text) {
      continue;
    }

    if (
      propertyCity &&
      text.includes(propertyCity) &&
      /(love|likes|wants|prefer|target|interested|seeking|looking for)/i.test(text)
    ) {
      positiveSignals.push(`Buyer notes mention ${property.city}`);
    }

    if (
      propertyCity &&
      text.includes(propertyCity) &&
      /(avoid|won't|wont|not interested|pass on|exclude|skip)/i.test(text)
    ) {
      negativeSignals.push(`Buyer notes warn against ${property.city}`);
    }

    if (
      propertyZip &&
      text.includes(propertyZip) &&
      /(avoid|won't|wont|not interested|pass on|exclude|skip)/i.test(text)
    ) {
      negativeSignals.push(`Buyer notes warn against zip ${property.zip}`);
    }

    if (
      propertyType &&
      text.includes(propertyType) &&
      /(love|likes|wants|prefer|target|interested|seeking|looking for)/i.test(text)
    ) {
      positiveSignals.push(`Buyer notes reinforce ${property.property_type} interest`);
    }

    if (foreclosure && /(avoid foreclosures|won't deal with foreclosures|do not want foreclosure)/i.test(text)) {
      negativeSignals.push('Buyer notes avoid foreclosure opportunities');
    }

    if (foreclosure && /(value-add|distress|distressed|foreclosure opportunity)/i.test(text)) {
      positiveSignals.push('Buyer notes show interest in distressed opportunities');
    }
  }

  return {
    positiveSignals: [...new Set(positiveSignals)],
    negativeSignals: [...new Set(negativeSignals)]
  };
}

async function scoreKnowledgeAlignment(buyer, property) {
  if (!buyer?.entity_id) {
    return { adjustment: 0, signals: [] };
  }

  try {
    const results = await knowledgeSearch.semanticSearch(
      `${buyer.entity_name || ''} ${property?.city || ''} ${property?.property_type || ''}`.trim(),
      {
        entity_ids: [buyer.entity_id],
        limit: 5
      }
    );
    const { positiveSignals, negativeSignals } = extractKnowledgeSignals(results, property);
    let adjustment = 0;

    adjustment += Math.min(positiveSignals.length * 3, 10);
    adjustment -= Math.min(negativeSignals.length * 5, 10);

    return {
      adjustment: Math.max(-10, Math.min(10, adjustment)),
      signals: [...positiveSignals, ...negativeSignals]
    };
  } catch (_error) {
    return { adjustment: 0, signals: [] };
  }
}

async function calculateMatchScore(buyer, seller, property, options = {}) {
  const propertyType = scorePropertyType(buyer, property);
  const price = scorePrice(buyer, property);
  const location = scoreLocation(buyer, property);
  const size = scoreSize(buyer, property);
  const strategy = scoreStrategy(buyer, seller, property);
  const timing = scoreTiming(buyer, seller);
  const knowledge = options.skipKnowledge
    ? { adjustment: 0, signals: [] }
    : await scoreKnowledgeAlignment(buyer, property);
  const rawScore = propertyType + price + location + size + strategy + timing + knowledge.adjustment;
  let cappedScore = rawScore;

  if (propertyType === 0 && getBuyerPropertyTypes(buyer).length > 0) {
    cappedScore = Math.min(cappedScore, 30);
  }

  if (price === 0 && (toNumber(buyer?.min_price) != null || toNumber(buyer?.max_price) != null)) {
    cappedScore = Math.min(cappedScore, 40);
  }

  const score = Math.max(0, Math.min(100, Math.round(cappedScore)));
  const breakdown = {
    property_type: propertyType,
    price,
    location,
    size,
    strategy,
    timing,
    knowledge: knowledge.adjustment,
    knowledge_signals: knowledge.signals
  };
  const reasons = [
    { category: 'property_type', score: propertyType, detail: propertyType > 0 ? 'Property type aligns with buyer criteria.' : 'Property type does not align with buyer criteria.' },
    { category: 'price', score: price, detail: price > 0 ? 'Pricing sits within or near the buyer range.' : 'Pricing misses the buyer range.' },
    { category: 'location', score: location, detail: location > 0 ? 'Location fits the buyer target markets.' : 'Location does not fit the buyer target markets.' },
    { category: 'size', score: size, detail: size > 0 ? 'Size fits the buyer requirement.' : 'Size misses the buyer requirement.' },
    { category: 'strategy', score: strategy, detail: strategy > 0 ? 'Seller situation aligns with the buyer strategy.' : 'Seller situation does not align with the buyer strategy.' },
    { category: 'timing', score: timing, detail: timing > 0 ? 'Buyer and seller timing line up.' : 'Timing does not create a clear bonus.' },
    { category: 'knowledge', score: knowledge.adjustment, detail: knowledge.signals.length > 0 ? knowledge.signals.join('; ') : 'No knowledge-base adjustment applied.' }
  ];

  return { score, reasons, breakdown };
}

module.exports = {
  calculateMatchScore,
  scorePropertyType,
  scorePrice,
  scoreLocation,
  scoreSize,
  scoreStrategy,
  scoreTiming,
  scoreKnowledgeAlignment,
  getEffectivePrice
};
