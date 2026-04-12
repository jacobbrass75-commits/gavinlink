const { v4: uuidv4 } = require('uuid');
const { query } = require('../db/connection');
const { createKnowledgeEntry } = require('../knowledge/extract');
const { storeEmbedding } = require('../knowledge/embeddings');
const { getMessageBodies, getMessageMeta, listMessages, getMessage, decodeHtmlEntities, stripHtml } = require('../integrations/gmail');
const { fetchProperty } = require('../integrations/realestatetool');
const { buildContainsPattern } = require('../utils/sql');
const { normalizeAddress } = require('../properties/grouping');
const { createSellerProfile, getSellerProfileByProperty, updateSellerProfile } = require('../sellers/profiles');
const { getDistressAssessment } = require('../sellers/distress-score');

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function cleanUpper(value, fallback = null) {
  const text = cleanText(value, fallback);
  return text ? text.toUpperCase() : fallback;
}

function toNullableNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }

  const normalized = String(value)
    .trim()
    .replace(/[$,]/g, '');

  if (normalized === '' || /^n\/a$/i.test(normalized)) {
    return fallback;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function slugify(value, fallback = 'other') {
  const text = cleanText(value, '');

  if (!text) {
    return fallback;
  }

  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return slug || fallback;
}

function deriveTimeline(stage) {
  if (stage === 'auction_pending' || stage === 'reo') {
    return 'urgent';
  }

  if (stage === 'notice_of_sale') {
    return '30_days';
  }

  if (stage === 'notice_of_default') {
    return '60_days';
  }

  if (stage === 'pre_foreclosure') {
    return '90_days';
  }

  return 'flexible';
}

function extractAlertName(subject, bodyText = '') {
  const candidates = [subject, bodyText];

  for (const candidate of candidates) {
    const text = cleanText(candidate, '');

    if (!text) {
      continue;
    }

    const subjectMatch = text.match(/Daily Digest Alert:\s*(.+)$/i);

    if (subjectMatch) {
      return cleanText(subjectMatch[1], null);
    }

    const bodyMatch = text.match(/daily digest alert,\s*(.+?),\s*found a match/i);

    if (bodyMatch) {
      return cleanText(bodyMatch[1], null);
    }
  }

  return null;
}

function normalizePropertyRadarChange(changeSummary) {
  const raw = cleanText(changeSummary, null);
  const normalized = cleanText(changeSummary, '')
    .toLowerCase()
    .replace(/\bnew\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!raw) {
    return {
      raw: null,
      change_type: 'other',
      foreclosure_related: false
    };
  }

  if (normalized.includes('notice of default')) {
    return {
      raw,
      change_type: 'notice_of_default',
      foreclosure_related: true
    };
  }

  if (normalized.includes('notice of sale')) {
    return {
      raw,
      change_type: 'notice_of_sale',
      foreclosure_related: true
    };
  }

  if (normalized.includes('pre foreclosure') || normalized.includes('pre-foreclosure')) {
    return {
      raw,
      change_type: 'pre_foreclosure',
      foreclosure_related: true
    };
  }

  if (normalized.includes('auction')) {
    return {
      raw,
      change_type: 'auction_pending',
      foreclosure_related: true
    };
  }

  if (normalized.includes('reo') || normalized.includes('real estate owned')) {
    return {
      raw,
      change_type: 'reo',
      foreclosure_related: true
    };
  }

  if (normalized.includes('trustee')) {
    return {
      raw,
      change_type: 'trustee_activity',
      foreclosure_related: true
    };
  }

  return {
    raw,
    change_type: slugify(normalized, 'other'),
    foreclosure_related: /\b(default|sale|auction|reo|foreclosure|trustee)\b/.test(normalized)
  };
}

function mapAlertColumns(columns, context = {}) {
  if (!Array.isArray(columns) || columns.length < 11) {
    return null;
  }

  const normalized = normalizePropertyRadarChange(columns[10]);

  return {
    alert_name: context.alert_name || null,
    radar_id: cleanText(columns[0], null),
    street: cleanText(columns[1], null),
    city: cleanUpper(columns[2], null),
    zip: cleanText(columns[3], null),
    state: cleanUpper(columns[4], null),
    property_type: cleanUpper(columns[5], null),
    sq_feet: toNullableNumber(columns[6]),
    beds: toNullableNumber(columns[7]),
    baths: toNullableNumber(columns[8]),
    est_value: toNullableNumber(columns[9]),
    what_changed: cleanText(columns[10], null),
    normalized_change_type: normalized.change_type,
    foreclosure_related: normalized.foreclosure_related
  };
}

function parsePropertyRadarTextRow(line, context = {}) {
  const normalizedLine = cleanText(
    decodeHtmlEntities(String(line || '')).replace(/<https?:\/\/[^>]+>/gi, '').trim(),
    ''
  );

  if (!normalizedLine) {
    return null;
  }

  const pattern =
    /^(\S+)\s{2,}(.+?)\s{2,}([A-Z][A-Z .'-]+)\s{2,}(\d{5})\s{2,}([A-Z]{2})\s{2,}([A-Z]+)\s{2,}([\d,]+)(?:\s{2,}([\d.]+))?(?:\s{2,}([\d.]+))?\s{2,}(\$[\d,]+)\s{2,}(.+)$/i;
  const match = normalizedLine.match(pattern);

  if (!match) {
    return null;
  }

  const [
    ,
    radarId,
    street,
    city,
    zip,
    state,
    propertyType,
    sqFeet,
    beds,
    baths,
    estValue,
    whatChanged
  ] = match;

  return mapAlertColumns(
    [
      radarId,
      street,
      city,
      zip,
      state,
      propertyType,
      sqFeet,
      beds || '',
      baths || '',
      estValue,
      whatChanged
    ],
    context
  );
}

function parsePropertyRadarDigestHtml(html, context = {}) {
  const source = cleanText(html, '');

  if (!source) {
    return [];
  }

  const rows = source.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const parsed = [];
  let inTable = false;

  for (const row of rows) {
    const cells = Array.from(row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi))
      .map((match) => stripHtml(match[1]))
      .map((value) => cleanText(value, ''))
      .filter(Boolean);

    if (cells.length === 0) {
      continue;
    }

    if (!inTable) {
      inTable = cells.some((cell) => /^radar id$/i.test(cell)) && cells.some((cell) => /^street$/i.test(cell));
      continue;
    }

    const mapped = mapAlertColumns(cells, context);

    if (mapped) {
      parsed.push(mapped);
    }
  }

  return parsed;
}

function parsePropertyRadarDigestText(text, context = {}) {
  const source = cleanText(text, '');

  if (!source) {
    return [];
  }

  const lines = source
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed = [];
  let inTable = false;

  for (const line of lines) {
    if (!inTable) {
      if (/^Radar ID\s+Street\s+City\s+Zip\s+State\s+Type/i.test(line)) {
        inTable = true;
      }
      continue;
    }

    if (/^(Login to disable this alert|E-mail support|PropertyRadar\.com)/i.test(line)) {
      break;
    }

    const delimiter = line.includes('\t') ? /\t+/ : /\s{2,}/;
    const columns = line.split(delimiter).map((value) => cleanText(decodeHtmlEntities(value), '')).filter(Boolean);
    const mapped = mapAlertColumns(columns, context) || parsePropertyRadarTextRow(line, context);

    if (mapped) {
      parsed.push(mapped);
    }
  }

  return parsed;
}

function parsePropertyRadarDigest({ subject, text, html }) {
  const alertName = extractAlertName(subject, text || html || '');
  const htmlRows = parsePropertyRadarDigestHtml(html, { alert_name: alertName });

  if (htmlRows.length > 0) {
    return {
      alert_name: alertName,
      rows: htmlRows
    };
  }

  return {
    alert_name: alertName,
    rows: parsePropertyRadarDigestText(text, { alert_name: alertName })
  };
}

async function findMatchingPropertyForAlert(alert) {
  const street = cleanText(alert.street, null);

  if (!street) {
    return null;
  }

  const normalizedStreet = normalizeAddress(street);
  const zip = cleanText(alert.zip, null);
  const city = cleanUpper(alert.city, null);

  const primaryResult = await query(
    `
      SELECT
        p.*,
        similarity(COALESCE(p.address, ''), $1) AS score,
        CASE
          WHEN REGEXP_REPLACE(UPPER(COALESCE(p.address, '')), '[^A-Z0-9]+', ' ', 'g') = $3 THEN 1
          ELSE 0
        END AS normalized_exact,
        CASE
          WHEN $4::text IS NOT NULL AND UPPER(COALESCE(p.city, '')) = $4 THEN 1
          ELSE 0
        END AS city_exact,
        CASE
          WHEN $5::text IS NOT NULL AND COALESCE(p.zip, '') = $5 THEN 1
          ELSE 0
        END AS zip_exact
      FROM properties p
      WHERE (
          COALESCE(p.address, '') ILIKE $2 ESCAPE '\\'
          OR REGEXP_REPLACE(UPPER(COALESCE(p.address, '')), '[^A-Z0-9]+', ' ', 'g') = $3
          OR similarity(COALESCE(p.address, ''), $1) >= 0.35
        )
        AND ($4::text IS NULL OR UPPER(COALESCE(p.city, '')) = $4)
        AND ($5::text IS NULL OR COALESCE(p.zip, '') = $5)
      ORDER BY normalized_exact DESC, zip_exact DESC, city_exact DESC, score DESC, p.updated_at DESC NULLS LAST
      LIMIT 1
    `,
    [street, buildContainsPattern(street), normalizedStreet, city, zip]
  );

  if (primaryResult.rows[0]) {
    return primaryResult.rows[0];
  }

  const fallbackResult = await query(
    `
      SELECT
        p.*,
        similarity(COALESCE(p.address, ''), $1) AS score
      FROM properties p
      WHERE COALESCE(p.address, '') ILIKE $2 ESCAPE '\\'
         OR REGEXP_REPLACE(UPPER(COALESCE(p.address, '')), '[^A-Z0-9]+', ' ', 'g') = $3
         OR similarity(COALESCE(p.address, ''), $1) >= 0.35
      ORDER BY score DESC, p.updated_at DESC NULLS LAST
      LIMIT 1
    `,
    [street, buildContainsPattern(street), normalizedStreet]
  );

  return fallbackResult.rows[0] || null;
}

function cleanZip(value) {
  return cleanText(value, null)?.replace(/\.0$/, '') || null;
}

function normalizeRealEstateToolType(value) {
  const text = cleanUpper(value, null);

  if (!text) {
    return null;
  }

  if (text === 'IND') {
    return 'industrial';
  }

  if (text === 'COM') {
    return 'commercial';
  }

  if (text === 'MF') {
    return 'multifamily';
  }

  if (text === 'RES') {
    return 'residential';
  }

  return text.toLowerCase();
}

function buildPropertyRadarMetadata(property, alert, messageMeta, realEstateToolSnapshot) {
  const existing = property?.metadata && typeof property.metadata === 'object' && !Array.isArray(property.metadata)
    ? property.metadata
    : {};
  const propertyRadar = existing.propertyradar && typeof existing.propertyradar === 'object'
    ? existing.propertyradar
    : {};

  return {
    ...existing,
    propertyradar: {
      ...propertyRadar,
      last_alert: {
        alert_name: alert.alert_name,
        radar_id: alert.radar_id,
        what_changed: alert.what_changed,
        normalized_change_type: alert.normalized_change_type,
        source_message_id: messageMeta.message_id || messageMeta.id || null,
        occurred_at: messageMeta.occurred_at || null
      },
      last_realestatetool_refresh_at: realEstateToolSnapshot ? new Date().toISOString() : propertyRadar.last_realestatetool_refresh_at || null
    }
  };
}

async function maybeRefreshRealEstateToolSnapshot(property) {
  if (!cleanText(property?.apn, null)) {
    return null;
  }

  try {
    return await fetchProperty(property.apn);
  } catch (_error) {
    return null;
  }
}

async function updatePropertyFromAlert(property, alert, messageMeta, realEstateToolSnapshot) {
  if (!property?.id) {
    return null;
  }

  const occursOn = messageMeta.occurred_at ? new Date(messageMeta.occurred_at).toISOString().slice(0, 10) : null;
  const metadata = buildPropertyRadarMetadata(property, alert, messageMeta, realEstateToolSnapshot);
  const refreshAddress = cleanText(realEstateToolSnapshot?.situs_street || realEstateToolSnapshot?.address, null);
  const refreshCity = cleanText(realEstateToolSnapshot?.situs_city || realEstateToolSnapshot?.city, null);
  const refreshState = cleanText(realEstateToolSnapshot?.state, null);
  const refreshZip = cleanZip(realEstateToolSnapshot?.situs_zip || realEstateToolSnapshot?.zip);
  const refreshType = normalizeRealEstateToolType(realEstateToolSnapshot?.property_type || realEstateToolSnapshot?.batch_type);
  const refreshSqFeet = toNullableNumber(realEstateToolSnapshot?.sq_feet);
  const refreshAssessedValue = toNullableNumber(realEstateToolSnapshot?.assessed_value);
  const refreshOwnerName = cleanText(realEstateToolSnapshot?.owner_first_name || realEstateToolSnapshot?.owner_name, null);
  const refreshTrusteeName = cleanText(realEstateToolSnapshot?.trustee_name, null);
  const refreshTrusteePhone = cleanText(realEstateToolSnapshot?.trustee_phone, null);
  const refreshRealEstateToolId = toNullableNumber(realEstateToolSnapshot?.realestatetool_id || realEstateToolSnapshot?.id);

  const result = await query(
    `
      UPDATE properties
      SET
        address = COALESCE(address, $2),
        city = COALESCE(city, $3),
        state = COALESCE(state, $4),
        zip = COALESCE(zip, $5),
        property_type = COALESCE(NULLIF(property_type, ''), $6, property_type),
        sq_feet = COALESCE(sq_feet, $7),
        assessed_value = COALESCE(assessed_value, $8),
        owner_name = COALESCE(owner_name, $9),
        trustee_name = COALESCE(trustee_name, $10),
        trustee_phone = COALESCE(trustee_phone, $11),
        realestatetool_id = COALESCE(realestatetool_id, $12),
        foreclosure = CASE WHEN $13 THEN TRUE ELSE foreclosure END,
        default_date = CASE
          WHEN $13 = TRUE AND default_date IS NULL AND $14 IS NOT NULL THEN $14::date
          ELSE default_date
        END,
        metadata = $15::jsonb,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [
      property.id,
      refreshAddress,
      refreshCity,
      refreshState,
      refreshZip,
      refreshType,
      refreshSqFeet,
      refreshAssessedValue,
      refreshOwnerName,
      refreshTrusteeName,
      refreshTrusteePhone,
      refreshRealEstateToolId,
      alert.foreclosure_related,
      occursOn,
      JSON.stringify(metadata)
    ]
  );

  return result.rows[0] || property;
}

async function syncSellerProfileFromAlert(property, alert, messageMeta) {
  if (!property?.id || !alert.foreclosure_related) {
    return null;
  }

  const current = await getSellerProfileByProperty(property.id);
  const assessment = getDistressAssessment(property, {});
  const updates = {
    motivation: 'foreclosure',
    foreclosure_stage: alert.normalized_change_type,
    distress_level: assessment.score,
    timeline: deriveTimeline(alert.normalized_change_type),
    lender_status: 'pursuing_foreclosure',
    ai_reasoning: `PropertyRadar alert recorded from email on ${messageMeta.occurred_at || new Date().toISOString()}: ${alert.what_changed}`
  };

  if (current) {
    return updateSellerProfile(current.id, updates);
  }

  return createSellerProfile({
    property_id: property.id,
    entity_id: property.owner_entity_id || null,
    source: 'propertyradar_email',
    status: 'monitoring',
    ...updates
  });
}

function buildKnowledgeContent(alert, messageMeta, property, realEstateToolSnapshot) {
  const lines = [
    `PropertyRadar alert "${alert.alert_name || 'Daily Digest Alert'}" reported ${alert.what_changed}.`,
    cleanText(alert.street, null) ? `Street: ${alert.street}` : null,
    cleanText(alert.city, null) ? `City: ${alert.city}` : null,
    cleanText(alert.state, null) ? `State: ${alert.state}` : null,
    cleanText(alert.zip, null) ? `ZIP: ${alert.zip}` : null,
    cleanText(alert.radar_id, null) ? `Radar ID: ${alert.radar_id}` : null,
    cleanText(alert.property_type, null) ? `Property type: ${alert.property_type}` : null,
    alert.sq_feet != null ? `Sq Ft: ${alert.sq_feet}` : null,
    alert.est_value != null ? `Estimated value: ${alert.est_value}` : null,
    property?.apn ? `Matched APN: ${property.apn}` : null,
    property?.address ? `Matched property: ${property.address}` : null,
    realEstateToolSnapshot ? 'RealEstateTool refresh: snapshot captured' : 'RealEstateTool refresh: unavailable',
    messageMeta.subject ? `Email subject: ${messageMeta.subject}` : null,
    messageMeta.from ? `Email from: ${messageMeta.from}` : null
  ].filter(Boolean);

  return lines.join('\n');
}

function buildAlertOutcomeSnapshot({ alert, property = null, sellerProfile = null, refreshed = false }) {
  const assessedValue = toNullableNumber(property?.assessed_value ?? alert?.est_value);
  const distressLevel =
    sellerProfile?.distress_level ??
    (property ? getDistressAssessment(property, {}).score : null);

  return {
    radar_id: alert.radar_id || null,
    street: alert.street || null,
    city: alert.city || null,
    state: alert.state || null,
    zip: alert.zip || null,
    what_changed: alert.what_changed,
    normalized_change_type: alert.normalized_change_type,
    foreclosure_related: Boolean(alert.foreclosure_related),
    matched_property_id: property?.id || null,
    matched_property_address: property?.address || null,
    property_apn: property?.apn || null,
    owner_name: property?.owner_name || null,
    trustee_name: property?.trustee_name || null,
    assessed_value: assessedValue,
    distress_level: distressLevel,
    timeline: deriveTimeline(alert.normalized_change_type),
    refreshed_with_realestatetool: Boolean(refreshed)
  };
}

async function maybeStoreKnowledgeEmbedding(knowledgeEntryId, content, metadata) {
  try {
    const chroma = await storeEmbedding(knowledgeEntryId, content, metadata);
    await query(
      `
        UPDATE knowledge_entries
        SET chroma_id = $2,
            embedding_ref = $2,
            updated_at = NOW()
        WHERE id = $1
      `,
      [knowledgeEntryId, chroma.chroma_id]
    );
  } catch (_error) {
    // Keep imports usable when Chroma is unavailable.
  }
}

async function reserveAlertEvent({ alert, messageMeta, property }) {
  const result = await query(
    `
      INSERT INTO property_alert_events (
        id,
        property_id,
        property_group_id,
        external_source,
        source_message_id,
        source_thread_id,
        raw_email_subject,
        alert_name,
        radar_id,
        street,
        city,
        zip,
        state,
        property_type,
        sq_feet,
        beds,
        baths,
        est_value,
        change_summary,
        normalized_change_type,
        occurred_at,
        raw_payload
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20, $21, $22::jsonb
      )
      ON CONFLICT DO NOTHING
      RETURNING *
    `,
    [
      uuidv4(),
      property?.id || null,
      property?.property_group_id || null,
      'propertyradar',
      messageMeta.message_id || messageMeta.id || null,
      messageMeta.thread_id || null,
      messageMeta.subject || null,
      alert.alert_name || null,
      alert.radar_id || null,
      alert.street || null,
      alert.city || null,
      alert.zip || null,
      alert.state || null,
      alert.property_type || null,
      alert.sq_feet,
      alert.beds,
      alert.baths,
      alert.est_value,
      alert.what_changed,
      alert.normalized_change_type || null,
      messageMeta.occurred_at || null,
      JSON.stringify({ alert, message: messageMeta })
    ]
  );

  return result.rows[0] || null;
}

async function recordPropertyRadarAlert({ alert, messageMeta, dryRun = false, refreshWithRealEstateTool = true }) {
  const property = await findMatchingPropertyForAlert(alert);
  const currentSellerProfile = property?.id ? await getSellerProfileByProperty(property.id) : null;
  const realEstateToolSnapshot = property && refreshWithRealEstateTool
    ? await maybeRefreshRealEstateToolSnapshot(property)
    : null;
  const initialSnapshot = buildAlertOutcomeSnapshot({
    alert,
    property,
    sellerProfile: currentSellerProfile,
    refreshed: Boolean(realEstateToolSnapshot)
  });

  if (dryRun) {
    return {
      status: 'preview',
      ...initialSnapshot
    };
  }

  const reserved = await reserveAlertEvent({ alert, messageMeta, property });

  if (!reserved) {
    return {
      status: 'duplicate',
      ...initialSnapshot
    };
  }

  const nextProperty = property
    ? await updatePropertyFromAlert(property, alert, messageMeta, realEstateToolSnapshot)
    : null;
  const sellerProfile = nextProperty
    ? await syncSellerProfileFromAlert(nextProperty, alert, messageMeta)
    : null;
  const content = buildKnowledgeContent(alert, messageMeta, nextProperty, realEstateToolSnapshot);
  const entityIds = [
    nextProperty?.owner_entity_id,
    nextProperty?.trustee_entity_id,
    nextProperty?.lender_entity_id
  ].filter(Boolean);
  const propertyIds = nextProperty?.id ? [nextProperty.id] : [];
  const knowledgeEntry = await createKnowledgeEntry({
    entry_type: 'email',
    title: `PropertyRadar alert: ${alert.what_changed}${nextProperty?.address ? ` - ${nextProperty.address}` : ''}`,
    content,
    summary: `${alert.what_changed} for ${alert.street || nextProperty?.address || alert.radar_id || 'property alert'}`,
    source: 'email',
    property_id: nextProperty?.id || null,
    entity_id: nextProperty?.owner_entity_id || nextProperty?.trustee_entity_id || nextProperty?.lender_entity_id || null,
    occurred_at: messageMeta.occurred_at || null,
    metadata: {
      provider: 'gmail',
      external_source: 'propertyradar',
      subject: messageMeta.subject || null,
      from: messageMeta.from || null,
      gmail_message_id: messageMeta.id || null,
      gmail_thread_id: messageMeta.thread_id || null,
      source_message_id: messageMeta.message_id || null,
      alert_name: alert.alert_name || null,
      radar_id: alert.radar_id || null,
      what_changed: alert.what_changed,
      normalized_change_type: alert.normalized_change_type,
      realestatetool_snapshot: realEstateToolSnapshot || null
    },
    ai_summary: `${alert.what_changed} recorded from PropertyRadar for ${alert.street || nextProperty?.address || 'matched property'}`,
    ai_tags: ['propertyradar', 'email', 'alert', alert.normalized_change_type, alert.city].filter(Boolean),
    ai_classifications: ['property_note', 'deal_update'],
    entity_ids: entityIds,
    property_ids: propertyIds
  });

  await maybeStoreKnowledgeEmbedding(knowledgeEntry.id, content, {
    entity_ids: entityIds,
    property_ids: propertyIds,
    source: 'email',
    classifications: ['property_note', 'deal_update']
  });

  await query(
    `
      UPDATE property_alert_events
      SET property_id = COALESCE(property_id, $2),
          property_group_id = COALESCE(property_group_id, $3),
          seller_profile_id = $4,
          knowledge_entry_id = $5,
          updated_at = NOW()
      WHERE id = $1
    `,
    [
      reserved.id,
      nextProperty?.id || null,
      nextProperty?.property_group_id || null,
      sellerProfile?.id || null,
      knowledgeEntry.id
    ]
  );

  return {
    status: 'recorded',
    event_id: reserved.id,
    knowledge_entry_id: knowledgeEntry.id,
    seller_profile_id: sellerProfile?.id || null,
    ...buildAlertOutcomeSnapshot({
      alert,
      property: nextProperty,
      sellerProfile,
      refreshed: Boolean(realEstateToolSnapshot)
    })
  };
}

async function getMessageList({ queryText, maxResults }) {
  const messages = [];
  let pageToken = null;

  while (messages.length < maxResults) {
    const page = await listMessages({
      q: queryText,
      maxResults: Math.min(100, maxResults - messages.length),
      pageToken
    });

    if (Array.isArray(page.messages)) {
      messages.push(...page.messages);
    }

    if (!page.nextPageToken || !Array.isArray(page.messages) || page.messages.length === 0) {
      break;
    }

    pageToken = page.nextPageToken;
  }

  return messages.slice(0, maxResults);
}

async function importPropertyRadarAlerts({
  query: queryText = process.env.GMAIL_PROPERTYRADAR_QUERY || '"Daily Digest Alert:"',
  maxResults = Number(process.env.GMAIL_PROPERTYRADAR_MAX_RESULTS || 25),
  dryRun = false,
  refreshWithRealEstateTool = true,
  messageId = null,
  skipMessageIds = []
} = {}) {
  const resolvedQuery = cleanText(queryText, process.env.GMAIL_PROPERTYRADAR_QUERY || '"Daily Digest Alert:"');
  const resolvedMaxResults = Math.max(1, Number(maxResults) || Number(process.env.GMAIL_PROPERTYRADAR_MAX_RESULTS || 25) || 25);
  const rawSummaries = messageId
    ? [{ id: messageId }]
    : await getMessageList({
        queryText: resolvedQuery,
        maxResults: resolvedMaxResults
      });
  const skipMessageIdSet = new Set(
    Array.isArray(skipMessageIds)
      ? skipMessageIds.map((value) => cleanText(value, null)).filter(Boolean)
      : []
  );
  const summaries = rawSummaries.filter((summary) => !skipMessageIdSet.has(cleanText(summary?.id, null)));
  const results = [];
  const processedMessageIds = [];
  let messagesProcessed = 0;
  let messagesSkipped = rawSummaries.length - summaries.length;
  let alertsParsed = 0;
  let recorded = 0;
  let duplicates = 0;
  let previews = 0;
  let matchedProperties = 0;
  let refreshedWithRealEstateToolCount = 0;
  const errors = [];

  for (const summary of summaries) {
    try {
      const message = await getMessage(summary.id, { format: 'full' });
      const messageMeta = getMessageMeta(message);
      const bodies = getMessageBodies(message);
      const parsed = parsePropertyRadarDigest({
        subject: messageMeta.subject,
        text: bodies.text,
        html: bodies.html
      });

      messagesProcessed += 1;
      processedMessageIds.push(messageMeta.id || summary.id);

      if (parsed.rows.length === 0) {
        results.push({
          message_id: messageMeta.id,
          status: 'skipped',
          reason: 'no_propertyradar_rows_found'
        });
        continue;
      }

      alertsParsed += parsed.rows.length;

      for (const alert of parsed.rows) {
        const outcome = await recordPropertyRadarAlert({
          alert,
          messageMeta,
          dryRun,
          refreshWithRealEstateTool
        });

        if (outcome.status === 'recorded') {
          recorded += 1;
        } else if (outcome.status === 'duplicate') {
          duplicates += 1;
        } else if (outcome.status === 'preview') {
          previews += 1;
        }

        if (outcome.matched_property_id) {
          matchedProperties += 1;
        }

        if (outcome.refreshed_with_realestatetool) {
          refreshedWithRealEstateToolCount += 1;
        }

        results.push({
          message_id: messageMeta.id,
          subject: messageMeta.subject,
          alert_name: alert.alert_name,
          radar_id: alert.radar_id,
          what_changed: alert.what_changed,
          ...outcome
        });
      }
    } catch (error) {
      errors.push({
        message_id: summary.id,
        error: error.message
      });
    }
  }

  return {
    query: resolvedQuery,
    dry_run: dryRun,
    messages_processed: messagesProcessed,
    messages_skipped: messagesSkipped,
    processed_message_ids: processedMessageIds,
    alerts_parsed: alertsParsed,
    recorded,
    duplicates,
    previews,
    matched_properties: matchedProperties,
    refreshed_with_realestatetool: refreshedWithRealEstateToolCount,
    errors,
    results
  };
}

module.exports = {
  extractAlertName,
  normalizePropertyRadarChange,
  parsePropertyRadarDigestHtml,
  parsePropertyRadarDigestText,
  parsePropertyRadarDigest,
  importPropertyRadarAlerts
};
