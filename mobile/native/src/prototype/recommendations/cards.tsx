import { ActivityIndicator, Pressable, View } from 'react-native';
import { ArrowUpRight, ChevronRight, Layers3 } from 'lucide-react-native';
import { Type, useDesign } from '../design';
import { selectionFeedback } from '../motion';
import { recommendationError, visibleCandidates, type Recommendation, type RecommendationCandidate } from './core';
import type { AppNavigationAction } from '../app-assistant/core';

export function RecommendationCards({ record, actions, coveredModules, busyId, disabled = false, error = '', onSelect }: {
  record: Recommendation; actions?: AppNavigationAction[]; busyId?: string | null; disabled?: boolean; error?: string;
  coveredModules?: readonly string[];
  onSelect: (candidate: RecommendationCandidate) => void;
}) {
  const { colors, text } = useDesign();
  const candidates = visibleCandidates(record, actions, coveredModules);
  if (!candidates.length) return null;
  const label = (candidate: RecommendationCandidate) => {
    const labels = { ready: ['继续处理', 'Continue'], connect: ['连接服务', 'Connect service'], authorize: ['完成授权', 'Authorize'], review: ['确认更新', 'Review update'], unavailable: ['暂不可用', 'Unavailable'] } as const;
    const value = labels[candidate.access];
    return text(value[0], value[1]);
  };
  return <View testID="recommendation-cards" style={{ gap: 10, paddingTop: 6 }}>
    <Type size={12} muted>{text('适合这次需求', 'For this request')}</Type>
    {candidates.map((candidate, index) => {
      const waiting = busyId === candidate.id;
      const unavailable = candidate.access === 'unavailable';
      const inactive = disabled || Boolean(busyId) || unavailable;
      return <View key={candidate.id} style={{ padding: index === 0 ? 18 : 14, borderRadius: 20, borderCurve: 'continuous', backgroundColor: colors.surface, gap: 10,
        borderWidth: 1, borderColor: colors.line }}>
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
          <View accessibilityElementsHidden style={{ width: 36, height: 36, borderRadius: 11, backgroundColor: colors.accentBg, alignItems: 'center', justifyContent: 'center' }}><Layers3 size={18} color={colors.accent} strokeWidth={1.6} /></View>
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <Type size={16} weight="600">{candidate.title}</Type>
            <Type size={13} muted>{candidate.reason || candidate.description}</Type>
          </View>
        </View>
        {candidate.price_note ? <Type size={12} muted>{candidate.price_note}</Type> : null}
        <Pressable accessibilityRole="button" accessibilityLabel={`${label(candidate)} · ${candidate.title}`} accessibilityState={{ disabled: inactive, busy: waiting }} disabled={inactive}
          onPress={() => { selectionFeedback(); onSelect(candidate); }} style={({ pressed }) => ({ minHeight: 48, paddingVertical: 11, paddingHorizontal: 14, borderRadius: 13,
            backgroundColor: index === 0 && !unavailable ? colors.accent : colors.soft, opacity: inactive ? 0.6 : pressed ? 0.8 : 1,
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 })}>
          <Type size={14} weight="500" color={index === 0 && !unavailable ? colors.onAccent : colors.ink}>{waiting ? text('正在打开…', 'Opening…') : label(candidate)}</Type>
          {waiting ? <ActivityIndicator color={index === 0 ? colors.onAccent : colors.accent} /> : index === 0 ? <ArrowUpRight size={17} color={unavailable ? colors.muted : colors.onAccent} /> : <ChevronRight size={17} color={colors.muted} />}
        </Pressable>
      </View>;
    })}
    {error ? <View accessibilityRole="alert"><Type size={13} color={colors.danger}>{recommendationError(error, text)}</Type></View> : null}
  </View>;
}
