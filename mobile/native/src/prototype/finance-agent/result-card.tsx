import { useState, type ReactNode } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { ArrowUpRight, ChevronDown, ChevronUp } from 'lucide-react-native';
import { Type, useDesign } from '../design';
import type { BillSummary, FinanceResult, InstallmentResult, SavingsResult } from './core';
import { financeText, formatFinanceMoney, formatFinanceRate, INSTALLMENT_ASSUMPTIONS, TASK_LABELS } from './copy';

function DetailRow({ label, value, emphasized = false }: { label: string; value: string; emphasized?: boolean }) {
  const { colors } = useDesign();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, paddingVertical: 8 }}>
      <Type size={13} muted style={{ flexShrink: 1 }} selectable>{label}</Type>
      <Type size={14} weight={emphasized ? '600' : '500'} color={emphasized ? colors.accent : colors.ink} style={{ fontVariant: ['tabular-nums'] }} selectable>{value}</Type>
    </View>
  );
}

function ResultToggle({ label, expanded, onPress, testID }: { label: string; expanded: boolean; onPress: () => void; testID: string }) {
  const { colors } = useDesign();
  const Icon = expanded ? ChevronUp : ChevronDown;
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded }} onPress={onPress}
      style={({ pressed }) => ({ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, opacity: pressed ? 0.65 : 1 })}>
      <Type size={13} color={colors.accent} weight="500" style={{ flexShrink: 1 }}>{label}</Type>
      <Icon size={17} color={colors.accent} accessible={false} />
    </Pressable>
  );
}

function Hero({ label, children, subtitle }: { label: string; children: ReactNode; subtitle?: string }) {
  const { colors } = useDesign();
  return (
    <View style={{ gap: 5, paddingVertical: 8 }}>
      <Type size={13} muted selectable>{label}</Type>
      <Type size={27} weight="600" color={colors.accent} style={{ fontVariant: ['tabular-nums'] }} selectable>{children}</Type>
      {subtitle ? <Type size={13} muted selectable>{subtitle}</Type> : null}
    </View>
  );
}

function BillsResult({ result }: { result: BillSummary }) {
  const { colors, locale, text } = useDesign();
  const [showEntries, setShowEntries] = useState(false);
  const [visibleEntries, setVisibleEntries] = useState(20);
  const [visibleCategories, setVisibleCategories] = useState(20);
  const money = (minor: number) => formatFinanceMoney(minor, result.currency, locale);
  return (
    <View style={{ gap: 12 }}>
      <Hero label={text('本次记录结余', 'Net of entered records')} subtitle={text(`${result.entries.length} 笔记录 · 收入减支出`, `${result.entries.length} entries · income less expenses`)}>{money(result.netMinor)}</Hero>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
        <View style={{ flexGrow: 1, gap: 4 }}>
          <Type size={12} muted>{text('收入', 'Income')}</Type>
          <Type size={16} weight="600" selectable style={{ fontVariant: ['tabular-nums'] }}>{money(result.totalIncomeMinor)}</Type>
        </View>
        <View style={{ flexGrow: 1, gap: 4 }}>
          <Type size={12} muted>{text('支出', 'Expenses')}</Type>
          <Type size={16} weight="600" selectable style={{ fontVariant: ['tabular-nums'] }}>{money(result.totalExpenseMinor)}</Type>
        </View>
      </View>
      {result.warnings.map((warning, index) => (
        <View key={`${warning.code}-${index}`} style={{ backgroundColor: colors.soft, borderRadius: 10, padding: 12 }}>
          <Type size={13} color={colors.danger} selectable>{text(`第 ${warning.lines.join('、')} 行内容相同，已分别计入。请核对是否重复。`, `Lines ${warning.lines.join(', ')} are identical and counted separately. Check for duplicates.`)}</Type>
        </View>
      ))}
      <View style={{ borderTopWidth: 1, borderColor: colors.line, paddingTop: 8 }}>
        <Type size={13} weight="600">{text('分类汇总', 'By category')}</Type>
        {result.categories.slice(0, visibleCategories).map((category) => <DetailRow key={`${category.direction}-${category.category}`} label={`${category.direction === 'income' ? text('收入', 'Income') : text('支出', 'Expense')} · ${category.category} · ${category.count} ${text('笔', 'entries')}`} value={money(category.amountMinor)} />)}
        {visibleCategories < result.categories.length ? <ResultToggle testID="finance-more-categories" expanded={false} label={text(`再显示 ${Math.min(20, result.categories.length - visibleCategories)} 个分类`, `Show ${Math.min(20, result.categories.length - visibleCategories)} more categories`)} onPress={() => setVisibleCategories(visibleCategories + 20)} /> : null}
      </View>
      <View style={{ borderTopWidth: 1, borderColor: colors.line }}>
        <ResultToggle testID="finance-bill-details" label={text(showEntries ? '收起逐笔明细' : `查看逐笔明细（${result.entries.length}）`, showEntries ? 'Hide individual entries' : `View individual entries (${result.entries.length})`)} expanded={showEntries} onPress={() => setShowEntries(!showEntries)} />
        {showEntries ? <View>
          {result.entries.slice(0, visibleEntries).map((entry) => <DetailRow key={entry.line} label={text(`第 ${entry.line} 行 · ${entry.direction === 'income' ? '收入' : '支出'} · ${entry.category}`, `Line ${entry.line} · ${entry.direction} · ${entry.category}`)} value={money(entry.amountMinor)} />)}
          {visibleEntries < result.entries.length ? <ResultToggle testID="finance-more-bills" expanded={false} label={text(`再显示 ${Math.min(20, result.entries.length - visibleEntries)} 笔`, `Show ${Math.min(20, result.entries.length - visibleEntries)} more`)} onPress={() => setVisibleEntries(visibleEntries + 20)} /> : null}
        </View> : null}
      </View>
      <Type size={12} muted selectable>{text('这是输入记录的整理结果，不是银行余额或完整账户账单。', 'This summarizes your entries; it is not a bank balance or a complete account statement.')}</Type>
    </View>
  );
}

