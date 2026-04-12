const { v4: uuidv4 } = require('uuid');
const { query } = require('../db/connection');
const { createRealNexClient } = require('../integrations/realnex');
const { createKnowledgeEntry } = require('../knowledge/extract');
const { findOrCreateEntity, normalizeEntityType } = require('../ingestion/merge');
const {
  createAppError,
  buildEntityLookupPayload,
  lookupLocalEntityForRealNex
} = require('./brain');

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
    candidate.fullName,
    candidate.Name,
    candidate.name,
    candidate.CompanyName,
    candidate.companyName,
    candidate.BusinessName,
    candidate.businessName,
    candidate.DisplayName,
    candidate.displayName,
    candidate.ContactName,
    candidate.contactName,
    candidate.Organization,
    candidate.organization,
    candidate.OrganizationId,
    candidate.organizationId,
    candidate.Full_Name
  ]);
}

function extractCandidateCompany(candidate = {}) {
  return pickFirstString([
    candidate.CompanyName,
    candidate.companyName,
    candidate.Company,
    candidate.company,
    candidate.Organization,
    candidate.organization,
    candidate.Employer,
    candidate.employer,
    candidate.BusinessName,
    candidate.businessName,
    candidate.Workplace,
    candidate.workplace,
    candidate.AccountName,
    candidate.accountName,
    candidate.OrganizationId,
    candidate.organizationId
  ]);
}

function extractCandidateCompanyKey(candidate = {}) {
  return pickFirstString([
    candidate.CompanyKey,
    candidate.companyKey,
    candidate.company_key
  ]);
}

function extractCandidateEmail(candidate = {}) {
  return pickFirstString([
    candidate.Email,
    candidate.email,
    candidate.EmailAddress,
    candidate.emailAddress,
    candidate.WorkEmail,
    candidate.workEmail,
    candidate.PrimaryEmail,
    candidate.primaryEmail,
    candidate.BusinessEmail,
    candidate.businessEmail
  ]);
}

function extractCandidatePhone(candidate = {}) {
  return pickFirstString([
    candidate.Work,
    candidate.work,
    candidate.Mobile,
    candidate.mobile,
    candidate.Home,
    candidate.home,
    candidate.Phone,
    candidate.phone,
    candidate.Telephone,
    candidate.telephone,
    candidate.MainPhone,
    candidate.mainPhone,
    candidate.BusinessPhone,
    candidate.businessPhone,
    candidate.CellPhone,
    candidate.cellPhone,
    candidate.Fax,
    candidate.fax
  ]);
}

function extractCandidateWebsite(candidate = {}) {
  return pickFirstString([
    candidate.WebSite,
    candidate.Website,
    candidate.webSite,
    candidate.website,
    candidate.website,
    candidate.url
  ]);
}

function extractCandidateAddress(candidate = {}) {
  const address = candidate.Address && typeof candidate.Address === 'object'
    ? candidate.Address
    : candidate.address && typeof candidate.address === 'object'
      ? candidate.address
      : null;
  const mailingAddress =
    candidate.MailingAddress && typeof candidate.MailingAddress === 'object'
      ? candidate.MailingAddress
      : candidate.mailingAddress && typeof candidate.mailingAddress === 'object'
        ? candidate.mailingAddress
      : null;
  const selected = address || mailingAddress;

  if (!selected) {
    return null;
  }

  return {
    address1: pickFirstString([selected.Address1, selected.address1, selected.company]),
    address2: pickFirstString([selected.Address2, selected.address2]),
    city: pickFirstString([selected.City, selected.city]),
    state: pickFirstString([selected.State, selected.state]),
    zip: pickFirstString([selected.ZipCode, selected.zip, selected.zipCode]),
    country: pickFirstString([selected.Country, selected.country])
  };
}

