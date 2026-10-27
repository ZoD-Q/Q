import { useState } from 'react';
import { AccessibilityInfo, Keyboard, Pressable, View, type TextInputProps } from 'react-native';
import { BookOpen, Calculator, Check, ChevronRight, FileText, LockKeyhole, PiggyBank, type LucideIcon } from 'lucide-react-native';
import { Input, Sheet, Type, useDesign } from '../design';
import { calculateInstallments, calculateSavings, summarizeBills, type Currency, type FinanceInputError, type FinanceResult } from './core';
import type { LocalFinanceTurn } from './conversation';
import { FINANCE_KNOWLEDGE, searchFinanceKnowledge } from './knowledge';
import { BILL_EXAMPLE, FINANCE_PRIVACY, INSTALLMENT_ASSUMPTIONS, TASK_LABELS, createFinanceTurn, financeText, type FinanceTask } from './copy';
import { FinanceResultCard } from './result-card';

export type { FinanceTask } from './copy';

export interface FinanceTaskSheetProps {
  visible: boolean;
  initialTask?: FinanceTask;
  onClose: () => void;
  onSubmit: (turn: LocalFinanceTurn) => boolean;
}

const TASKS: { id: FinanceTask; icon: LucideIcon }[] = [
  { id: 'bills', icon: FileText },
  { id: 'installments', icon: Calculator },
  { id: 'savings', icon: PiggyBank },
  { id: 'knowledge', icon: BookOpen },
];

function Errors({ errors }: { errors: FinanceInputError[] }) {
  const { colors, locale, text } = useDesign();
  if (errors.length === 0) return null;
  return (
    <View accessibilityLiveRegion="polite" style={{ gap: 5 }}>
      {errors.map((error, index) => <View key={`${error.field}-${error.line}-${error.code}-${index}`} testID={`finance-error-${error.field ?? 'input'}-${error.line ?? index}`}>
        <Type size={13} color={colors.danger} selectable>{error.line !== undefined ? text(`第 ${error.line} 行：`, `Line ${error.line}: `) : ''}{financeText(error.message, locale)}</Type>
      </View>)}
    </View>
  );
}

function MoneyField({ label, value, onChangeText, field, errors, hint, currency, ...props }: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  field: string;
  errors: FinanceInputError[];
  hint?: string;
  currency: Currency;
} & Omit<TextInputProps, 'value' | 'onChangeText'>) {
  return (
    <View style={{ gap: 7 }}>
      <Input label={`${label} · ${currency}`} value={value} onChangeText={onChangeText} hint={hint} keyboardType="decimal-pad" autoCorrect={false} autoCapitalize="none" testID={`finance-${field}`} {...props} />
      <Errors errors={errors.filter((error) => error.field === field)} />
    </View>
  );
}