function InstallmentsResult({ result }: { result: InstallmentResult }) {
  const { colors, locale, text } = useDesign();
  const [showPayments, setShowPayments] = useState(false);
  const money = (minor: number) => formatFinanceMoney(minor, result.currency, locale);
  return (
    <View style={{ gap: 12 }}>
      <Hero label={text('总还款额', 'Total repayment')} subtitle={text('本金 + 已填写的总费用', 'Principal + entered total fees')}>{money(result.totalRepaymentMinor)}</Hero>
      <View>
        <DetailRow label={text('借款本金', 'Principal')} value={money(result.principalMinor)} />
        <DetailRow label={text('总费用', 'Total fees')} value={money(result.feeTotalMinor)} />
        <DetailRow label={text('期数', 'Term')} value={text(`${result.months} 个月`, `${result.months} months`)} />
        <DetailRow label={text('每期还款', 'Payment amount')} value={result.minPaymentMinor === result.maxPaymentMinor ? money(result.minPaymentMinor) : `${money(result.minPaymentMinor)} – ${money(result.maxPaymentMinor)}`} />
        <DetailRow label={text('测算月利率', 'Calculated monthly rate')} value={formatFinanceRate(result.monthlyRate)} />
        <DetailRow label={text('测算实际年化利率', 'Calculated effective annual rate')} value={formatFinanceRate(result.effectiveAnnualRate)} emphasized />
      </View>
      <View style={{ backgroundColor: colors.soft, borderRadius: 12, padding: 14, gap: 6 }}>
        <Type size={13} weight="600">{text('计算假设', 'Calculation assumptions')}</Type>
        <Type size={12} muted selectable>{financeText(INSTALLMENT_ASSUMPTIONS, locale)}</Type>
        <Type size={12} muted selectable>{text('年化 = (1 + 月利率)¹² − 1；页面百分比保留两位小数。', 'Annual rate = (1 + monthly rate)¹² − 1. Displayed percentages are rounded to two decimals.')}</Type>
      </View>
      <View style={{ borderTopWidth: 1, borderColor: colors.line }}>
        <ResultToggle testID="finance-payment-details" label={text(showPayments ? '收起还款明细' : '查看每期还款明细', showPayments ? 'Hide payment schedule' : 'View payment schedule')} expanded={showPayments} onPress={() => setShowPayments(!showPayments)} />
        {showPayments ? result.payments.map((payment) => <DetailRow key={payment.month} label={text(`第 ${payment.month} 个月`, `Month ${payment.month}`)} value={money(payment.amountMinor)} />) : null}
      </View>
    </View>
  );
}

