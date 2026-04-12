const { createRealNexClient } = require('../integrations/realnex');
const { lookupLocalEntityForRealNex } = require('./brain');

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function normalizeText(value) {
  return cleanText(value, '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeEmail(value) {
  return cleanText(value, '').toLowerCase();
}

function normalizePhone(value) {
  return cleanText(value, '').replace(/\D+/g, '');
}

function tokenize(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(/\s+/).filter(Boolean) : [];
}

function pickFirstString(values = []) {
  for (const value of values) {
    const text = cleanText(value, null);

    if (text) {
      return text;
    }
  }

  return null;
}

function extractCandidateType(candidate = {}) {
  const rawType = cleanText(candidate.kind ?? candidate.type ?? candidate.entity_type, null);

  if (!rawType) {
    return 'contact';
  }

  const lowered = rawType.toLowerCase();

  if (lowered.includes('company')) {
    return 'company';
  }

  if (lowered.includes('contact') || lowered.includes('person')) {
    return 'contact';
  }

  return lowered;
}

function extractCandidateName(candidate = {}) {
  return pickFirstString([
    candidate.FullName,
    candidate.Name,
    candidate.CompanyName,
    candidate.BusinessName,
    candidate.DisplayName,
    candidate.ContactName,
    candidate.Organization,
    candidate.Full_Name
  ]);
}

function extractCandidateCompany(candidate = {}) {
  return pickFirstString([
    candidate.CompanyName,
    candidate.Company,
    candidate.Organization,
    candidate.Employer,
    candidate.BusinessName,
    candidate.Workplace,
    candidate.AccountName
  ]);
}

function extractCandidateEmail(candidate = {}) {
  return pickFirstString([
    candidate.Email,
    candidate.EmailAddress,
    candidate.WorkEmail,
    candidate.PrimaryEmail,
    candidate.BusinessEmail
  ]);
}

function extractCandidatePhone(candidate = {}) {
  return pickFirstString([
    candidate.Work,
    candidate.Mobile,
    candidate.Home,
    candidate.Phone,
    candidate.Telephone,
    candidate.MainPhone,
    candidate.BusinessPhone,
    candidate.CellPhone,
    candidate.Fax
  ]);
}

function normalizeCandidate(candidate = {}, type = null) {
  return {
    id: cleanText(candidate.Key ?? candidate.key ?? candidate.Id ?? candidate.id, null),
    kind: type || extractCandidateType(candidate),
    name: extractCandidateName(candidate),
    company: extractCandidateCompany(candidate),
    email: extractCandidateEmail(candidate),
    phone: extractCandidatePhone(candidate),
    raw: candidate
  };
}

function normalizeInput(input = {}) {
  return {
    name: cleanText(input.name ?? input.full_name ?? input.fullName, null),
    email: cleanText(input.email ?? input.Email, null),
    phone: cleanText(input.phone ?? input.Phone, null),
    company: cleanText(
      input.company ?? input.company_name ?? input.companyName ?? input.organization,
      null
    )
  };
}

function scoreTextMatch(left, right) {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);

  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return { score: 0, reason: null };
  }

  const leftNormalized = normalizeText(left);
  const rightNormalized = normalizeText(right);

  if (!leftNormalized || !rightNormalized) {
    return { score: 0, reason: null };
  }

  if (leftNormalized === rightNormalized) {
    return { score: 40, reason: 'exact' };
  }

  if (leftNormalized.includes(rightNormalized) || rightNormalized.includes(leftNormalized)) {
    return { score: 28, reason: 'contains' };
  }

  const overlap = new Set(leftTokens.filter((token) => rightTokens.includes(token))).size;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  const ratio = union > 0 ? overlap / union : 0;

  if (ratio >= 0.75) {
    return { score: 24, reason: 'strong_overlap' };
  }

  if (ratio >= 0.5) {
    return { score: 16, reason: 'moderate_overlap' };
  }

  if (ratio > 0) {
    return { score: Math.round(ratio * 12), reason: 'weak_overlap' };
  }

  return { score: 0, reason: null };
}

