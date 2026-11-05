import { useEffect, useRef, useState } from 'react';
import { BackHandler, Keyboard, Linking, ScrollView, View } from 'react-native';
import { ArrowLeft, ArrowRight, BookOpen, ExternalLink } from 'lucide-react-native';
import { Action, Divider, Input, Page, Row, Sheet, Tag, Type, useDesign } from '../design';
import { integrationGuideMarkdown, integrationGuideMetadata } from './guide-content';
import { approvedGuideLink, findGuideSections, guideSpans, parseIntegrationGuide, type GuideBlock, type GuideLink } from './guide';

const guide = parseIntegrationGuide(integrationGuideMarkdown);

function GuideText({ value, heading = false }: { value: string; heading?: boolean }) {
  return <Type selectable size={heading ? 18 : 15} weight={heading ? '600' : '400'} header={heading} style={{ lineHeight: heading ? 27 : 25 }}>
    {guideSpans(value).map((span, index) => <Type key={index} size={heading ? 18 : span.kind === 'code' ? 14 : 15} mono={span.kind === 'code'} weight={heading || span.kind === 'strong' ? '600' : '400'}>{span.text}</Type>)}
  </Type>;
}

function GuideContent({ block }: { block: GuideBlock }) {
  const { colors, text } = useDesign();
  if (block.kind === 'code') return <View style={{ gap: 8 }}>
    <Type size={12} muted>{text('代码示例', 'Code example')}{block.language ? ` · ${block.language.toUpperCase()}` : ''}</Type>
    <ScrollView horizontal accessibilityLabel={text('可横向滚动的代码示例', 'Horizontally scrollable code example')} contentContainerStyle={{ minWidth: '100%' }}>
      <View style={{ padding: 16, backgroundColor: colors.soft, borderRadius: 12 }}><Type selectable mono size={13} style={{ lineHeight: 21 }}>{block.text}</Type></View>
    </ScrollView>
  </View>;
  if (block.kind === 'table') return <View style={{ gap: 12 }}>
    {block.rows.map((row, index) => <View key={index} style={{ gap: 9, padding: 15, borderRadius: 12, backgroundColor: colors.soft }}>
      {block.headers.map((header, column) => <View key={column} style={{ gap: 3 }}>
        <Type size={12} muted>{header}</Type><GuideText value={row[column] ?? ''} />
      </View>)}
    </View>)}
  </View>;
  if (block.kind === 'bullet') return <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
    <Type size={15} muted style={{ lineHeight: 25 }}>{block.marker === '-' ? '•' : block.marker}</Type><View style={{ flex: 1, minWidth: 0 }}><GuideText value={block.text} /></View>
  </View>;
  return <GuideText value={block.text} heading={block.kind === 'heading'} />;
}

