const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractAlertName,
  normalizePropertyRadarChange,
  parsePropertyRadarDigest,
  parsePropertyRadarDigestHtml,
  parsePropertyRadarDigestText
} = require('../../src/import-export/propertyradar-alerts');

test('extractAlertName handles forwarded digest subjects', () => {
  assert.equal(
    extractAlertName('FW: Daily Digest Alert: Ken Kahan List'),
    'Ken Kahan List'
  );
});

test('normalizePropertyRadarChange maps notice of default to foreclosure stage', () => {
  assert.deepEqual(
    normalizePropertyRadarChange('New Notice of Default'),
    {
      raw: 'New Notice of Default',
      change_type: 'notice_of_default',
      foreclosure_related: true
    }
  );
});

test('parsePropertyRadarDigestHtml extracts alert rows from table markup', () => {
  const html = `
    <html>
      <body>
        <p>Your daily digest alert, Ken Kahan List, found a match.</p>
        <table>
          <tr>
            <th>Radar ID</th>
            <th>Street</th>
            <th>City</th>
            <th>Zip</th>
            <th>State</th>
            <th>Type</th>
            <th>Sq Ft</th>
            <th>Beds</th>
            <th>Baths</th>
            <th>Est. Value</th>
            <th>What Changed</th>
          </tr>
          <tr>
            <td>P1027C7A</td>
            <td>5414 E FLORAL AVE</td>
            <td>SELMA</td>
            <td>93662</td>
            <td>CA</td>
            <td>IND</td>
            <td>38,944</td>
            <td>6</td>
            <td>1.5</td>
            <td>$1,354,564</td>
            <td>New Notice of Default</td>
          </tr>
        </table>
      </body>
    </html>
  `;

  const rows = parsePropertyRadarDigestHtml(html, { alert_name: 'Ken Kahan List' });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].alert_name, 'Ken Kahan List');
  assert.equal(rows[0].radar_id, 'P1027C7A');
  assert.equal(rows[0].street, '5414 E FLORAL AVE');
  assert.equal(rows[0].city, 'SELMA');
  assert.equal(rows[0].zip, '93662');
  assert.equal(rows[0].normalized_change_type, 'notice_of_default');
  assert.equal(rows[0].foreclosure_related, true);
});

test('parsePropertyRadarDigestText extracts alert rows from plain text digest', () => {
  const text = `
Your daily digest alert, Ken Kahan List, found a match.
Radar ID\tStreet\tCity\tZip\tState\tType\tSq Ft\tBeds\tBaths\tEst. Value\tWhat Changed
P1027C7A\t5414 E FLORAL AVE\tSELMA\t93662\tCA\tIND\t38,944\t6\t1.5\t$1,354,564\tNew Notice of Default
Login to disable this alert
  `;

  const rows = parsePropertyRadarDigestText(text, { alert_name: 'Ken Kahan List' });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].radar_id, 'P1027C7A');
  assert.equal(rows[0].est_value, 1354564);
  assert.equal(rows[0].what_changed, 'New Notice of Default');
});

test('parsePropertyRadarDigestText handles forwarded rows with blank beds and baths', () => {
  const text = `
From: PropertyRadar Alerts <no-reply@propertyradar.info>
Subject: Daily Digest Alert: Ken Kahan List

Radar ID        Street  City    Zip     State   Type    Sq Ft   Beds    Baths   Est. Value      What Changed
P17148D3<https://goradar.it/P17148D3>   23104 AVENUE 198        STRATHMORE      93267   CA      IND     36,548                  $885,517        New Matches
Login to disable this alert<https://app.propertyradar.com>
  `;

  const rows = parsePropertyRadarDigestText(text, { alert_name: 'Ken Kahan List' });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].radar_id, 'P17148D3');
  assert.equal(rows[0].street, '23104 AVENUE 198');
  assert.equal(rows[0].city, 'STRATHMORE');
  assert.equal(rows[0].zip, '93267');
  assert.equal(rows[0].sq_feet, 36548);
  assert.equal(rows[0].beds, null);
  assert.equal(rows[0].baths, null);
  assert.equal(rows[0].est_value, 885517);
  assert.equal(rows[0].what_changed, 'New Matches');
});

test('parsePropertyRadarDigest prefers html and keeps alert name from subject', () => {
  const parsed = parsePropertyRadarDigest({
    subject: 'FW: Daily Digest Alert: Ken Kahan List',
    text: '',
    html: `
      <table>
        <tr>
          <th>Radar ID</th><th>Street</th><th>City</th><th>Zip</th><th>State</th>
          <th>Type</th><th>Sq Ft</th><th>Beds</th><th>Baths</th><th>Est. Value</th><th>What Changed</th>
        </tr>
        <tr>
          <td>P1027C7A</td><td>5414 E FLORAL AVE</td><td>SELMA</td><td>93662</td><td>CA</td>
          <td>IND</td><td>38,944</td><td>6</td><td>1.5</td><td>$1,354,564</td><td>New Notice of Default</td>
        </tr>
      </table>
    `
  });

  assert.equal(parsed.alert_name, 'Ken Kahan List');
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].alert_name, 'Ken Kahan List');
});
