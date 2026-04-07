function escapeLikePattern(value) {
  return String(value || '').replace(/[\\%_]/g, '\\$&');
}

function buildContainsPattern(value) {
  return `%${escapeLikePattern(value)}%`;
}

module.exports = {
  escapeLikePattern,
  buildContainsPattern
};
