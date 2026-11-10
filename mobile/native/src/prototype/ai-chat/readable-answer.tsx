import { useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { Type, useDesign } from '../design';
import { mergeAppSources, presentLegacyAppAnswer, splitSourceReferences } from '../app-assistant/presentation';
import type { AppResultSource } from '../app-assistant/core';
import { answerBlocks } from './answer-format';

function publicLink(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function Inline({ value, onOpen }: { value: string; onOpen: (url: string) => void }) {
  const { colors } = useDesign();
  const pieces = value.split(/(\[[^\]\n]+\]\(https:\/\/[^\s)]+\)|\*\*[^*\n]+\*\*|`[^`\n]+`|https:\/\/[^\s<>，。；！？、）】]+)/g);
  return <>{pieces.map((piece, index) => {
    const link = /^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/.exec(piece);
    let candidate = link?.[2] ?? (piece.startsWith('https://') ? piece.replace(/[，。；,.]+$/, '') : '');
    if (!link) {
      while (candidate.endsWith(')') && candidate.split(')').length > candidate.split('(').length) candidate = candidate.slice(0, -1);
    }
    const url = publicLink(candidate);
    if (url) {
      const label = link?.[1] ?? new URL(url).hostname.replace(/^www\./, '');
      return <Text key={index}><Text accessibilityRole="link" accessibilityLabel={label} style={{ color: colors.accent, textDecorationLine: 'underline' }} onPress={() => onOpen(url)}>{label}</Text>{link ? '' : piece.slice(candidate.length)}</Text>;
    }
    if (piece.startsWith('**') && piece.endsWith('**')) return <Text key={index} style={{ fontWeight: '600' }}>{piece.slice(2, -2)}</Text>;
    if (piece.startsWith('`') && piece.endsWith('`')) return <Text key={index} style={{ fontFamily: 'monospace' }}>{piece.slice(1, -1)}</Text>;
    return piece;
  })}</>;
}

/** Readable text only. Never evaluates HTML, images or source content. */
export function ReadableAnswer({ content, sources = [] }: { content: string; sources?: AppResultSource[] }) {
  const { text, colors } = useDesign();
  const [showEvidence, setShowEvidence] = useState(false);
  const [linkFailed, setLinkFailed] = useState(false);
  const saved = splitSourceReferences(content);
  const legacy = presentLegacyAppAnswer(saved.text);
  const allSources = mergeAppSources(saved.sources, sources);
  const blocks = answerBlocks(legacy.text);
  const openLink = (url: string) => { setLinkFailed(false); void Linking.openURL(url).catch(() => setLinkFailed(true)); };
  return <View style={{ gap: 8 }}>
    {legacy.evidence && !legacy.text ? <Type size={15}>{text('旧版查询资料已保留，这条记录尚未完成分析。', 'The earlier lookup is preserved. This record has no completed analysis.')}</Type> : null}
    {blocks.map((block, index) => {
      if (block.kind === 'code') return <View key={index} style={{ backgroundColor: colors.soft, padding: 12, borderRadius: 12 }}><Type selectable size={14} style={{ fontFamily: 'monospace', lineHeight: 22 }}>{block.text}</Type></View>;
      if (block.kind === 'table') return <View key={index} style={{ gap: 8 }}>{block.rows.map((row, rowIndex) => <View key={rowIndex} style={{ backgroundColor: colors.soft, padding: 12, borderRadius: 12, gap: 5 }}>
        {row.map((cell, column) => <Type key={column} selectable size={column ? 14 : 15} weight={column ? '400' : '600'} style={{ lineHeight: 24 }}>
          {`${block.headers[column] ?? text('其他', 'Other')}: `}<Inline value={cell} onOpen={openLink} />
        </Type>)}
      </View>)}</View>;
      return <Type key={index} selectable size={block.kind === 'heading' ? 17 : 16} weight={block.kind === 'heading' ? '600' : '400'} style={{ lineHeight: 27 }}><Inline value={block.text} onOpen={openLink} /></Type>;
    })}
    {linkFailed ? <Type size={13} color={colors.danger}>{text('暂时无法打开来源，请稍后再试。', 'Could not open the source. Please try again.')}</Type> : null}
    {allSources.length ? <AppSourceDetails sources={allSources} /> : null}
    {legacy.evidence ? <View style={{ gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: showEvidence }} onPress={() => setShowEvidence(!showEvidence)} style={{ minHeight: 48, justifyContent: 'center' }}>
        <Type size={13} color={colors.accent}>{showEvidence ? text('收起旧版资料', 'Hide earlier material') : text('查看旧版资料', 'View earlier material')}</Type>
      </Pressable>
      {showEvidence ? <Type selectable size={13} muted style={{ lineHeight: 22 }}>{legacy.evidence}</Type> : null}
    </View> : null}
  </View>;
}

export function AppSourceDetails({ sources }: { sources: AppResultSource[] }) {
  const { text, colors } = useDesign();
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!sources.length) return null;
  return <View style={{ gap: 6 }}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)} style={{ minHeight: 48, justifyContent: 'center' }}>
      <Type size={13} color={colors.accent}>{expanded ? text('收起资料来源', 'Hide sources') : text('查看资料来源', 'View sources')}</Type>
    </Pressable>
    {expanded ? sources.map(source => <Pressable key={source.url} accessibilityRole="link" accessibilityLabel={source.label} onPress={() => {
      const url = publicLink(source.url); setFailed(false);
      if (url) void Linking.openURL(url).catch(() => setFailed(true));
    }} style={{ minHeight: 48, justifyContent: 'center' }}><Type size={14} color={colors.accent}>{source.label}</Type></Pressable>) : null}
    {failed ? <Type size={13} color={colors.danger}>{text('暂时无法打开来源，请稍后再试。', 'Could not open the source. Please try again.')}</Type> : null}
  </View>;
}