function scoreEmailMatch(left, right) {
  const leftEmail = normalizeEmail(left);
  const rightEmail = normalizeEmail(right);

  if (!leftEmail || !rightEmail) {
    return { score: 0, reason: null };
  }

  if (leftEmail === rightEmail) {
    return { score: 35, reason: 'exact_email' };
  }

  const leftDomain = leftEmail.split('@')[1] || '';
  const rightDomain = rightEmail.split('@')[1] || '';

  if (leftDomain && leftDomain === rightDomain) {
    return { score: 10, reason: 'shared_email_domain' };
  }

  return { score: 0, reason: null };
}

function scorePhoneMatch(left, right) {
  const leftPhone = normalizePhone(left);
  const rightPhone = normalizePhone(right);

  if (!leftPhone || !rightPhone) {
    return { score: 0, reason: null };
  }

  if (leftPhone === rightPhone) {
    return { score: 30, reason: 'exact_phone' };
  }

  const leftLast7 = leftPhone.slice(-7);
  const rightLast7 = rightPhone.slice(-7);

  if (leftLast7 && leftLast7 === rightLast7) {
    return { score: 12, reason: 'shared_phone_suffix' };
  }

  return { score: 0, reason: null };
}

function scoreCandidate(input = {}, candidate = {}) {
  const normalizedInput = normalizeInput(input);
  const normalizedCandidate = normalizeCandidate(candidate, candidate.kind);
  const reasons = [];
  let score = 0;

  const nameTarget = normalizedCandidate.name || normalizedCandidate.company;
  const companyTarget = normalizedCandidate.company || normalizedCandidate.name;

  if (normalizedInput.name && nameTarget) {
    const result = scoreTextMatch(normalizedInput.name, nameTarget);
    score += result.score;

    if (result.reason) {
      reasons.push(`name:${result.reason}`);
    }
  }

  if (normalizedInput.company && companyTarget) {
    const result = scoreTextMatch(normalizedInput.company, companyTarget);
    score += result.score;

    if (result.reason) {
      reasons.push(`company:${result.reason}`);
    }
  }

  if (normalizedInput.email && normalizedCandidate.email) {
    const result = scoreEmailMatch(normalizedInput.email, normalizedCandidate.email);
    score += result.score;

    if (result.reason) {
      reasons.push(`email:${result.reason}`);
    }
  }

  if (normalizedInput.phone && normalizedCandidate.phone) {
    const result = scorePhoneMatch(normalizedInput.phone, normalizedCandidate.phone);
    score += result.score;

    if (result.reason) {
      reasons.push(`phone:${result.reason}`);
    }
  }

  if (normalizedInput.company && normalizedCandidate.email) {
    const inputDomain = normalizeEmail(normalizedInput.email).split('@')[1] || '';
    const candidateDomain = normalizeEmail(normalizedCandidate.email).split('@')[1] || '';

    if (inputDomain && candidateDomain && inputDomain === candidateDomain) {
      score += 5;
      reasons.push('domain:shared');
    }
  }

  if (normalizedInput.company && normalizedCandidate.kind === 'company') {
    const companyMatch = scoreTextMatch(normalizedInput.company, normalizedCandidate.name);

    if (companyMatch.reason === 'exact' || companyMatch.reason === 'contains') {
      score += 5;
      reasons.push(`company-kind:${companyMatch.reason}`);
    }
  }

  if (!normalizedCandidate.email && !normalizedCandidate.phone && !nameTarget && !companyTarget) {
    score = Math.max(0, score - 10);
    reasons.push('sparse_candidate');
  }

  return {
    id: normalizedCandidate.id,
    kind: normalizedCandidate.kind,
    name: normalizedCandidate.name,
    company: normalizedCandidate.company,
    email: normalizedCandidate.email,
    phone: normalizedCandidate.phone,
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons,
    raw: normalizedCandidate.raw
  };
}

function rankCandidates(input, candidates = [], { limit = 5 } = {}) {
  return candidates
    .map((candidate) => scoreCandidate(input, candidate))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return String(left.name || left.company || left.id || '').localeCompare(
        String(right.name || right.company || right.id || '')
      );
    })
    .slice(0, Math.max(0, Number(limit) || 0));
}

