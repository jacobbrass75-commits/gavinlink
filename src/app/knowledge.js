const knowledgeExtract = require('../knowledge/extract');

async function listKnowledgeEntries(filters = {}) {
  return knowledgeExtract.listKnowledgeEntries(filters);
}

async function getKnowledgeEntryById(knowledgeEntryId) {
  return knowledgeExtract.getKnowledgeEntry(knowledgeEntryId);
}

async function deleteKnowledgeEntryById(knowledgeEntryId) {
  return knowledgeExtract.deleteKnowledgeEntry(knowledgeEntryId);
}

module.exports = {
  listKnowledgeEntries,
  getKnowledgeEntryById,
  deleteKnowledgeEntryById
};
