const sellerProfiles = require('../sellers/profiles');
const distressScore = require('../sellers/distress-score');
const motivation = require('../sellers/motivation');
const portfolioDistress = require('../sellers/portfolio-distress');

async function searchSellerProfiles(query) {
  return sellerProfiles.searchSellerProfiles(query);
}

async function getSellerProfileById(sellerProfileId) {
  return sellerProfiles.getSellerProfile(sellerProfileId);
}

async function getSellerProfileByProperty(propertyId) {
  return sellerProfiles.getSellerProfileByProperty(propertyId);
}

async function listSellerProfiles(filters = {}) {
  return sellerProfiles.listSellerProfiles(filters);
}

async function updateSellerProfile(sellerProfileId, payload = {}) {
  return sellerProfiles.updateSellerProfile(sellerProfileId, payload);
}

async function autoGenerateSellerProfiles() {
  return sellerProfiles.autoGenerateSellerProfiles();
}

async function getSellerDistribution() {
  return sellerProfiles.getSellerDistribution();
}

async function scoreSellerProperties(options = {}) {
  return distressScore.batchScoreProperties(options);
}

async function inferSellerMotivation(options = {}) {
  return motivation.batchInferMotivation(options);
}

async function getPortfolioDistress() {
  return portfolioDistress.findPortfolioDistress();
}

async function getLenderOwnerPatterns() {
  return portfolioDistress.findLenderOwnerPatterns();
}

module.exports = {
  searchSellerProfiles,
  getSellerProfileById,
  getSellerProfileByProperty,
  listSellerProfiles,
  updateSellerProfile,
  autoGenerateSellerProfiles,
  getSellerDistribution,
  scoreSellerProperties,
  inferSellerMotivation,
  getPortfolioDistress,
  getLenderOwnerPatterns
};
