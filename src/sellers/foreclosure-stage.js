function parseDate(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getMetadataValue(property, key) {
  if (!property || typeof property !== 'object') {
    return null;
  }

  const metadata = property.metadata;

  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }

  return metadata[key] ?? null;
}

function classifyForeclosureStage(property) {
  if (!property?.foreclosure) {
    return 'none';
  }

  const saleDate = parseDate(property.sale_date || getMetadataValue(property, 'sale_date'));

  if (saleDate) {
    return 'reo';
  }

  const effectiveDefaultDate = parseDate(property.default_date || property.titlepro_recording_date);

  if (effectiveDefaultDate) {
    const ageMs = Date.now() - effectiveDefaultDate.getTime();
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

    if (ageDays <= 90) {
      return 'notice_of_default';
    }

    if (ageDays <= 180) {
      return 'notice_of_sale';
    }

    return 'auction_pending';
  }

  const titleproStatus =
    property.titlepro_status || getMetadataValue(property, 'titlepro_status');

  if (titleproStatus === 'no_recording_date') {
    return 'pre_foreclosure';
  }

  return 'unknown';
}

module.exports = {
  classifyForeclosureStage
};
