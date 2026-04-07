const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  inferSection,
  resolvePagePath,
  promoteKnowledgeEntry,
  buildPropertyPageRelativePath
} = require('../../src/wiki/promote');
const { lintWiki } = require('../../src/wiki/lint');

test('inferSection routes lender-style entities into lender pages', () => {
  const section = inferSection({
    linked_entities: [
      {
        name: 'SPECIAL DEFAULT SERVICES INC',
        type: 'corporation'
      }
    ]
  });

  assert.equal(section, 'lenders');
});

test('resolvePagePath builds a property page path when linked property is primary context', () => {
  const pagePath = resolvePagePath(
    {
      linked_properties: [
        {
          address: '8122 MAIE AVE',
          apn: '6027-013-013'
        }
      ]
    },
    {
      wikiRoot: '/tmp/isg-wiki'
    }
  );

  assert.match(pagePath, /properties\/8122-maie-ave\.md$/);
});

test('buildPropertyPageRelativePath prefers address and falls back cleanly', () => {
  const pagePath = buildPropertyPageRelativePath(
    {
      id: '11111111-1111-4111-8111-111111111111',
      address: '324 HORTON PLAZA',
      apn: 'APN-123'
    },
    {
      wikiRoot: 'wiki-test'
    }
  );

  assert.equal(pagePath, 'wiki-test/properties/324-horton-plaza.md');
});

test('promoteKnowledgeEntry creates a sourced wiki page and updates the index', async () => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'isg-wiki-'));
  const wikiRoot = path.join(tempRoot, 'wiki');
  const result = await promoteKnowledgeEntry(
    {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Mike Chen wants industrial',
      ai_summary: 'Mike Chen wants industrial in Carson.',
      source: 'api',
      source_file: '/tmp/mike-chen-note.md',
      linked_entities: [{ id: 'e1', name: 'Mike Chen', type: 'person' }],
      linked_properties: [],
      ai_classifications: ['buyer_intel']
    },
    {
      wikiRoot
    }
  );

  const pageContent = await fs.promises.readFile(result.page_path, 'utf8');
  const indexContent = await fs.promises.readFile(path.join(wikiRoot, 'index.md'), 'utf8');

  assert.equal(result.created, true);
  assert.match(pageContent, /# Mike Chen/);
  assert.match(pageContent, /\[ke:11111111-1111-4111-8111-111111111111\]/);
  assert.match(pageContent, /\[raw:mike-chen-note\.md\]/);
  assert.match(indexContent, /\[Mike Chen\]\(players\/mike-chen\.md\)/);
});

test('lintWiki flags missing citations and missing sources sections', async () => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'isg-lint-'));
  const wikiRoot = path.join(tempRoot, 'wiki');
  const rawRoot = path.join(tempRoot, 'raw');

  await fs.promises.mkdir(path.join(wikiRoot, 'players'), { recursive: true });
  await fs.promises.mkdir(rawRoot, { recursive: true });
  await fs.promises.writeFile(
    path.join(wikiRoot, 'index.md'),
    '# ISG Second Brain Wiki\n\n## Pages\n',
    'utf8'
  );
  await fs.promises.writeFile(
    path.join(wikiRoot, 'players', 'orphan.md'),
    '# Orphan\n\nNo sources here.\n',
    'utf8'
  );

  const result = await lintWiki({
    wikiRoot,
    rawRoot,
    baseRoot: tempRoot,
    resolveKnowledgeEntry: async () => null
  });

  assert.equal(result.pages_scanned, 1);
  assert.deepEqual(result.missing_citations, ['wiki/players/orphan.md']);
  assert.deepEqual(result.missing_sources_section, ['wiki/players/orphan.md']);
  assert.deepEqual(result.orphan_pages, ['wiki/players/orphan.md']);
});
