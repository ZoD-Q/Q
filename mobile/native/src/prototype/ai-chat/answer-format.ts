export type AnswerBlock = { kind: 'text' | 'heading' | 'code'; text: string }
  | { kind: 'table'; headers: string[]; rows: string[][] };

function cells(line: string): string[] {
  const result: string[] = []; let cell = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && line[i + 1] === '|') { cell += '|'; i++; }
    else if (line[i] === '|') { result.push(cell.trim()); cell = ''; }
    else cell += line[i];
  }
  result.push(cell.trim());
  if (line.trimStart().startsWith('|')) result.shift();
  if (line.trimEnd().endsWith('|')) result.pop();
  return result;
}

/** A small native text renderer contract; code is preserved and never interpreted. */
export function answerBlocks(value: string): AnswerBlock[] {
  const lines = value.split('\n'), blocks: AnswerBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const code: string[] = [], closing = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
      for (i++; i < lines.length && !closing.test(lines[i]); i++) code.push(lines[i]);
      blocks.push({ kind: 'code', text: code.join('\n') }); continue;
    }
    const header = line.includes('|') ? cells(line) : [];
    const separator = i + 1 < lines.length ? cells(lines[i + 1]) : [];
    if (header.length > 1 && separator.length === header.length && separator.every(cell => /^:?-{3,}:?$/.test(cell))) {
      const rows: string[][] = []; i++;
      while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim()) rows.push(cells(lines[++i]));
      blocks.push({ kind: 'table', headers: header, rows }); continue;
    }
    if (!line.trim() || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    blocks.push({ kind: heading ? 'heading' : 'text', text: heading?.[1] ?? line.replace(/^\s*[-*]\s+/, '• ') });
  }
  return blocks;
}
