const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = process.cwd();
const WIKI_ROOT = path.join(PROJECT_ROOT, 'wiki');
const INDEX_PATH = path.join(WIKI_ROOT, 'index.md');

function cleanText(value, fallback = '') {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function slugify(value, fallback = 'entry') {
  const text = cleanText(value, '');

  if (!text) {
    return fallback;
  }

  const slug = text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || fallback;
}

function normalizeRelativePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function inferSection(entry = {}) {
  const entity = entry.linked_entities?.[0] || null;
  const property = entry.linked_properties?.[0] || null;
  const classifications = Array.isArray(entry.ai_classifications) ? entry.ai_classifications : [];

  if (entity) {
    const entityType = String(entity.type || entity.entity_type || '').toLowerCase();
    const entityName = String(entity.name || '').toUpperCase();

    if (
      entityType === 'lender' ||
      entityType === 'trustee' ||
      /\b(BANK|LENDER|MORTGAGE|FINANCIAL|TRUSTEE|DEFAULT SERVICES)\b/.test(entityName)
    ) {
      return 'lenders';
    }

    return 'players';
  }

  if (property) {
    return 'properties';
  }

  if (classifications.includes('market_insight')) {
    return 'submarkets';
  }

  if (classifications.includes('action_item') || classifications.includes('deal_update')) {
    return 'playbooks';
  }

  return 'patterns';
}

function resolvePageTitle(entry = {}, options = {}) {
  if (cleanText(options.title, '')) {
    return cleanText(options.title, '');
  }

  if (entry.linked_entities?.[0]?.name) {
    return entry.linked_entities[0].name;
  }

  if (entry.linked_properties?.[0]?.address) {
    return entry.linked_properties[0].address;
  }

  if (entry.linked_properties?.[0]?.apn) {
    return `Property ${entry.linked_properties[0].apn}`;
  }

  if (cleanText(entry.title, '')) {
    return entry.title;
  }

  if (cleanText(entry.ai_summary, '')) {
    return entry.ai_summary.slice(0, 80);
  }

  return `Knowledge ${String(entry.id || 'entry').slice(0, 8)}`;
}

function resolvePagePath(entry = {}, options = {}) {
  const wikiRoot = options.wikiRoot
    ? path.resolve(PROJECT_ROOT, options.wikiRoot)
    : WIKI_ROOT;

  if (cleanText(options.page, '')) {
    return path.isAbsolute(options.page)
      ? options.page
      : path.resolve(PROJECT_ROOT, options.page);
  }

  const section = inferSection(entry);
  const title = resolvePageTitle(entry, options);
  return path.join(wikiRoot, section, `${slugify(title)}.md`);
}

function buildSourceLines(entry = {}) {
  const lines = [`- Knowledge entry [ke:${entry.id}]`];

  if (cleanText(entry.source_file, '')) {
    lines.push(`- Raw source [raw:${path.basename(entry.source_file)}]`);
  }

  for (const property of entry.linked_properties || []) {
    if (property?.id) {
      lines.push(`- Property reference \`${property.apn || property.id}\``);
    }
  }

  return [...new Set(lines)];
}

function buildSnapshotLines(entry = {}) {
  const lines = [];

  if (Array.isArray(entry.ai_classifications) && entry.ai_classifications.length > 0) {
    lines.push(`- Classifications: ${entry.ai_classifications.join(', ')}`);
  }

  if (Array.isArray(entry.linked_entities) && entry.linked_entities.length > 0) {
    lines.push(
      `- Linked entities: ${entry.linked_entities
        .map((entity) => `${entity.name} (${entity.type || entity.entity_type || 'unknown'})`)
        .join('; ')}`
    );
  }

  if (Array.isArray(entry.linked_properties) && entry.linked_properties.length > 0) {
    lines.push(
      `- Linked properties: ${entry.linked_properties
        .map((property) => property.address || property.apn || property.id)
        .join('; ')}`
    );
  }

  if (cleanText(entry.source, '')) {
    lines.push(`- Source channel: ${entry.source}`);
  }

  return lines;
}

function buildUpdateBlock(entry = {}, promotedAt = new Date()) {
  const dateLabel = promotedAt.toISOString().slice(0, 10);
  const summary = cleanText(entry.ai_summary, cleanText(entry.summary, cleanText(entry.title, '')));
  const narrative = summary || cleanText(entry.content, '').slice(0, 400);
  const sourceTokens = [`[ke:${entry.id}]`];

  if (cleanText(entry.source_file, '')) {
    sourceTokens.push(`[raw:${path.basename(entry.source_file)}]`);
  }

  const detailLines = [];

  if (narrative) {
    detailLines.push(`- ${narrative} ${sourceTokens.join(' ')}`.trim());
  }

  for (const line of buildSnapshotLines(entry)) {
    detailLines.push(`${line} ${sourceTokens[0]}`);
  }

  return [`### ${dateLabel}`, ...detailLines].join('\n');
}

function buildNewPage(entry = {}, title, updateBlock) {
  const snapshotLines = buildSnapshotLines(entry);
  const sources = buildSourceLines(entry);

  return [
    `# ${title}`,
    '',
    '## Summary',
    cleanText(entry.ai_summary, cleanText(entry.summary, 'Promoted from a knowledge entry.')),
    '',
    '## Snapshot',
    ...(snapshotLines.length > 0 ? snapshotLines : ['- Narrative layer page created from the knowledge base.']),
    '',
    '## Updates',
    updateBlock,
    '',
    '## Sources',
    ...sources,
    ''
  ].join('\n');
}

function upsertSources(content, sourceLines) {
  let nextContent = content.trimEnd();

  if (!/\n## Sources\b/m.test(nextContent)) {
    nextContent += '\n\n## Sources\n';
  }

  for (const line of sourceLines) {
    if (!nextContent.includes(line)) {
      nextContent += `${nextContent.endsWith('\n') ? '' : '\n'}${line}\n`;
    }
  }

  return nextContent.endsWith('\n') ? nextContent : `${nextContent}\n`;
}

function prependUpdate(content, updateBlock) {
  const updatesHeading = '## Updates';

  if (content.includes(updatesHeading)) {
    return content.replace(updatesHeading, `${updatesHeading}\n${updateBlock}\n`);
  }

  return `${content.trimEnd()}\n\n## Updates\n${updateBlock}\n`;
}

async function ensureWikiIndex(relativePagePath, title, options = {}) {
  const indexPath = options.indexPath
    ? path.resolve(PROJECT_ROOT, options.indexPath)
    : options.wikiRoot
      ? path.join(path.resolve(PROJECT_ROOT, options.wikiRoot), 'index.md')
      : INDEX_PATH;

  await fs.promises.mkdir(path.dirname(indexPath), { recursive: true });

  let content = '# ISG Second Brain Wiki\n\n## Pages\n';

  try {
    content = await fs.promises.readFile(indexPath, 'utf8');
  } catch (_error) {
    // Use default content.
  }

  const absolutePagePath = path.resolve(PROJECT_ROOT, relativePagePath);
  const normalizedPath = normalizeRelativePath(path.relative(path.dirname(indexPath), absolutePagePath));
  const line = `- [${title}](${normalizedPath})`;

  if (!content.includes(line)) {
    const next = content.trimEnd();
    await fs.promises.writeFile(indexPath, `${next}\n${line}\n`, 'utf8');
  }
}

async function promoteKnowledgeEntry(entry, options = {}) {
  if (!entry?.id) {
    throw new Error('knowledge entry id is required');
  }

  const title = resolvePageTitle(entry, options);
  const pagePath = resolvePagePath(entry, options);
  const updateBlock = buildUpdateBlock(entry, options.promotedAt || new Date());
  const sourceLines = buildSourceLines(entry);

  await fs.promises.mkdir(path.dirname(pagePath), { recursive: true });

  let created = false;
  let content;

  try {
    content = await fs.promises.readFile(pagePath, 'utf8');
  } catch (_error) {
    created = true;
    content = buildNewPage(entry, title, updateBlock);
    await fs.promises.writeFile(pagePath, content, 'utf8');
  }

  if (!created) {
    content = prependUpdate(content, updateBlock);
    content = upsertSources(content, sourceLines);
    await fs.promises.writeFile(pagePath, content, 'utf8');
  }

  const relativePagePath = normalizeRelativePath(path.relative(PROJECT_ROOT, pagePath));
  await ensureWikiIndex(relativePagePath, title, options);

  return {
    page_path: pagePath,
    relative_page_path: relativePagePath,
    created,
    title
  };
}

module.exports = {
  WIKI_ROOT,
  INDEX_PATH,
  slugify,
  inferSection,
  resolvePageTitle,
  resolvePagePath,
  buildSourceLines,
  promoteKnowledgeEntry
};