function disambiguateRealNexRecords(input = {}, { contacts = [], companies = [], limit = 5 } = {}) {
  const normalizedInput = normalizeInput(input);
  const rankedContacts = rankCandidates(
    normalizedInput,
    contacts.map((candidate) => ({ ...candidate, kind: 'contact' })),
    { limit }
  );
  const rankedCompanies = rankCandidates(
    normalizedInput,
    companies.map((candidate) => ({ ...candidate, kind: 'company' })),
    { limit }
  );
  const matches = [...rankedContacts, ...rankedCompanies]
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return String(left.name || left.company || left.id || '').localeCompare(
        String(right.name || right.company || right.id || '')
      );
    })
    .slice(0, Math.max(0, Number(limit) || 0));

  return {
    input: normalizedInput,
    contacts: rankedContacts,
    companies: rankedCompanies,
    matches,
    best_match: matches[0] || null
  };
}

async function collectRecords(listFn, { limit = 50, pageSize = 50 } = {}) {
  const maxRecords = Math.max(0, Number(limit) || 0);
  const resolvedPageSize = Math.max(1, Math.min(50, Number(pageSize) || 50));
  const records = [];
  let skip = 0;

  while (records.length < maxRecords) {
    const top = Math.min(resolvedPageSize, maxRecords - records.length);
    const response = await listFn({ top, skip });
    const page = Array.isArray(response?.value) ? response.value : [];

    if (page.length === 0) {
      break;
    }

    for (const item of page) {
      records.push(item);

      if (records.length >= maxRecords) {
        break;
      }
    }

    skip += page.length;

    if (page.length < top) {
      break;
    }
  }

  return records;
}

function createRealNexService(options = {}) {
  const client = options.client || createRealNexClient(options.clientOptions || {});

  return {
    client,
    listContacts: (listOptions = {}) => client.listContacts(listOptions),
    listProperties: (listOptions = {}) => client.listProperties(listOptions),
    listCompanies: (listOptions = {}) => client.listCompanies(listOptions),
    getContact: (key) => client.getContact(key),
    getProperty: (key) => client.getProperty(key),
    getCompany: (key) => client.getCompany(key),
    scoreCandidate,
    disambiguate: async (input = {}, disambiguationOptions = {}) => {
      const contactLimit = Math.max(
        0,
        Number(
          disambiguationOptions.contactLimit ??
            disambiguationOptions.maxCandidates ??
            options.contactLimit ??
            25
        ) || 0
      );
      const companyLimit = Math.max(
        0,
        Number(
          disambiguationOptions.companyLimit ??
            disambiguationOptions.maxCandidates ??
            options.companyLimit ??
            25
        ) || 0
      );
      const limit = Math.max(
        0,
        Number(disambiguationOptions.limit ?? options.limit ?? 5) || 0
      );
      const pageSize = Math.max(
        1,
        Math.min(
          50,
          Number(
            disambiguationOptions.pageSize ??
              options.pageSize ??
              client.config?.pageSize ??
              50
          ) || 50
        )
      );

      const [contacts, companies] = await Promise.all([
        collectRecords(client.listContacts.bind(client), {
          limit: contactLimit,
          pageSize
        }),
        collectRecords(client.listCompanies.bind(client), {
          limit: companyLimit,
          pageSize
        })
      ]);

      return disambiguateRealNexRecords(input, { contacts, companies, limit });
    }
  };
}

async function disambiguateLocalEntityAgainstRealNex(input = {}, options = {}) {
  const service = options.service || createRealNexService(options.serviceOptions || {});
  const context =
    options.context ||
    (await lookupLocalEntityForRealNex({
      entityId: input.entityId,
      name: input.name,
      email: input.email,
      phone: input.phone,
      company: input.company
    }));
  const disambiguation = await service.disambiguate(context.disambiguation_input, options);

  return {
    entity: context.entity,
    ...disambiguation
  };
}

module.exports = {
  createRealNexService,
  disambiguateLocalEntityAgainstRealNex,
  scoreCandidate,
  rankCandidates,
  disambiguateRealNexRecords,
  collectRecords,
  normalizeInput,
  normalizeCandidate
};
