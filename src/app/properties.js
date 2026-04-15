const { query } = require('../db/connection');
const propertyGrouping = require('../properties/grouping');
const propertyDocuments = require('../properties/documents');

function createAppError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function getPropertyDetail(propertyId) {
  const result = await query(
    `
      SELECT
        p.*,
        owner.name AS owner_entity_name,
        trustee.name AS trustee_entity_name,
        lender.name AS lender_entity_name
      FROM properties p
      LEFT JOIN entities owner ON owner.id = p.owner_entity_id
      LEFT JOIN entities trustee ON trustee.id = p.trustee_entity_id
      LEFT JOIN entities lender ON lender.id = p.lender_entity_id
      WHERE p.id = $1
    `,
    [propertyId]
  );
  const property = result.rows[0];

  if (!property) {
    throw createAppError(404, 'Property not found');
  }

  const documents = await propertyDocuments.listPropertyDocuments(propertyId);

  return {
    ...property,
    assessed_value: toNumber(property.assessed_value),
    sq_feet: toNumber(property.sq_feet),
    lot_size: toNumber(property.lot_size),
    owner_entity_name: property.owner_entity_name || null,
    trustee_entity_name: property.trustee_entity_name || null,
    lender_entity_name: property.lender_entity_name || null,
    documents
  };
}

async function getPropertyGroupForProperty(propertyId) {
  const group = await propertyGrouping.getPropertyGroupForProperty(propertyId);

  if (!group) {
    throw createAppError(404, 'Property group not found');
  }

  return group;
}

async function getPropertyGroup(propertyGroupId) {
  const group = await propertyGrouping.getPropertyGroup(propertyGroupId);

  if (!group) {
    throw createAppError(404, 'Property group not found');
  }

  return group;
}

async function listPropertyDocuments(propertyId) {
  return propertyDocuments.listPropertyDocuments(propertyId);
}

async function attachPropertyDocument(payload) {
  return propertyDocuments.attachPropertyDocument(payload);
}

module.exports = {
  getPropertyDetail,
  getPropertyGroupForProperty,
  getPropertyGroup,
  listPropertyDocuments,
  attachPropertyDocument
};