function FinanceTaskForm({ initialTask = 'bills', onClose, onSubmit }: Omit<FinanceTaskSheetProps, 'visible'>) {
  const { colors, locale, text } = useDesign();
  const [task, setTask] = useState<FinanceTask>(initialTask);
  const [currency, setCurrency] = useState<Currency>('CNY');
  const [bills, setBills] = useState('');
  const [exampleLoaded, setExampleLoaded] = useState(false);
  const [principal, setPrincipal] = useState('');
  const [feeTotal, setFeeTotal] = useState('');
  const [months, setMonths] = useState('');
  const [target, setTarget] = useState('');
  const [current, setCurrent] = useState('');
  const [monthly, setMonthly] = useState('');
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [knowledgeId, setKnowledgeId] = useState<string | null>(null);
  const [errors, setErrors] = useState<FinanceInputError[]>([]);
  const [submitBlocked, setSubmitBlocked] = useState(false);
  const knowledgeEntries = knowledgeQuery.trim() ? searchFinanceKnowledge(knowledgeQuery) : FINANCE_KNOWLEDGE;
  const selectedKnowledge = FINANCE_KNOWLEDGE.find((entry) => entry.id === knowledgeId);

  function close() {
    Keyboard.dismiss();
    onClose();
  }

  function editField(field: string, setter: (value: string) => void, value: string) {
    setter(value);
    setErrors((previous) => previous.filter((error) => error.field !== field));
    setSubmitBlocked(false);
  }

  function submit() {
    setSubmitBlocked(false);
    let result: FinanceResult;
    if (task === 'knowledge') {
      if (!selectedKnowledge) return;
      result = { kind: 'knowledge', entry: selectedKnowledge };
    } else {
      const outcome = task === 'bills'
        ? summarizeBills(bills, currency)
        : task === 'installments'
          ? calculateInstallments({ currency, principal, feeTotal, months })
          : calculateSavings({ currency, target, current, monthly });
      if (!outcome.ok) {
        setErrors(outcome.errors);
        AccessibilityInfo.announceForAccessibility(text('请检查输入，下方已标出需要修改的位置。', 'Please check your entries. Fields requiring changes are marked.'));
        return;
      }
      result = outcome.value;
    }
    setErrors([]);
    const turn = createFinanceTurn(result, locale);
    if (task === 'bills' && exampleLoaded) {
      turn.prompt = text('整理这份虚构示例账单。', 'Organize these fictional example bills.');
      turn.answer = text('以下来自虚构示例（可含你的修改），不是实际银行账单。\n\n', 'These results use fictional examples, possibly edited by you, not actual bank statements.\n\n') + turn.answer;
    }
    if (onSubmit(turn)) close();
    else setSubmitBlocked(true);
  }

  const submitLabel = task === 'bills'
    ? text('整理到本地对话', 'Organize in local chat')
    : task === 'knowledge'
      ? text('添加到本地对话', 'Add to local chat')
      : text('计算到本地对话', 'Calculate in local chat');

  return (
    <Sheet visible title={text('财务工具', 'Financial tools')} onClose={close} footer={
      <View style={{ gap: 8 }}>
        {errors.length ? <Type size={12} color={colors.danger} selectable>{text(`有 ${errors.length} 处输入需要检查；已保留你的内容。`, `${errors.length} ${errors.length === 1 ? 'entry needs' : 'entries need'} attention. Your input is preserved.`)}</Type> : null}
        {submitBlocked ? <View accessibilityLiveRegion="polite"><Type size={12} color={colors.danger} selectable>{text('当前正在处理其他操作，请稍后再试。输入已保留。', 'Another operation is in progress. Try again shortly; your input is preserved.')}</Type></View> : null}
        <Pressable testID="finance-submit" accessibilityRole="button" accessibilityLabel={submitLabel} accessibilityState={{ disabled: task === 'knowledge' && !selectedKnowledge }} disabled={task === 'knowledge' && !selectedKnowledge} onPress={submit}
          style={({ pressed }) => ({ minHeight: 48, paddingHorizontal: 18, paddingVertical: 12, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent, opacity: task === 'knowledge' && !selectedKnowledge ? 0.4 : pressed ? 0.8 : 1 })}>
          <Type size={14} weight="500" color={colors.onAccent}>{submitLabel}</Type>
        </Pressable>
      </View>
    }>
      <View testID="finance-task-sheet" style={{ gap: 20 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <LockKeyhole size={16} strokeWidth={1.7} color={colors.accent} accessible={false} />
          <Type size={13} color={colors.accent} style={{ flex: 1 }}>{text('本地整理与计算 · 不自动发送给 AI', 'Local calculations · never sent to AI automatically')}</Type>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {TASKS.map(({ id, icon: Icon }) => <Pressable key={id} testID={`finance-task-${id}`} accessibilityRole="button" accessibilityLabel={financeText(TASK_LABELS[id], locale)} accessibilityState={{ selected: task === id }} onPress={() => {
            setTask(id); setErrors([]); setSubmitBlocked(false); Keyboard.dismiss();
          }} style={({ pressed }) => ({ width: '48%', flexGrow: 1, minHeight: 48, padding: 12, borderRadius: 12, flexDirection: 'row', gap: 8, alignItems: 'center', backgroundColor: task === id ? colors.accentBg : colors.soft, opacity: pressed ? 0.7 : 1 })}>
            <Icon size={17} color={task === id ? colors.accent : colors.muted} strokeWidth={1.7} accessible={false} />
            <Type size={13} weight={task === id ? '600' : '400'} color={task === id ? colors.accent : colors.ink} style={{ flex: 1 }}>{financeText(TASK_LABELS[id], locale)}</Type>
          </Pressable>)}
        </View>
        {task !== 'knowledge' ? <View style={{ gap: 8 }}>
          <Type size={13} weight="500">{text('本次币种', 'Currency for this task')}</Type>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {(['CNY', 'HKD'] as const).map((value) => <Pressable key={value} testID={`finance-currency-${value}`} accessibilityRole="radio" accessibilityLabel={value === 'CNY' ? text('人民币 CNY', 'Chinese yuan CNY') : text('港币 HKD', 'Hong Kong dollar HKD')} accessibilityState={{ checked: currency === value }} onPress={() => setCurrency(value)}
              style={({ pressed }) => ({ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 12, backgroundColor: currency === value ? colors.accentBg : colors.soft, opacity: pressed ? 0.7 : 1 })}>
              <Type size={13} color={currency === value ? colors.accent : colors.ink}>{value === 'CNY' ? text('人民币 CNY', 'CNY') : text('港币 HKD', 'HKD')}</Type>
              {currency === value ? <Check size={15} color={colors.accent} accessible={false} /> : null}
            </Pressable>)}
          </View>
          <Type size={12} muted>{text('金额填写纯数字，最多两位小数，不加逗号。使用同一币种，不做汇率换算。', 'Use plain amounts with up to two decimal places, without commas. Use one currency; no currency conversion.')}</Type>
        </View> : null}
        {task === 'bills' ? <View style={{ gap: 12 }}>
          <Input testID="finance-bills" label={text('粘贴或输入账单', 'Paste or enter bills')} value={bills} onChangeText={(value) => { setBills(value); setErrors([]); setSubmitBlocked(false); if (!value) setExampleLoaded(false); }} multiline autoCorrect={false} autoCapitalize="none" style={{ minHeight: 160 }} placeholder={text('收入 工资 12000\n支出 房租 3000', 'income Salary 12000\nexpense Rent 3000')} hint={text('每行一笔：收入/支出 + 分类 + 金额，以空格分隔；最多 500 笔。金额不加币种符号。', 'One entry per line: income/expense + category + amount, separated by spaces; up to 500 entries. Omit currency symbols.')} />
          <Errors errors={errors} />
          <Pressable testID="finance-load-example" accessibilityRole="button" accessibilityLabel={text('填入虚构示例，替换当前输入', 'Replace current input with fictional examples')} onPress={() => { setBills(financeText(BILL_EXAMPLE, locale)); setExampleLoaded(true); setErrors([]); setSubmitBlocked(false); }} style={({ pressed }) => ({ minHeight: 48, borderRadius: 12, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.soft, opacity: pressed ? 0.7 : 1, paddingHorizontal: 12 })}>
            <Type size={13} color={colors.accent}>{text('填入虚构示例', 'Use fictional examples')}</Type>
          </Pressable>
          <Type size={12} muted selectable>{exampleLoaded ? text('当前内容为虚构示例，不是银行数据；可直接修改。', 'These are fictional examples, not bank data. You can edit them.') : text('只整理输入的记录，不连接银行。示例按钮会替换当前内容。', 'Only entered records are processed. No bank connection. The example button replaces current input.')}</Type>
        </View> : null}
        {task === 'installments' ? <View style={{ gap: 18 }}>
          <MoneyField label={text('借款本金', 'Principal')} field="principal" value={principal} onChangeText={(value) => editField('principal', setPrincipal, value)} currency={currency} errors={errors} placeholder="0.00" />
          <MoneyField label={text('总费用', 'Total fees')} field="feeTotal" value={feeTotal} onChangeText={(value) => editField('feeTotal', setFeeTotal, value)} currency={currency} errors={errors} placeholder="0.00" hint={text('填入整个分期期间的利息与手续费合计；没有费用请填 0。', 'Enter all interest and fees for the full term. Enter 0 if there are none.')} />
          <View style={{ gap: 7 }}>
            <Input testID="finance-months" label={text('期数（每月一期）', 'Term (monthly payments)')} value={months} onChangeText={(value) => editField('months', setMonths, value)} keyboardType="number-pad" placeholder={text('1–60 个月', '1–60 months')} hint={text('填写 1–60 的整数。', 'Enter a whole number from 1 to 60.')} />
            <Errors errors={errors.filter((error) => error.field === 'months')} />
          </View>
          <Type size={12} muted selectable>{financeText(INSTALLMENT_ASSUMPTIONS, locale)}</Type>
          <Errors errors={errors.filter((error) => !['principal', 'feeTotal', 'months'].includes(error.field ?? ''))} />
        </View> : null}
        {task === 'savings' ? <View style={{ gap: 18 }}>
          <MoneyField label={text('目标金额', 'Target amount')} field="target" value={target} onChangeText={(value) => editField('target', setTarget, value)} currency={currency} errors={errors} placeholder="0.00" />
          <MoneyField label={text('现有储蓄', 'Current savings')} field="current" value={current} onChangeText={(value) => editField('current', setCurrent, value)} currency={currency} errors={errors} placeholder="0.00" hint={text('没有现有储蓄请填 0。', 'Enter 0 if you have no savings yet.')} />
          <MoneyField label={text('每月存入', 'Monthly contribution')} field="monthly" value={monthly} onChangeText={(value) => editField('monthly', setMonthly, value)} currency={currency} errors={errors} placeholder="0.00" />
          <Type size={12} muted selectable>{text('按从下个月开始、每月固定存入测算。不计利息、投资收益、费用和物价变化；结果向上取整到月。', 'Assumes fixed monthly contributions starting next month. Excludes interest, investment returns, fees and price changes; time is rounded up to full months.')}</Type>
          <Errors errors={errors.filter((error) => !['target', 'current', 'monthly'].includes(error.field ?? ''))} />
        </View> : null}
        {task === 'knowledge' ? <View style={{ gap: 14 }}>
          <Input testID="finance-knowledge-search" label={text('查找金融知识', 'Find financial basics')} value={knowledgeQuery} onChangeText={(value) => { setKnowledgeQuery(value); setKnowledgeId(null); setSubmitBlocked(false); }} placeholder={text('例如：年化、保险、储蓄', 'Try: annual rate, insurance, savings')} returnKeyType="search" />
          <Type size={12} muted>{text('8 篇基础知识，附参考来源。选择一篇查看。', 'Eight basics with references. Select one to read.')}</Type>
          <View>
            {knowledgeEntries.map((entry) => <View key={entry.id}>
              <Pressable testID={`finance-knowledge-${entry.id}`} accessibilityRole="button" accessibilityLabel={financeText(entry.title, locale)} accessibilityState={{ expanded: knowledgeId === entry.id }} onPress={() => { setKnowledgeId(knowledgeId === entry.id ? null : entry.id); Keyboard.dismiss(); }} style={({ pressed }) => ({ minHeight: 64, paddingVertical: 14, borderBottomWidth: 1, borderColor: colors.line, gap: 12, flexDirection: 'row', alignItems: 'center', opacity: pressed ? 0.65 : 1 })}>
                <View style={{ flex: 1, gap: 4 }}>
                  <Type size={15} weight="500" color={knowledgeId === entry.id ? colors.accent : colors.ink}>{financeText(entry.title, locale)}</Type>
                  <Type size={12} muted>{financeText(entry.summary, locale)}</Type>
                </View>
                <ChevronRight size={17} color={colors.muted} accessible={false} />
              </Pressable>
              {knowledgeId === entry.id ? <View style={{ paddingVertical: 14 }}><FinanceResultCard result={{ kind: 'knowledge', entry }} /></View> : null}
            </View>)}
          </View>
          {knowledgeEntries.length === 0 ? <Type size={13} muted>{text('没有匹配的条目，换一个关键词试试。', 'No matching entries. Try another keyword.')}</Type> : null}
        </View> : null}
        <View style={{ borderTopWidth: 1, borderColor: colors.line, paddingTop: 14 }}>
          <Type size={12} muted selectable>{financeText(FINANCE_PRIVACY, locale)}</Type>
        </View>
      </View>
    </Sheet>
  );
}

/** Unmount form state as soon as the sheet closes, including unsubmitted financial input. */
export function FinanceTaskSheet({ visible, initialTask, onClose, onSubmit }: FinanceTaskSheetProps) {
  if (!visible) return null;
  return <FinanceTaskForm key={initialTask} initialTask={initialTask} onClose={onClose} onSubmit={onSubmit} />;
}
