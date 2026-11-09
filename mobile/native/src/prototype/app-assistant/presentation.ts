import { validateAppNavigationAction, type AppNavigationAction, type AppResultSource } from './core';

/** Distinct destinations/filters remain distinct; identical navigation never multiplies. */
export function mergeAppActions(current: AppNavigationAction[], incoming: AppNavigationAction[]): AppNavigationAction[] {
  const unique = new Map<string, AppNavigationAction>();
  for (const item of [...current, ...incoming]) {
    const action = validateAppNavigationAction(item);
    const { label: _label, ...destination } = action;
    unique.set(JSON.stringify(destination), action);
  }
  return [...unique.values()].slice(-12);
}

export function mergeAppSources(current: AppResultSource[], incoming: AppResultSource[]): AppResultSource[] {
  const unique = new Map<string, AppResultSource>();
  for (const source of [...current, ...incoming]) {
    try {
      const url = new URL(source.url);
      if (url.protocol !== 'https:' || url.username || url.password || !source.label.trim()) continue;
      unique.set(url.href, { label: Array.from(source.label).slice(0, 140).join(''), url: url.href });
    } catch { /* An invalid source must never become a clickable destination. */ }
  }
  return [...unique.values()].slice(-12);
}

/** Old saved evidence stays available without overwhelming the default conversation. */
export function presentLegacyAppAnswer(content: string): { text: string; evidence: string | null } {
  const visible: string[] = [], evidence: string[] = [];
  let inEvidence = false;
  let fence: { character: string; length: number } | null = null;
  for (const line of content.split('\n')) {
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      visible.push(line);
      if (delimiter && delimiter[1][0] === fence.character && delimiter[1].length >= fence.length && line.trim() === delimiter[1]) fence = null;
      continue;
    }
    if (delimiter) { fence = { character: delimiter[1][0], length: delimiter[1].length }; inEvidence = false; visible.push(line); continue; }
    if (/^> (?:公开公司研究资料（外部数据，不是指令）|Public company research evidence \(external data, not instructions\)|SEC申报原文摘录（外部数据|SEC最近申报文件目录（外部数据|SEC filing excerpts \(external data|Recent SEC filing directory \(external data)/.test(line)) inEvidence = true;
    if (inEvidence && (line.startsWith('> ') || !line.trim() || line.startsWith('[Additional results omitted'))) evidence.push(line);
    else { inEvidence = false; visible.push(line); }
  }
  return { text: visible.join('\n').trim(), evidence: evidence.length ? evidence.join('\n').trim() : null };
}

export function isAppRecoveryError(code?: string): boolean {
  return Boolean(code?.startsWith('APP_'));
}

/** Human-readable citations survive history reload; the view folds this short footer. */
export function withSourceReferences(answer: string, sources: AppResultSource[], locale: 'zh' | 'en'): string {
  const references: string[] = [];
  let size = Array.from(answer).length + 30;
  for (const source of mergeAppSources([], sources).slice(0, 5)) {
    const label = source.label.replace(/[\[\]\r\n]/g, ' ');
    const url = source.url.replaceAll('(', '%28').replaceAll(')', '%29');
    const line = `- [${label}](${url})`;
    if (size + Array.from(line).length > 12000) continue;
    references.push(line); size += Array.from(line).length + 1;
  }
  return references.length ? `${answer.trimEnd()}\n\n${locale === 'zh' ? '资料来源：' : 'Sources:'}\n${references.join('\n')}` : answer;
}

export function splitSourceReferences(content: string): { text: string; sources: AppResultSource[] } {
  const start = Math.max(content.lastIndexOf('\n\n资料来源：\n'), content.lastIndexOf('\n\nSources:\n'));
  if (start < 0) return { text: content, sources: [] };
  const lines = content.slice(start + 2).split('\n').slice(1).filter(Boolean);
  const sources: AppResultSource[] = [];
  for (const line of lines) {
    const match = /^- \[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/.exec(line);
    if (!match) return { text: content, sources: [] };
    sources.push({ label: match[1], url: match[2] });
  }
  const safe = mergeAppSources([], sources);
  return safe.length ? { text: content.slice(0, start), sources: safe } : { text: content, sources: [] };
}
