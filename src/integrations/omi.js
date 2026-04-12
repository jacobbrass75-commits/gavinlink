const {
  normalizeOmiPayload,
  normalizeWebhookPayload
} = require('../app/channels');

module.exports = {
  normalizeOmiPayload,
  normalizeOmiWebhookPayload: normalizeOmiPayload,
  normalizeWebhookPayload
};
