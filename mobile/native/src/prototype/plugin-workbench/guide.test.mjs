import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { integrationGuideMarkdown, integrationGuideMetadata } from './guide-content.ts';
import { approvedGuideLink, findGuideSections, guideSpans, parseIntegrationGuide, standardGuideUrl } from './guide.ts';

const guide = parseIntegrationGuide(integrationGuideMarkdown);

test('the complete offline reference matches its authority and frozen provenance', async () => {
  const authority = await readFile(new URL('../../../../../backend/docs/plugin-integration.md', import.meta.url), 'utf8');
  assert.equal(integrationGuideMarkdown, authority);
  assert.equal(createHash('sha256').update(authority).digest('hex'), integrationGuideMetadata.sha256);
  assert.equal(integrationGuideMetadata.frozenDate, '2026-11-04');
  assert.equal(integrationGuideMetadata.baselineDate, '2026-10-18');
  assert.equal(guide.title, 'Q 插件接入规范');
  assert.equal(guide.sections.length, 12);
  assert.match(guide.sections.at(-1).title, /financial provider compatibility/);
  assert.doesNotMatch(integrationGuideMarkdown, /\/Users\/|gitlab\.kai\.com|-----BEGIN .*PRIVATE KEY-----/);
});

test('all numbered chapters and the compatibility appendix remain available offline', () => {
  for (let number = 1; number <= 10; number += 1) {
    assert.ok(guide.sections.some(section => section.title.startsWith(`${number}. `)));
  }
  assert.ok(guide.sections.every(section => section.blocks.length > 0));
  assert.match(guide.sections.at(-1).searchText, /Twelve retains CIMD/);
  assert.ok(guide.sections.some(section => section.searchText.includes('开发者账号、Registry 注册、人工上架审核不是')));
  assert.ok(guide.sections.some(section => section.searchText.includes('不得再次执行业务工具')));
});

test('tables preserve column associations and code keeps HTML as literal text', () => {
  const blocks = guide.sections.flatMap(section => section.blocks);
  const roles = blocks.find(block => block.kind === 'table' && block.headers[0] === '角色');
  assert.deepEqual(roles.headers, ['角色', '负责', '不应混入的职责']);
  assert.equal(roles.rows.length, 3);
  assert.ok(roles.rows.every(row => row.length === 3));
  const code = blocks.filter(block => block.kind === 'code');
  assert.equal(code.length, 3);
  assert.ok(code.some(block => block.language === 'html' && block.text.includes('<link rel="ai-catalog"')));
  assert.ok(code.some(block => block.text.includes('ui://calendar/planner.html')));
  assert.deepEqual(parseIntegrationGuide('# Guide\n\n<script>alert(1)</script>').sections[0].blocks, [{ kind: 'paragraph', text: '<script>alert(1)</script>' }]);
});

test('search reads chapter bodies and examples without requiring a network', () => {
  assert.equal(findGuideSections(guide.sections, '').length, 12);
  assert.ok(findGuideSections(guide.sections, 'CIMD').length > 1);
  assert.equal(findGuideSections(guide.sections, '资源 ui://').some(section => section.title.startsWith('6.')), true);
  assert.equal(findGuideSections(guide.sections, 'zz-no-match-72819').length, 0);
});

test('only explicit bundled standards references can pass the outbound confirmation gate', () => {
  const url = 'https://modelcontextprotocol.io/specification/2026-07-28';
  assert.equal(approvedGuideLink(guide, url)?.title, 'MCP 2026-07-28');
  for (const value of [
    'https://modelcontextprotocol.io/specification/unlisted',
    'https://gitlab.kai.com/KAI/oD/ZoD/Q',
    'http://modelcontextprotocol.io/specification/2026-07-28',
    'https://person:secret@modelcontextprotocol.io/specification/2026-07-28',
    'https://modelcontextprotocol.io.evil.example/specification/2026-07-28',
    'file:///Users/anyone/private', 'javascript:alert(1)', '../AGENTS.md',
  ]) assert.equal(approvedGuideLink(guide, value), null);
  assert.equal(standardGuideUrl('https://github.com/Agent-Card/ai-catalog'), true);
  assert.equal(standardGuideUrl('https://github.com/another-owner/repo'), false);
  const unsafe = parseIntegrationGuide('# Guide\n\n[Private](https://gitlab.kai.com/private) [Bad](javascript:alert)\n\n```html\n<a href="https://modelcontextprotocol.io/specification/2026-07-28">sample</a>\n```');
  assert.deepEqual(unsafe.sections[0].links, []);
});

test('native inline text keeps emphasis and code while internal links stay readable text', () => {
  assert.deepEqual(guideSpans('遵循 **权限** 与 `server/discover`，见 [根规范](../../AGENTS.md)。'), [
    { kind: 'text', text: '遵循 ' }, { kind: 'strong', text: '权限' },
    { kind: 'text', text: ' 与 ' }, { kind: 'code', text: 'server/discover' },
    { kind: 'text', text: '，见 根规范。' },
  ]);
});
