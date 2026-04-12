const {
  normalizeHermesPayload,
  normalizeWebhookPayload
} = require('../app/channels');

module.exports = {
  normalizeHermesPayload,
  normalizeHermesWebhookPayload: normalizeHermesPayload,
  normalizeWebhookPayload
};
