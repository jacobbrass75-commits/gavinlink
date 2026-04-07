const { v4: uuidv4 } = require('uuid');
const { query } = require('../db/connection');

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parseDateValue(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('purchase_date is required');
  }

  const trimmed = value.trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  const parsed = new Date(trimmed);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error('purchase_date must be a valid ISO date string');
  }

  return parsed.toISOString().slice(0, 10);
}

async function ensureBuyerProfile(buyerProfileId) {
  const result = await query(
    `
      SELECT id
      FROM buyer_profiles
      WHERE id = $1
    `,
    [buyerProfileId]
  );

  if (!result.rows[0]) {
    throw createHttpError('Buyer profile not found', 404);
  }
}

async function recordPurchase(data) {
  if (!data?.buyer_profile_id) {
    throw new Error('buyer_profile_id is required');
  }

  await ensureBuyerProfile(data.buyer_profile_id);

  const purchasePrice = Number(data.purchase_price);

  if (!Number.isFinite(purchasePrice) || purchasePrice < 0) {
    throw new Error('purchase_price must be a non-negative number');
  }

  const result = await query(
    `
      INSERT INTO buyer_purchases (
        id,
        buyer_profile_id,
        property_id,
        purchase_price,
        purchase_date,
        deal_type,
        notes
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, buyer_profile_id, property_id, purchase_price, purchase_date, deal_type, notes, created_at
    `,
    [
      uuidv4(),
      data.buyer_profile_id,
      data.property_id || null,
      purchasePrice,
      parseDateValue(data.purchase_date),
      data.deal_type || 'purchase',
      typeof data.notes === 'string' && data.notes.trim() !== '' ? data.notes.trim() : null
    ]
  );

  const row = result.rows[0];

  return {
    id: row.id,
    buyer_profile_id: row.buyer_profile_id,
    property_id: row.property_id,
    purchase_price: Number(row.purchase_price),
    purchase_date: row.purchase_date,
    deal_type: row.deal_type,
    notes: row.notes,
    created_at: row.created_at
  };
}

async function getPurchaseHistory(buyerProfileId) {
  await ensureBuyerProfile(buyerProfileId);

  const result = await query(
    `
      SELECT
        bp.id,
        bp.buyer_profile_id,
        bp.property_id,
        bp.purchase_price,
        bp.purchase_date,
        bp.deal_type,
        bp.notes,
        bp.created_at,
        p.apn,
        p.address,
        p.city,
        p.property_type
      FROM buyer_purchases bp
      LEFT JOIN properties p ON p.id = bp.property_id
      WHERE bp.buyer_profile_id = $1
      ORDER BY bp.purchase_date DESC, bp.created_at DESC
    `,
    [buyerProfileId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    buyer_profile_id: row.buyer_profile_id,
    property_id: row.property_id,
    purchase_price: Number(row.purchase_price),
    purchase_date: row.purchase_date,
    deal_type: row.deal_type,
    notes: row.notes,
    created_at: row.created_at,
    property: row.property_id
      ? {
          id: row.property_id,
          apn: row.apn,
          address: row.address,
          city: row.city,
          property_type: row.property_type
        }
      : null
  }));
}

async function getBuyerStats(buyerProfileId) {
  await ensureBuyerProfile(buyerProfileId);

  const aggregatesResult = await query(
    `
      SELECT
        COUNT(*)::int AS total_purchases,
        COALESCE(SUM(purchase_price), 0) AS total_volume,
        MAX(purchase_date) AS last_purchase_date,
        COALESCE(AVG(purchase_price), 0) AS avg_purchase_price
      FROM buyer_purchases
      WHERE buyer_profile_id = $1
    `,
    [buyerProfileId]
  );
  const preferenceResult = await query(
    `
      WITH ranked_types AS (
        SELECT p.property_type, COUNT(*)::int AS frequency
        FROM buyer_purchases bp
        JOIN properties p ON p.id = bp.property_id
        WHERE bp.buyer_profile_id = $1
          AND p.property_type IS NOT NULL
        GROUP BY p.property_type
        ORDER BY frequency DESC, p.property_type ASC
        LIMIT 1
      ),
      ranked_cities AS (
        SELECT p.city, COUNT(*)::int AS frequency
        FROM buyer_purchases bp
        JOIN properties p ON p.id = bp.property_id
        WHERE bp.buyer_profile_id = $1
          AND p.city IS NOT NULL
        GROUP BY p.city
        ORDER BY frequency DESC, p.city ASC
        LIMIT 1
      )
      SELECT
        (SELECT property_type FROM ranked_types) AS preferred_property_type,
        (SELECT city FROM ranked_cities) AS preferred_city
    `,
    [buyerProfileId]
  );
  const aggregates = aggregatesResult.rows[0];
  const preferences = preferenceResult.rows[0];

  return {
    total_purchases: aggregates.total_purchases,
    total_volume: Number(aggregates.total_volume || 0),
    last_purchase_date: aggregates.last_purchase_date,
    avg_purchase_price: Number(aggregates.avg_purchase_price || 0),
    preferred_property_type: preferences.preferred_property_type || null,
    preferred_city: preferences.preferred_city || null
  };
}

module.exports = {
  recordPurchase,
  getPurchaseHistory,
  getBuyerStats
};
