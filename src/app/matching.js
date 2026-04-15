const matchingRunner = require('../matching/runner');

async function runFullMatching(options = {}) {
  return matchingRunner.runFullMatching(options);
}

async function runMatchingForBuyer(buyerProfileId, options = {}) {
  return matchingRunner.runMatchingForBuyer(buyerProfileId, options);
}

async function runMatchingForProperty(propertyId, options = {}) {
  return matchingRunner.runMatchingForProperty(propertyId, options);
}

async function getMatchDistribution() {
  return matchingRunner.getMatchDistribution();
}

async function listMatches(filters = {}) {
  return matchingRunner.listMatches(filters);
}

async function getMatchById(matchId) {
  return matchingRunner.getMatch(matchId);
}

async function getTopMatches(options = {}) {
  return matchingRunner.getTopMatches(options);
}

async function updateMatchStatus(matchId, status) {
  return matchingRunner.updateMatchStatus(matchId, status);
}

async function generateNarrativeForMatch(matchId) {
  return matchingRunner.generateNarrativeForMatch(matchId);
}

module.exports = {
  runFullMatching,
  runMatchingForBuyer,
  runMatchingForProperty,
  getMatchDistribution,
  listMatches,
  getMatchById,
  getTopMatches,
  updateMatchStatus,
  generateNarrativeForMatch
};
