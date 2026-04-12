const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPropertyRadarFeedSummary
} = require('../../src/ops/propertyradar-feed');

test('buildPropertyRadarFeedSummary includes run counts and error preview', () => {
  const summary = buildPropertyRadarFeedSummary({
    runNumber: 2,
    dryRun: true,
    query: 'from:no-reply@propertyradar.info subject:"Daily Digest Alert:"',
    maxResults: 10,
    intervalMs: 300000,
    loop: true,
    result: {
      messages_processed: 4,
      alerts_parsed: 6,
      recorded: 3,
      duplicates: 2,
      previews: 1,
      matched_properties: 2,
      refreshed_with_realestatetool: 1,
      errors: [
        { message: 'first failure' },
        { message: 'second failure' }
      ]
    }
  });

  assert.match(summary, /PropertyRadar feed run #2 \(dry run\)/);
  assert.match(summary, /Messages: 4 \| Alerts: 6/);
  assert.match(summary, /Recorded: 3 \| Duplicates: 2 \| Previews: 1/);
  assert.match(summary, /Matched properties: 2 \| Refreshed: 1/);
  assert.match(summary, /Query: from:no-reply@propertyradar.info subject:"Daily Digest Alert:"/);
  assert.match(summary, /Max results: 10/);
  assert.match(summary, /Loop interval: 300000ms/);
  assert.match(summary, /Errors: 2/);
  assert.match(summary, /Error preview: first failure \| second failure/);
});
