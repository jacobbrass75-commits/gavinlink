const { getEffectivePrice } = require('./scorer');

function toNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatCurrency(value) {
  const amount = toNumber(value);

  if (amount == null) {
    return null;
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0
  }).format(amount);
}

function formatSqFeet(value) {
  const amount = toNumber(value);

  if (amount == null) {
    return null;
  }

  return `${new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0
  }).format(amount)} sqft`;
}

function explainMatch({ buyer, seller, property, breakdown = {} }) {
  const reasons = [];
  const propertyPrice = getEffectivePrice(property);

  if (breakdown.property_type > 0 && property?.property_type) {
    reasons.push(`Property type match: ${property.property_type}`);
  }

  if (breakdown.location >= 20 && property?.city) {
    reasons.push(`Target city: ${property.city}`);
  } else if (breakdown.location >= 10 && property?.city) {
    reasons.push(`Location bonus: ${property.city} is near the buyer target area`);
  }

  if (breakdown.size > 0 && property?.sq_feet) {
    reasons.push(`Size match: ${formatSqFeet(property.sq_feet)} fits the buyer requirement`);
  }

  if (breakdown.strategy > 0) {
    const strategy = buyer?.investment_strategy || 'buyer strategy';
    const distress = seller?.distress_level ?? 'unknown';
    reasons.push(`Strategy fit: ${strategy} aligns with seller distress level ${distress}`);
  }

  if (breakdown.timing > 0 && buyer?.urgency && seller?.timeline) {
    reasons.push(`Timing alignment: ${buyer.urgency} buyer and ${seller.timeline} seller`);
  }

  if (breakdown.price > 0 && propertyPrice != null) {
    reasons.push(`Pricing fit: ${formatCurrency(propertyPrice)} is workable for this buyer`);
  } else if (buyer?.max_price != null && propertyPrice != null) {
    reasons.push(
      `PRICE FLAG: ${formatCurrency(propertyPrice)} exceeds ${formatCurrency(buyer.max_price)} budget`
    );
  }

  if (Array.isArray(breakdown.knowledge_signals)) {
    for (const signal of breakdown.knowledge_signals) {
      if (typeof signal !== 'string' || signal.trim() === '') {
        continue;
      }

      if (breakdown.knowledge < 0) {
        reasons.push(`Knowledge caution: ${signal}`);
      } else {
        reasons.push(`Knowledge signal: ${signal}`);
      }
    }
  }

  if (reasons.length === 0) {
    reasons.push('No strong alignment signals were detected for this pairing.');
  }

  return reasons;
}

module.exports = {
  explainMatch,
  formatCurrency,
  formatSqFeet
};