function extractCandidateObjectGroups(candidate = {}) {
  const groups = Array.isArray(candidate.ObjectGroups)
    ? candidate.ObjectGroups
    : Array.isArray(candidate.objectGroups)
      ? candidate.objectGroups
      : null;

  if (!groups) {
    return [];
  }

  return groups.map((group) => pickFirstString([group?.Name, group?.name])).filter(Boolean);
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

function normalizeKind(kind, fallback = 'contact') {
  const normalized = cleanText(kind, fallback)?.toLowerCase();
  return normalized === 'company' ? 'company' : 'contact';
}

function inferEntityTypeFromCandidate(candidate = {}, kind = 'contact') {
  if (normalizeKind(kind) === 'contact') {
    return 'person';
  }

  return normalizeEntityType('company', extractCandidateName(candidate) || extractCandidateCompany(candidate) || '');
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

async function findLinkedCompanyContactMatch(input = {}, contacts = [], service, { limit = 5 } = {}) {
  const normalizedInput = normalizeInput(input);

  if (
    !service ||
    !cleanText(normalizedInput.name, null) ||
    !cleanText(normalizedInput.company, null) ||
    !Array.isArray(contacts) ||
    contacts.length === 0
  ) {
    return null;
  }

  let best = null;

  for (const candidate of contacts.slice(0, Math.max(1, Number(limit) || 1))) {
    const candidateId = cleanText(candidate?.id ?? candidate?.Key ?? candidate?.key, null);
    const candidateName = candidate?.name || candidate?.raw?.FullName || candidate?.raw?.fullName;
    const nameMatch = scoreTextMatch(normalizedInput.name, candidateName);

    if (!candidateId || nameMatch.score < 24) {
      continue;
    }

    let fullContact;
    try {
      fullContact = await service.getContact(candidateId);
    } catch (_error) {
      continue;
    }

    const companyKey = extractCandidateCompanyKey(fullContact);

    if (!companyKey) {
      continue;
    }

    let companyRecord;
    try {
      companyRecord = await service.getCompany(companyKey);
    } catch (_error) {
      continue;
    }

    const companyName = extractCandidateName(companyRecord) || extractCandidateCompany(companyRecord);

    if (!companyName) {
      continue;
    }

    const scored = scoreCandidate(normalizedInput, {
      ...fullContact,
      CompanyName: companyName,
      companyName: companyName,
      kind: 'contact'
    });

    if (!best || scored.score > best.match.score) {
      best = {
        match: scored,
        contact: {
          ...fullContact,
          CompanyName: companyName,
          companyName: companyName,
          kind: 'contact'
        },
        company: companyRecord
      };
    }
  }

  return best;
}

async function findEntityById(entityId) {
  if (!cleanText(entityId, null)) {
    return null;
  }

  const result = await query(
    `
      SELECT id, name, normalized_name, entity_type, phone, email, metadata
      FROM entities
      WHERE id = $1
      LIMIT 1
    `,
    [entityId]
  );

  return result.rows[0] || null;
}

async function findEntityByRealNexRef(kind, key) {
  const normalizedKind = normalizeKind(kind, null);
  const normalizedKey = cleanText(key, null);

  if (!normalizedKind || !normalizedKey) {
    return null;
  }

  const result = await query(
    `
      SELECT id, name, normalized_name, entity_type, phone, email, metadata
      FROM entities
      WHERE metadata -> 'external_refs' -> 'realnex' ->> 'kind' = $1
        AND metadata -> 'external_refs' -> 'realnex' ->> 'key' = $2
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [normalizedKind, normalizedKey]
  );

  return result.rows[0] || null;
}

function mergeEntityMetadata(existingMetadata = {}, nextMetadata = {}) {
  return {
    ...existingMetadata,
    ...nextMetadata,
    external_refs: {
      ...(existingMetadata.external_refs || {}),
      ...(nextMetadata.external_refs || {})
    },
    realnex: {
      ...(existingMetadata.realnex || {}),
      ...(nextMetadata.realnex || {})
    }
  };
}

async function updateEntityFromRealNex(entityId, candidate = {}, kind, context = {}) {
  const existing = await findEntityById(entityId);

  if (!existing) {
    throw createAppError(404, 'Entity not found');
  }

  const normalizedKind = normalizeKind(kind);
  const candidateName = extractCandidateName(candidate) || extractCandidateCompany(candidate) || existing.name;
  const candidateCompany = extractCandidateCompany(candidate) || context.company || existing.metadata?.company || null;
  const candidateEmail = extractCandidateEmail(candidate) || context.email || existing.email || null;
  const candidatePhone = extractCandidatePhone(candidate) || context.phone || existing.phone || null;
  const candidateWebsite = extractCandidateWebsite(candidate);
  const candidateKey = cleanText(candidate.Key ?? candidate.key ?? candidate.Id ?? candidate.id, null);
  const nextMetadata = mergeEntityMetadata(existing.metadata || {}, {
    ...(candidateCompany ? { company: candidateCompany } : {}),
    ...(candidateKey
      ? {
          external_refs: {
            realnex: {
              kind: normalizedKind,
              key: candidateKey,
              synced_at: new Date().toISOString()
            }
          }
        }
      : {}),
    realnex: {
      kind: normalizedKind,
      key: candidateKey,
      name: candidateName,
      company: candidateCompany,
      email: candidateEmail,
      phone: candidatePhone,
      website: candidateWebsite,
      object_groups: extractCandidateObjectGroups(candidate),
      address: extractCandidateAddress(candidate)
    }
  });

  const result = await query(
    `
      UPDATE entities
      SET
        phone = COALESCE(entities.phone, $2),
        email = COALESCE(entities.email, $3),
        metadata = $4::jsonb,
        updated_at = NOW()
      WHERE id = $1
      RETURNING id, name, normalized_name, entity_type, phone, email, metadata
    `,
    [entityId, candidatePhone, candidateEmail, JSON.stringify(nextMetadata)]
  );

  return result.rows[0] || existing;
}

async function ensureRelationship(parentEntityId, childEntityId, relationshipType, metadata = {}) {
  if (!parentEntityId || !childEntityId || parentEntityId === childEntityId) {
    return false;
  }

  const result = await query(
    `
      INSERT INTO entity_relationships (
        id,
        parent_entity_id,
        child_entity_id,
        relationship_type,
        source,
        confidence,
        metadata
      )
      VALUES ($1, $2, $3, $4, 'realnex_sync', 0.85, $5::jsonb)
      ON CONFLICT (parent_entity_id, child_entity_id, relationship_type)
      DO NOTHING
      RETURNING id
    `,
    [uuidv4(), parentEntityId, childEntityId, relationshipType, JSON.stringify(metadata)]
  );

  return Boolean(result.rows[0]);
}

function buildKnowledgeLines(entity, kind, candidate, companyEntity = null) {
  const lines = [
    `RealNex ${kind} sync completed for ${entity.name}.`,
    cleanText(extractCandidateEmail(candidate), null)
      ? `Email: ${extractCandidateEmail(candidate)}`
      : null,
    cleanText(extractCandidatePhone(candidate), null)
      ? `Phone: ${extractCandidatePhone(candidate)}`
      : null,
    cleanText(extractCandidateCompany(candidate), null)
      ? `Company: ${extractCandidateCompany(candidate)}`
      : null,
    cleanText(extractCandidateWebsite(candidate), null)
      ? `Website: ${extractCandidateWebsite(candidate)}`
      : null,
    companyEntity?.name ? `Linked company entity: ${companyEntity.name}` : null,
    cleanText(candidate?.Key ?? candidate?.key ?? candidate?.Id ?? candidate?.id, null)
      ? `RealNex key: ${cleanText(candidate.Key ?? candidate.key ?? candidate.Id ?? candidate.id, null)}`
      : null
  ].filter(Boolean);

  return lines.join('\n');
}

async function maybeCreateRealNexKnowledgeEntry({
  entity,
  candidate,
  kind,
  companyEntity = null,
  createKnowledge = true,
  alreadyLinked = false
}) {
  if (!createKnowledge || alreadyLinked || !entity?.id) {
    return null;
  }

  const content = buildKnowledgeLines(entity, kind, candidate, companyEntity);
  return createKnowledgeEntry({
    entry_type: 'other',
    title: `RealNex sync: ${entity.name}`,
    content,
    summary: `Imported ${normalizeKind(kind)} from RealNex for ${entity.name}`,
    source: 'realnex',
    entity_id: entity.id,
    metadata: {
      provider: 'realnex',
      external_source: 'realnex',
      kind: normalizeKind(kind),
      key: cleanText(candidate?.Key ?? candidate?.key ?? candidate?.Id ?? candidate?.id, null),
      company_entity_id: companyEntity?.id || null
    },
    ai_summary: `RealNex import completed for ${entity.name}`,
    ai_tags: ['realnex', normalizeKind(kind)],
    ai_classifications: ['relationship', 'general_note'],
    entity_ids: [entity.id, companyEntity?.id].filter(Boolean)
  });
}

async function syncCandidateToBrain(candidate = {}, kind, options = {}) {
  const normalizedKind = normalizeKind(kind);
  const existingByRef = await findEntityByRealNexRef(
    normalizedKind,
    candidate.Key ?? candidate.key ?? candidate.Id ?? candidate.id
  );
  let baseEntity = options.entityId ? await findEntityById(options.entityId) : existingByRef;

  if (!baseEntity) {
    const entitySeed = {
      name: extractCandidateName(candidate) || extractCandidateCompany(candidate),
      type: inferEntityTypeFromCandidate(candidate, normalizedKind),
      email: extractCandidateEmail(candidate),
      phone: extractCandidatePhone(candidate)
    };
    const created = await findOrCreateEntity(entitySeed);
    baseEntity = created.entity;
  }

  const updatedEntity = await updateEntityFromRealNex(baseEntity.id, candidate, normalizedKind, {
    company: options.company,
    email: options.email,
    phone: options.phone
  });
  const companyName =
    extractCandidateCompany(candidate) || cleanText(options.company, null) || null;
  let companyEntity = null;
  let relationshipCreated = false;

  if (normalizedKind === 'contact' && companyName) {
    if (options.companyCandidate) {
      companyEntity = await syncCandidateToBrain(options.companyCandidate, 'company', {
        createKnowledge: false,
        company: companyName
      });
      companyEntity = companyEntity.entity;
    } else {
      const companyResult = await findOrCreateEntity({
        name: companyName,
        type: 'company'
      });
      companyEntity = companyResult.entity;
    }

    relationshipCreated = await ensureRelationship(updatedEntity.id, companyEntity.id, 'affiliated_with', {
      provider: 'realnex'
    });
  }

  const knowledgeEntry = await maybeCreateRealNexKnowledgeEntry({
    entity: updatedEntity,
    candidate,
    kind: normalizedKind,
    companyEntity,
    createKnowledge: options.createKnowledge !== false,
    alreadyLinked: Boolean(existingByRef)
  });
  const lookupPayload = await buildEntityLookupPayload(updatedEntity.id, {
    matchType: existingByRef ? 'realnex_existing' : 'realnex_import'
  });

  return {
    status: existingByRef ? 'already_linked' : 'imported',
    entity: updatedEntity,
    company_entity: companyEntity,
    relationship_created: relationshipCreated,
    knowledge_entry_id: knowledgeEntry?.id || null,
    lookup_payload: lookupPayload
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

async function importRealNexMatchToBrain(input = {}, options = {}) {
  const service = options.service || createRealNexService(options.serviceOptions || {});
  const minScore = Math.max(1, Math.min(100, Number(options.minScore ?? input.minScore ?? 70) || 70));
  const kind = cleanText(input.kind, null)?.toLowerCase() || null;
  const key = cleanText(input.key, null);
  const normalizedInput = normalizeInput(input);

  if (key && kind) {
    const candidate =
      normalizeKind(kind) === 'company'
        ? await service.getCompany(key)
        : await service.getContact(key);
    return {
      disambiguation: null,
      ...(await syncCandidateToBrain(candidate, kind, {
        entityId: input.entityId,
        company: input.company,
        email: input.email,
        phone: input.phone,
        createKnowledge: options.createKnowledge !== false
      }))
    };
  }

  const disambiguation = await disambiguateLocalEntityAgainstRealNex(input, options);
  let bestMatch = disambiguation.best_match;
  let candidate = null;
  let topCompanyCandidate =
    bestMatch?.kind === 'contact'
      ? (disambiguation.companies || []).find((company) => Number(company.score || 0) >= minScore)
      : null;

  if (!bestMatch || Number(bestMatch.score || 0) < minScore) {
    const linkedCompanyMatch = await findLinkedCompanyContactMatch(
      normalizedInput,
      disambiguation.contacts || [],
      service,
      {
        limit: Math.min(5, Math.max(1, Number(options.limit ?? input.limit ?? 5) || 5))
      }
    );

    if (linkedCompanyMatch && Number(linkedCompanyMatch.match.score || 0) >= minScore) {
      bestMatch = linkedCompanyMatch.match;
      candidate = linkedCompanyMatch.contact;
      topCompanyCandidate = linkedCompanyMatch.company;
    }
  }

  if (!bestMatch || Number(bestMatch.score || 0) < minScore) {
    throw createAppError(404, 'No confident RealNex match found');
  }

  if (!candidate) {
    candidate =
      bestMatch.kind === 'company'
        ? await service.getCompany(bestMatch.id)
        : await service.getContact(bestMatch.id);
  }
  let companyCandidateFromKey = null;

  if (
    bestMatch.kind === 'contact' &&
    !topCompanyCandidate &&
    cleanText(candidate?.companyKey, null)
  ) {
    try {
      companyCandidateFromKey = await service.getCompany(candidate.companyKey);
    } catch (_error) {
      companyCandidateFromKey = null;
    }
  }

  return {
    disambiguation,
    ...(await syncCandidateToBrain(candidate, bestMatch.kind, {
      entityId: input.entityId || disambiguation.entity?.id || null,
      company:
        input.company ||
        extractCandidateName(companyCandidateFromKey) ||
        extractCandidateCompany(companyCandidateFromKey) ||
        null,
      email: input.email || null,
      phone: input.phone || null,
      createKnowledge: options.createKnowledge !== false,
      companyCandidate: topCompanyCandidate?.raw || companyCandidateFromKey || null
    }))
  };
}

module.exports = {
  createRealNexService,
  disambiguateLocalEntityAgainstRealNex,
  importRealNexMatchToBrain,
  scoreCandidate,
  rankCandidates,
  disambiguateRealNexRecords,
  collectRecords,
  normalizeInput,
  normalizeCandidate
};
