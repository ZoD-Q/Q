import { memo, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Linking, PanResponder, View } from 'react-native';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import { Action, Type, useDesign } from '../design';
import { decodeResourceImage, decodeResult, pluginError, publicHttps, type ResourceLink } from './core';
import { isConversationalText } from './presentation';
import { pluginRequest } from './client';

export function ResourceViewer({ token, connectionId, resources, compact = false }: { token: string; connectionId: string; resources: ResourceLink[]; compact?: boolean }) {
  const { text, colors, phone } = useDesign();
  const [index, setIndex] = useState(0);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ uri: string; data?: string; error?: unknown } | null>(null);
  const safeIndex = Math.min(index, Math.max(0, resources.length - 1));
  const current = resources[safeIndex];
  const resourceUri = current?.uri;
  const swipe = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 20 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
    onPanResponderRelease: (_, gesture) => {
      const next = Math.max(0, Math.min(resources.length - 1, safeIndex + (gesture.dx < -50 ? 1 : gesture.dx > 50 ? -1 : 0)));
      if (next !== safeIndex) { setState(null); setIndex(next); }
    },
  }), [safeIndex, resources.length]);
  useEffect(() => {
    if (!resourceUri) return;
    const controller = new AbortController();
    void pluginRequest(token, `/v1/plugins/connections/${connectionId}/resources/read`, decodeResourceImage, {
      method: 'POST', body: { uri: resourceUri }, signal: controller.signal,
    }).then(data => { if (!controller.signal.aborted) setState({ uri: `${token}:${connectionId}:${resourceUri}`, data }); })
      .catch(error => { if (!controller.signal.aborted) setState({ uri: `${token}:${connectionId}:${resourceUri}`, error }); });
    return () => controller.abort();
  }, [token, connectionId, resourceUri, retry]);
  if (!current) return null;
  const result = state?.uri === `${token}:${connectionId}:${current.uri}` ? state : null;
  const links = [...new Set((current.description ?? '').match(/https:\/\/[^\s<>]+/g) ?? [])].filter(link => publicHttps(link));
  return <View style={{ gap: 12 }}>
    <View {...swipe.panHandlers} style={{ height: phone ? 400 : 520, backgroundColor: colors.soft, borderRadius: 18, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
      {result?.data ? <Image accessibilityLabel={current.title ?? current.name} source={{ uri: result.data }} onError={() => setState({ uri: `${token}:${connectionId}:${current.uri}`, error: 'PLUGIN_IMAGE_DECODE' })} resizeMode="contain" style={{ width: '100%', height: '100%' }} />
        : result?.error ? <View style={{ padding: 24, gap: 12 }}><Type color={colors.danger}>{pluginError(result.error, text)}</Type><Action label={text('重新读取图片', 'Reload image')} onPress={() => setRetry(value => value + 1)} /></View>
          : <ActivityIndicator accessibilityLabel={text('正在读取图片', 'Loading image')} color={colors.accent} />}
    </View>
    {(!compact || resources.length > 1) && <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <Action kind="ghost" icon={ChevronLeft} label={text('上一张', 'Previous')} disabled={safeIndex === 0} onPress={() => { setState(null); setIndex(safeIndex - 1); }} />
      <Type muted>{safeIndex + 1} / {resources.length}</Type>
      <Action kind="ghost" icon={ChevronRight} label={text('下一张', 'Next')} disabled={safeIndex >= resources.length - 1} onPress={() => { setState(null); setIndex(safeIndex + 1); }} />
    </View>}
    <Type selectable weight="500">{current.title ?? current.name}</Type>
    {!!current.description && (!compact || isConversationalText(current.description)) && <Type selectable size={12} muted>{current.description}</Type>}
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{links.slice(0, 3).map((url, i) => <Action key={url} kind="ghost" label={text(`打开来源 ${i + 1}`, `Open source ${i + 1}`)} onPress={() => { void Linking.openURL(url).catch(() => undefined); }} />)}</View>
  </View>;
}

function InlineImage({ data, mimeType }: { data: string; mimeType: string }) {
  const { text, colors } = useDesign();
  const [failure, setFailure] = useState<string | null>(null);
  const uri = `data:${mimeType};base64,${data}`;
  if (failure === uri) return <Type size={13} color={colors.danger}>{pluginError('PLUGIN_IMAGE_DECODE', text)}</Type>;
  return <Image accessibilityLabel={text('插件返回图片', 'Image returned by plugin')} source={{ uri }} onError={() => setFailure(uri)} resizeMode="contain" style={{ height: 360, width: '100%' }} />;
}

export const PluginResultView = memo(function PluginResultView({ value, token, connectionId, compact = false, mediaOnly = false }: { value: unknown; token: string; connectionId: string; compact?: boolean; mediaOnly?: boolean }) {
  const { text, colors } = useDesign();
  const [showData, setShowData] = useState(false);
  let result;
  try { result = decodeResult(value); } catch (error) { return <Type color={colors.danger}>{pluginError(error, text)}</Type>; }
  const resources = result.content.filter((item): item is ResourceLink => item.type === 'resource_link' && !!item.mimeType?.startsWith('image/'));
  if (mediaOnly && !resources.length && !result.content.some(item => item.type === 'image')) return null;
  return <View style={{ gap: 18 }}>
    {!mediaOnly && result.isError && <Type color={colors.danger}>{compact ? text('这项操作未完成', 'This action did not complete') : text('插件报告执行错误', 'The plugin reported a tool error')}</Type>}
    {result.content.filter(item => item.type !== 'resource_link').map((item, index) => item.type === 'text'
      ? mediaOnly || (compact && !isConversationalText(item.text)) ? null : <Type key={index} selectable size={14}>{item.text}</Type>
      : item.type === 'image' ? <InlineImage key={index} data={item.data} mimeType={item.mimeType} /> : null)}
    {resources.length > 0 && <ResourceViewer key={resources.map(item => item.uri).join('|')} resources={resources} compact={compact || mediaOnly} token={token} connectionId={connectionId} />}
    {!mediaOnly && result.content.filter((item): item is ResourceLink => item.type === 'resource_link' && !item.mimeType?.startsWith('image/')).map(item => <View key={item.uri} style={{ gap: 5 }}>
      {compact && publicHttps(item.uri) && !item.mimeType?.toLowerCase().includes('html')
        ? <Action kind="ghost" style={{ minHeight: 48 }} label={item.title ?? item.name} onPress={() => { void Linking.openURL(publicHttps(item.uri)!).catch(() => undefined); }} />
        : <Type selectable>{item.title ?? item.name}</Type>}
      {!compact && <Type selectable muted size={12}>{item.uri}</Type>}
      {item.description && (!compact || isConversationalText(item.description)) && <Type selectable size={13}>{item.description}</Type>}
    </View>)}
    {!compact && !mediaOnly && result.structuredContent !== undefined && <View style={{ gap: 10 }}><Action kind="ghost" label={showData ? text('收起数据', 'Hide data') : text('查看返回数据', 'View returned data')} onPress={() => setShowData(value => !value)} />{showData && <><Type selectable size={12}>{JSON.stringify(result.structuredContent, null, 2).slice(0, 32000)}</Type>{JSON.stringify(result.structuredContent, null, 2).length > 32000 && <Type size={12} muted>{text('内容较长，此处展示前 32,000 个字符。', 'Showing the first 32,000 characters.')}</Type>}</>}</View>}
  </View>;
});
