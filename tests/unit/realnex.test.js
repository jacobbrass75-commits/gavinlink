const test = require('node:test');
const assert = require('node:assert/strict');

const { createRealNexClient } = require('../../src/integrations/realnex');
const {
  createRealNexService,
  disambiguateRealNexRecords,
  scoreCandidate
} = require('../../src/app/realnex');

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    }
  };
}

test('createRealNexClient clamps OData page size and sends bearer auth', async () => {
  const calls = [];
  const client = createRealNexClient({
    token: 'test-token',
    baseUrl: 'https://sync.realnex.com/',
    pageSize: 100,
    timeoutMs: 2500,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        value: [{ Key: 'contact-1', FullName: 'Mike Chen' }],
        '@odata.count': 1
      });
    }
  });

  const result = await client.listContacts({ top: 100, skip: 12, count: true });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://sync.realnex.com/api/v1/CrmOData/Contacts?%24top=50&%24skip=12&%24count=true'
  );
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-token');
  assert.equal(calls[0].options.headers.accept, 'application/json');
  assert.ok(calls[0].options.signal);
  assert.equal(result.value[0].Key, 'contact-1');
});

test('createRealNexClient encodes keys for get methods', async () => {
  const calls = [];
  const client = createRealNexClient({
    token: 'test-token',
    baseUrl: 'https://sync.realnex.com',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ ok: true });
    }
  });

  await client.getContact('AB/CD 12');
  await client.getProperty('PA 123-456');
  await client.getCompany('Pacific Industrial Group');

  assert.deepEqual(calls.map((call) => call.url), [
    'https://sync.realnex.com/api/v1/Crm/contact/AB%2FCD%2012',
    'https://sync.realnex.com/api/v1/Crm/property/PA%20123-456',
    'https://sync.realnex.com/api/v1/Crm/company/Pacific%20Industrial%20Group'
  ]);
});

test('scoreCandidate prefers exact contact matches over fuzzy company matches', () => {
  const exactContact = scoreCandidate(
    {
      name: 'Mike Chen',
      email: 'mchen@pacificindustrial.com',
      phone: '(555) 111-2222',
      company: 'Pacific Industrial'
    },
    {
      Key: 'contact-1',
      FullName: 'Mike Chen',
      Email: 'mchen@pacificindustrial.com',
      Mobile: '5551112222',
      CompanyName: 'Pacific Industrial Group'
    }
  );
  const fuzzyCompany = scoreCandidate(
    {
      name: 'Mike Chen',
      email: 'mchen@pacificindustrial.com',
      phone: '(555) 111-2222',
      company: 'Pacific Industrial'
    },
    {
      Key: 'company-1',
      Name: 'Pacific Industrial Group',
      Email: 'info@pacificindustrial.com'
    }
  );

  assert.ok(exactContact.score > fuzzyCompany.score);
  assert.match(exactContact.reasons.join(' '), /name:exact/);
  assert.match(exactContact.reasons.join(' '), /email:exact_email/);
  assert.match(exactContact.reasons.join(' '), /phone:exact_phone/);
});

test('disambiguateRealNexRecords ranks the best match first and stays bounded', async () => {
  const service = createRealNexService({
    client: {
      config: { pageSize: 50 },
      async listContacts({ top, skip }) {
        assert.ok(top <= 2);
        assert.ok(skip >= 0);
        return {
          value: skip === 0
            ? [
                {
                  Key: 'contact-1',
                  FullName: 'Mike Chen',
                  Email: 'mchen@pacificindustrial.com',
                  Mobile: '5551112222',
                  CompanyName: 'Pacific Industrial Group'
                }
              ]
            : []
        };
      },
      async listCompanies({ top, skip }) {
        assert.ok(top <= 2);
        assert.ok(skip >= 0);
        return {
          value: skip === 0
            ? [
                {
                  Key: 'company-1',
                  Name: 'Pacific Industrial Group',
                  Email: 'info@pacificindustrial.com'
                }
              ]
            : []
        };
      },
      async getContact() {
        throw new Error('unused');
      },
      async getProperty() {
        throw new Error('unused');
      },
      async getCompany() {
        throw new Error('unused');
      }
    }
  });

  const result = await service.disambiguate(
    {
      name: 'Mike Chen',
      email: 'mchen@pacificindustrial.com',
      phone: '5551112222',
      company: 'Pacific Industrial'
    },
    {
      contactLimit: 2,
      companyLimit: 2,
      limit: 2,
      pageSize: 2
    }
  );

  assert.equal(result.best_match.id, 'contact-1');
  assert.equal(result.matches.length, 2);
  assert.equal(result.contacts.length, 1);
  assert.equal(result.companies.length, 1);
  assert.ok(result.best_match.score >= result.matches[1].score);
});
