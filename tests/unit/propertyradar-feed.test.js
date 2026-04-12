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
      messages_skipped: 3,
      alerts_parsed: 6,
      recorded: 3,
      duplicates: 2,
      previews: 1,
      matched_properties: 2,
      refreshed_with_realestatetool: 1,
      results: [
        {
          status: 'recorded',
          what_changed: 'New Notice of Default',
          normalized_change_type: 'notice_of_default',
          matched_property_address: '5414 E Floral Ave',
          city: 'SELMA',
          state: 'CA',
          timeline: '60_days',
          distress_level: 4,
          property_apn: '123-456-789',
          owner_name: 'Ken Kahan',
          broker_summary:
            'New Notice of Default; at 5414 E Floral Ave, SELMA, CA; APN 123-456-789; owner Ken Kahan; distress 4/5; 60-day timeline; matched in Soleil'
        },
        {
          status: 'preview',
          what_changed: 'Auction Pending',
          normalized_change_type: 'auction_pending',
          street: '8122 Maie Ave',
          city: 'LOS ANGELES',
          state: 'CA',
          timeline: 'urgent',
          distress_level: 5,
          broker_summary:
            'Auction Pending; at 8122 Maie Ave, LOS ANGELES, CA; distress 5/5; urgent timeline; unmatched in Soleil'
        }
      ],
      errors: [
        { message: 'first failure' },
        { message: 'second failure' }
      ]
    }
  });

  assert.match(summary, /PropertyRadar feed run #2 \(dry run\)/);
  assert.match(summary, /Messages: 4 processed \| 3 skipped \| Alerts: 6/);
  assert.match(summary, /Recorded: 3 \| Duplicates: 2 \| Previews: 1/);
  assert.match(summary, /Matched properties: 2 \| Refreshed: 1/);
  assert.match(summary, /Query: from:no-reply@propertyradar.info subject:"Daily Digest Alert:"/);
  assert.match(summary, /Max results: 10/);
  assert.match(summary, /Loop interval: 300000ms/);
  assert.match(summary, /Errors: 2/);
  assert.match(summary, /Alert mix: Auction Pending 1 \| Notice Of Default 1/);
  assert.match(summary, /Broker priorities:/);
  assert.match(summary, /New Notice of Default; at 5414 E Floral Ave, SELMA, CA/);
  assert.match(summary, /Needs matching:/);
  assert.match(summary, /\[preview\] Auction Pending; at 8122 Maie Ave, LOS ANGELES, CA/);
  assert.match(summary, /Error preview: first failure \| second failure/);
});
