export type GuideLink = { title: string; url: string };
export type GuideBlock =
  | { kind: 'paragraph' | 'heading' | 'bullet'; text: string; marker?: string }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'table'; headers: string[]; rows: string[][] };
export type GuideSection = { id: string; title: string; blocks: GuideBlock[]; links: GuideLink[]; searchText: string };
export type GuideDocument = { title: string; sections: GuideSection[] };
export type GuideSpan = { kind: 'text' | 'strong' | 'code'; text: string };

const markdownLinks = /\[([^\]]+)\]\(([^)]+)\)/g;

/** Only the standards sources used by the bundled authority may become links. */
export function standardGuideUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    if (url.hostname === 'modelcontextprotocol.io') return url.pathname.startsWith('/specification/');
    if (url.hostname === 'ai-catalog.io') return url.pathname === '/spec/';
    return url.hostname === 'github.com' && (
      url.pathname.startsWith('/modelcontextprotocol/') ||
      url.pathname === '/Agent-Card/ai-catalog'
    );
  } catch { return false; }
}

export function guideSpans(value: string): GuideSpan[] {
  const plainLinks = value.replace(markdownLinks, '$1');
  const spans: GuideSpan[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let start = 0;
  for (const match of plainLinks.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > start) spans.push({ kind: 'text', text: plainLinks.slice(start, index) });
    spans.push({ kind: match[1] === undefined ? 'strong' : 'code', text: match[1] ?? match[2] });
    start = index + match[0].length;
  }
  if (start < plainLinks.length) spans.push({ kind: 'text', text: plainLinks.slice(start) });
  return spans;
}

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
const tableSeparator = (line: string) => line.trim().startsWith('|') && cells(line).every(cell => /^:?-{3,}:?$/.test(cell));

/** Parses bundled text into native content. HTML and code are never executed. */
export function parseIntegrationGuide(markdown: string): GuideDocument {
  const sections: GuideSection[] = [];
  let title = '';
  let section: GuideSection = { id: 'overview', title: '阅读说明', blocks: [], links: [], searchText: '' };
  sections.push(section);
  const add = (block: GuideBlock) => {
    section.blocks.push(block);
    const text = block.kind === 'table' ? [...block.headers, ...block.rows.flat()].join('\n') : block.text;
    section.searchText += '\n' + text;
    if (block.kind !== 'code') {
      for (const match of text.matchAll(markdownLinks)) {
        if (standardGuideUrl(match[2]) && !section.links.some(link => link.url === match[2])) {
          section.links.push({ title: match[1], url: match[2] });
        }
      }
    }
  };
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      if (!title && heading[1] === '#') { title = heading[2]; continue; }
      if (heading[1].length <= 2) {
        section = { id: `section-${sections.length}`, title: heading[2], blocks: [], links: [], searchText: heading[2] };
        sections.push(section);
      } else add({ kind: 'heading', text: heading[2] });
      continue;
    }
    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      while (i + 1 < lines.length && !lines[i + 1].startsWith('```')) code.push(lines[++i]);
      if (i + 1 < lines.length) i += 1;
      add({ kind: 'code', language, text: code.join('\n') });
      continue;
    }
    if (line.trim().startsWith('|') && i + 1 < lines.length && tableSeparator(lines[i + 1])) {
      const headers = cells(line);
      const rows: string[][] = [];
      i += 1;
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) rows.push(cells(lines[++i]));
      add({ kind: 'table', headers, rows });
      continue;
    }
    const bullet = /^(-|\d+\.)\s+(.+)$/.exec(line);
    if (bullet) { add({ kind: 'bullet', marker: bullet[1], text: bullet[2] }); continue; }
    const paragraph = [line];
    while (i + 1 < lines.length && lines[i + 1].trim() && !/^(#{1,3}\s|```|\||-\s|\d+\.\s)/.test(lines[i + 1])) paragraph.push(lines[++i]);
    add({ kind: 'paragraph', text: paragraph.join('\n') });
  }
  return { title, sections };
}

export function findGuideSections(sections: GuideSection[], query: string): GuideSection[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return sections.filter(section => terms.every(term => `${section.title}\n${section.searchText}`.toLocaleLowerCase().includes(term)));
}

export function approvedGuideLink(document: GuideDocument, url: string): GuideLink | null {
  if (!standardGuideUrl(url)) return null;
  return document.sections.flatMap(section => section.links).find(link => link.url === url) ?? null;
}
