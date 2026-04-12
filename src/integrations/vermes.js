const {
  normalizeVermesPayload,
  normalizeWebhookPayload
} = require('../app/channels');

module.exports = {
  normalizeVermesPayload,
  normalizeVermesWebhookPayload: normalizeVermesPayload,
  normalizeWebhookPayload
};
