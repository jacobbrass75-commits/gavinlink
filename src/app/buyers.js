const buyerProfiles = require('../buyers/profiles');
const buyerActivity = require('../buyers/activity');
const lenderReport = require('../buyers/lender-report');

async function searchBuyerProfiles(query) {
  return buyerProfiles.searchBuyerProfiles(query);
}

async function recordBuyerPurchase(buyerProfileId, payload = {}) {
  return buyerActivity.recordPurchase({
    ...payload,
    buyer_profile_id: buyerProfileId
  });
}

async function getBuyerPurchaseHistory(buyerProfileId) {
  return buyerActivity.getPurchaseHistory(buyerProfileId);
}

async function getBuyerStats(buyerProfileId) {
  return buyerActivity.getBuyerStats(buyerProfileId);
}

async function getBuyerProfileById(buyerProfileId) {
  return buyerProfiles.getBuyerProfile(buyerProfileId);
}

async function createBuyerProfile(payload = {}) {
  return buyerProfiles.createBuyerProfile(payload);
}

async function listBuyerProfiles(filters = {}) {
  return buyerProfiles.listBuyerProfiles(filters);
}

async function updateBuyerProfile(buyerProfileId, payload = {}) {
  return buyerProfiles.updateBuyerProfile(buyerProfileId, payload);
}

async function deactivateBuyerProfile(buyerProfileId) {
  return buyerProfiles.deactivateBuyerProfile(buyerProfileId);
}

async function getLenderReport() {
  return lenderReport.getLenderReport();
}

async function getLenderDetail(lenderEntityId) {
  return lenderReport.getLenderDetail(lenderEntityId);
}

async function getLenderOwnerOverlaps() {
  return lenderReport.getLenderOwnerOverlaps();
}

module.exports = {
  searchBuyerProfiles,
  recordBuyerPurchase,
  getBuyerPurchaseHistory,
  getBuyerStats,
  getBuyerProfileById,
  createBuyerProfile,
  listBuyerProfiles,
  updateBuyerProfile,
  deactivateBuyerProfile,
  getLenderReport,
  getLenderDetail,
  getLenderOwnerOverlaps
};
