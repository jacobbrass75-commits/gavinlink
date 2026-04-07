const fs = require('fs');
const path = require('path');
const { WIKI_ROOT } = require('./promote');

const KNOWLEDGE_CITATION_REGEX = /\[ke:([0-9a-f-]{36})\]/gi;
const RAW_CITATION_REGEX = /\[raw:([^\]]+)\]/gi;

function normalizeRelativePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function extractCitations(content, regex) {
  const values = new Set();
  let match = regex.exec(content);

  while (match) {
    values.add(match[1]);
    match = regex.exec(content);
  }

  regex.lastIndex = 0;
  return [...values];
}

async function walkMarkdownFiles(rootPath) {
  const entries = await fs.promises.readdir(rootPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(rootPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walkMarkdownFiles(absolutePath)));
      continue;
    }

    if (entry.isFile() && absolutePath.endsWith('.md')) {
      files.push(absolutePath);
    }
  }

  return files;
}

function countNumericLinesWithoutCitations(content) {
  return content
    .split('\n')
    .filter((line) => /\d/.test(line))
    .filter((line) => !/\[(ke|raw):[^\]]+\]/.test(line))
    .filter((line) => !/^\s*#/.test(line))
    .filter((line) => line.trim() !== '').length;
}

async function lintWiki({
  wikiRoot = WIKI_ROOT,
  rawRoot = path.resolve(process.cwd(), 'raw'),
  baseRoot = process.cwd(),
  resolveKnowledgeEntry = null
} = {}) {
  const files = await walkMarkdownFiles(wikiRoot).catch(() => []);
  const indexPath = path.join(wikiRoot, 'index.md');
  const contentFiles = files.filter((filePath) => !/\/(?:README|index)\.md$/i.test(filePath));
  const results = {
    pages_scanned: contentFiles.length,
    missing_citations: [],
    missing_sources_section: [],
    invalid_knowledge_citations: [],
    missing_raw_sources: [],
    orphan_pages: [],
    numeric_claim_warnings: []
  };

  let indexContent = '';

  try {
    indexContent = await fs.promises.readFile(indexPath, 'utf8');
  } catch (_error) {
    indexContent = '';
  }

  for (const filePath of contentFiles) {
    const relativePath = normalizeRelativePath(path.relative(baseRoot, filePath));
    const content = await fs.promises.readFile(filePath, 'utf8');
    const knowledgeCitations = extractCitations(content, KNOWLEDGE_CITATION_REGEX);
    const rawCitations = extractCitations(content, RAW_CITATION_REGEX);

    if (knowledgeCitations.length === 0 && rawCitations.length === 0) {
      results.missing_citations.push(relativePath);
    }

    if (!/^## Sources\b/m.test(content)) {
      results.missing_sources_section.push(relativePath);
    }

    const indexRelativePath = normalizeRelativePath(path.relative(path.dirname(indexPath), filePath));

    if (indexContent && !indexContent.includes(relativePath) && !indexContent.includes(indexRelativePath)) {
      results.orphan_pages.push(relativePath);
    }

    const numericWarnings = countNumericLinesWithoutCitations(content);

    if (numericWarnings > 0) {
      results.numeric_claim_warnings.push({
        page: relativePath,
        count: numericWarnings
      });
    }

    for (const rawCitation of rawCitations) {
      const rawPath = path.join(rawRoot, rawCitation);

      try {
        await fs.promises.access(rawPath, fs.constants.R_OK);
      } catch (_error) {
        results.missing_raw_sources.push({
          page: relativePath,
          citation: rawCitation
        });
      }
    }

    if (typeof resolveKnowledgeEntry === 'function') {
      for (const knowledgeId of knowledgeCitations) {
        const resolved = await resolveKnowledgeEntry(knowledgeId);

        if (!resolved) {
          results.invalid_knowledge_citations.push({
            page: relativePath,
            citation: knowledgeId
          });
        }
      }
    }
  }

  results.errors =
    results.missing_citations.length +
    results.missing_sources_section.length +
    results.invalid_knowledge_citations.length +
    results.missing_raw_sources.length +
    results.orphan_pages.length;
  results.warnings = results.numeric_claim_warnings.length;

  return results;
}

module.exports = {
  lintWiki,
  extractCitations
};