function SavingsResultView({ result }: { result: SavingsResult }) {
  const { colors, locale, text } = useDesign();
  const money = (minor: number) => formatFinanceMoney(minor, result.currency, locale);
  const progress = result.targetMinor === 0 ? 1 : Math.min(1, result.currentMinor / result.targetMinor);
  const heading = result.alreadyReached
    ? text('已达到目标', 'Goal reached')
    : result.reachable ? text(`${result.monthsToTarget} 个月`, `${result.monthsToTarget} months`) : text('暂时无法达到', 'No completion date');
  return (
    <View style={{ gap: 14 }}>
      <Hero label={text('预计达到目标', 'Estimated time to goal')} subtitle={text('不计利息或投资收益', 'Excludes interest and investment returns')}>{heading}</Hero>
      <View accessibilityRole="progressbar" accessibilityLabel={text('储蓄目标完成度', 'Savings goal progress')} accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }} style={{ height: 6, borderRadius: 3, backgroundColor: colors.line, overflow: 'hidden' }}>
        <View style={{ height: '100%', width: `${progress * 100}%`, backgroundColor: colors.accent, borderRadius: 3 }} />
      </View>
      <View>
        <DetailRow label={text('目标金额', 'Target')} value={money(result.targetMinor)} />
        <DetailRow label={text('现有储蓄', 'Current savings')} value={money(result.currentMinor)} />
        <DetailRow label={text('还需存入', 'Amount remaining')} value={money(result.remainingMinor)} emphasized />
        <DetailRow label={text('每月存入', 'Monthly contribution')} value={money(result.monthlyMinor)} />
      </View>
      <Type size={12} muted selectable>{result.alreadyReached
        ? text('现有储蓄已经覆盖目标金额。', 'Your current savings already cover the target.')
        : result.reachable
          ? text('假设从下个月开始每月存入同样金额，期间不提取、不增加费用；月数向上取整。', 'Assumes the same contribution each month, starting next month, with no withdrawals or additional costs. Months are rounded up.')
          : text('每月存入为 0 时，剩余目标不会减少。调整每月存入后可重新计算。', 'With a monthly contribution of 0, the remaining target will not decrease. Enter a monthly contribution to recalculate.')}</Type>
    </View>
  );
}

export function FinanceResultCard({ result }: { result: FinanceResult }) {
  const { colors, locale, text, notify } = useDesign();
  return (
    <View testID={`finance-result-${result.kind}`} style={{ width: '100%', minWidth: 0, padding: 18, borderRadius: 18, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, gap: 14 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Type size={13} weight="600">{financeText(TASK_LABELS[result.kind], locale)}</Type>
        <Type size={11} color={colors.accent}>{text('本地结果', 'Local result')}</Type>
      </View>
      {result.kind === 'bills' ? <BillsResult result={result} /> : null}
      {result.kind === 'installments' ? <InstallmentsResult result={result} /> : null}
      {result.kind === 'savings' ? <SavingsResultView result={result} /> : null}
      {result.kind === 'knowledge' ? <View style={{ gap: 12 }}>
        <Type size={18} weight="600" selectable>{financeText(result.entry.title, locale)}</Type>
        <Type size={14} selectable>{financeText(result.entry.detail, locale)}</Type>
        <View style={{ borderTopWidth: 1, borderColor: colors.line, paddingTop: 8 }}>
          <Type size={12} muted>{text('参考来源', 'References')}</Type>
          {result.entry.sources.map((source) => <Pressable key={source.url} testID={`finance-source-${result.entry.id}`} accessibilityRole="link" accessibilityLabel={text(`在浏览器查看：${financeText(source.title, locale)}`, `Open in browser: ${financeText(source.title, locale)}`)} onPress={() => {
            void Linking.openURL(source.url).catch(() => notify(text('暂时无法打开来源链接。', 'The reference link could not be opened.')));
          }} style={({ pressed }) => ({ minHeight: 48, flexDirection: 'row', gap: 8, alignItems: 'center', opacity: pressed ? 0.65 : 1 })}>
            <Type size={12} color={colors.accent} style={{ flex: 1 }}>{financeText(source.title, locale)}</Type>
            <ArrowUpRight size={15} color={colors.accent} accessible={false} />
          </Pressable>)}
          <Type size={11} muted selectable>{text(`资料核对：${result.entry.checkedAt}`, `Sources checked: ${result.entry.checkedAt}`)}</Type>
        </View>
      </View> : null}
    </View>
  );
}