export function IntegrationGuidePage({ onBack }: { onBack: () => void }) {
  const { colors, text } = useDesign();
  const [query, setQuery] = useState('');
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [outbound, setOutbound] = useState<GuideLink | null>(null);
  const [opening, setOpening] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const [scrollContent, setScrollContent] = useState({ key: 0, initialOffset: 0 });
  const mounted = useRef(true);
  const generation = useRef(0);
  const activeScrollKey = useRef(0);
  const chapterOffset = useRef(0);
  const returnOffset = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; activeScrollKey.current += 1; };
  }, []);
  useEffect(() => {
    if (process.env.EXPO_OS !== 'android') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (Keyboard.isVisible()) Keyboard.dismiss(); else onBack();
      return true;
    });
    return () => subscription.remove();
  }, [onBack]);
  const selected = guide.sections.find(section => section.id === sectionId) ?? null;
  const position = selected ? guide.sections.indexOf(selected) : -1;
  const results = findGuideSections(guide.sections, query);
  const sectionTitle = (id: string, title: string) => id === 'overview' ? text('阅读说明与适用范围', 'About this reference') : title;
  const replaceScrollContent = (initialOffset: number) => {
    const key = ++activeScrollKey.current;
    setScrollContent({ key, initialOffset });
  };
  const selectSection = (id: string) => {
    generation.current += 1;
    chapterOffset.current = 0; returnOffset.current = 0;
    replaceScrollContent(0);
    setOutbound(null); setOpening(false); setOpenFailed(false); setSectionId(id);
  };
  const returnToSection = () => {
    generation.current += 1;
    const offset = returnOffset.current;
    chapterOffset.current = offset; replaceScrollContent(offset);
    setOutbound(null); setOpening(false); setOpenFailed(false);
  };
  const closeSheet = () => {
    if (outbound) returnToSection();
    else {
      generation.current += 1; activeScrollKey.current += 1;
      chapterOffset.current = 0; returnOffset.current = 0; setSectionId(null);
    }
  };
  const previewLink = (link: GuideLink) => {
    if (!approvedGuideLink(guide, link.url)) return;
    returnOffset.current = chapterOffset.current;
    replaceScrollContent(0);
    generation.current += 1; setOpenFailed(false); setOpening(false); setOutbound(link);
  };
  const openLink = async () => {
    if (!outbound || opening || !approvedGuideLink(guide, outbound.url)) return;
    const request = ++generation.current;
    setOpening(true); setOpenFailed(false);
    try {
      await Linking.openURL(outbound.url);
      if (mounted.current && generation.current === request) returnToSection();
    } catch {
      if (mounted.current && generation.current === request) setOpenFailed(true);
    } finally {
      if (mounted.current && generation.current === request) setOpening(false);
    }
  };
  return <Page title={text('插件接入规范', 'Integration specification')}
    description={text('选择章节阅读完整规范，或搜索你要核对的规则。', 'Choose a chapter or search for a requirement.')} avoidKeyboard
    action={<Action kind="ghost" icon={ArrowLeft} label={text('返回工作台', 'Back to workbench')} onPress={onBack} />}>
    <View style={{ gap: 9 }}>
      <Tag>{text('离线可读 · 中文参考', 'Offline · Chinese reference')}</Tag>
      <Type size={14} weight="500">{integrationGuideMetadata.title}</Type>
      <Type size={13} muted>{text(`文档基线 ${integrationGuideMetadata.baselineDate} · 收录 ${integrationGuideMetadata.frozenDate}`, `Baseline ${integrationGuideMetadata.baselineDate} · Bundled ${integrationGuideMetadata.frozenDate}`)}</Type>
      <Type size={13} muted>{text('全文随 App 保存，包含原文的目标合同和英文兼容补充。文中能力状态按各自记录日期，不表示全部功能已经开放。', 'The complete source is bundled, including its target contract and English compatibility appendix. Dated capability notes are not a claim that every feature is available.')}</Type>
    </View>
    <Input label={text('搜索规范', 'Search reference')} placeholder={text('如：CIMD、授权、Catalog、幂等', 'CIMD, Catalog, authorization…')} value={query} onChangeText={setQuery} maxLength={120} autoCorrect={false} autoCapitalize="none" />
    <View style={{ gap: 8 }}>
      <View accessibilityLiveRegion="polite"><Type size={13} muted>{text(`${results.length} / ${guide.sections.length} 节`, `${results.length} / ${guide.sections.length} chapters`)}</Type></View>
      {results.map((section, index) => <Row key={section.id} icon={BookOpen} title={sectionTitle(section.id, section.title)} onPress={() => { Keyboard.dismiss(); selectSection(section.id); }} last={index === results.length - 1} />)}
      {!results.length ? <View style={{ gap: 12 }}><Type muted>{text('没有匹配章节，试试更短的关键词。', 'No matching chapters. Try a shorter query.')}</Type><Action kind="secondary" label={text('清除搜索', 'Clear search')} onPress={() => setQuery('')} /></View> : null}
    </View>
    <View style={{ gap: 7 }}><Divider /><Type size={12} muted>{text('来源：仓库内 Q 插件接入规范。内部参考保留为文字，外部标准需确认后打开。', 'Source: the Q repository integration specification. Repository references remain text; external standards open only after confirmation.')}</Type><Type selectable mono size={12} muted>SHA-256 {integrationGuideMetadata.sha256}</Type></View>
    <Sheet visible={!!selected} wide title={outbound ? text('前往标准网站', 'Visit a standards website') : selected ? sectionTitle(selected.id, selected.title) : ''} onClose={closeSheet}
      contentKey={`${selected?.id ?? 'closed'}:${outbound ? 'link' : 'chapter'}:${scrollContent.key}`}
      initialScrollOffset={scrollContent.initialOffset}
      onContentScroll={offset => { if (activeScrollKey.current === scrollContent.key && !outbound) chapterOffset.current = offset; }}
      footer={outbound ? <View style={{ gap: 9 }}><Action icon={ExternalLink} label={opening ? text('正在打开…', 'Opening…') : text('继续打开', 'Continue to website')} disabled={opening} onPress={() => { void openLink(); }} /><Action kind="ghost" label={text('返回规范', 'Back to reference')} onPress={returnToSection} /></View> : selected ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><Action kind="ghost" icon={ArrowLeft} label={text('上一节', 'Previous')} disabled={position === 0} onPress={() => selectSection(guide.sections[position - 1].id)} /><Action kind="secondary" icon={ArrowRight} label={text('下一节', 'Next')} disabled={position === guide.sections.length - 1} onPress={() => selectSection(guide.sections[position + 1].id)} /></View> : undefined}>
      {outbound ? <>
        <Type>{text('即将离开小Q，查看以下外部标准资料：', 'You are leaving Q to read this standards reference:')}</Type>
        <Type weight="500">{outbound.title}</Type><Type selectable size={13}>{outbound.url}</Type>
        <Type muted>{text('该网站由标准维护方管理，不会自动登录或提交插件材料。', 'The standards maintainer controls the site. No login or plugin submission is performed automatically.')}</Type>
        {openFailed ? <View accessibilityLiveRegion="polite"><Type selectable color={colors.danger}>{text('暂时无法打开。可以重试，或长按上方链接复制。', 'Unable to open. Retry or select the URL above to copy it.')}</Type></View> : null}
      </> : selected ? <>
        <Type size={12} muted>{text(`第 ${position + 1} / ${guide.sections.length} 节 · 中文参考`, `Chapter ${position + 1} / ${guide.sections.length} · Chinese source`)}</Type>
        {selected.blocks.map((block, index) => <GuideContent key={`${selected.id}-${index}`} block={block} />)}
        {selected.links.length ? <View style={{ gap: 8 }}><Divider /><Type size={16} weight="600" header>{text('本节外部标准参考', 'External standards in this chapter')}</Type>{selected.links.map((link, index) => <Row key={link.url} title={link.title} subtitle={new URL(link.url).hostname} onPress={() => previewLink(link)} right={<ExternalLink size={18} color={colors.accent} />} last={index === selected.links.length - 1} />)}</View> : null}
      </> : null}
    </Sheet>
  </Page>;
}
