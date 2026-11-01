import { useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { ArrowUpRight, ShieldCheck } from 'lucide-react-native';
import { Action, Choice, Input, Page, Row, Sheet, Tag, Type, useDesign } from '../design';
import { groups, insuranceTypes, findInsurance, sources, type Copy, type InsuranceType } from './catalog';
import { FinanceAdPlacement, FinanceAdSettings } from '../finance-ads';

export type InsuranceEntry = { query?: string; group?: string; insuranceIds?: string[] };
export function InsuranceDashboard({ initialEntry }: { initialEntry?: InsuranceEntry }) {
  const { text, colors, phone } = useDesign();
  const label = (copy: Copy) => text(copy[0], copy[1]);
  const [query, setQuery] = useState(initialEntry?.query ?? '');
  const [group, setGroup] = useState(initialEntry?.group ?? 'all');
  const [tab, setTab] = useState('catalog');
  const [selected, setSelected] = useState<InsuranceType | null>(initialEntry?.insuranceIds?.length === 1 ? insuranceTypes.find(item => item.id === initialEntry.insuranceIds![0]) ?? null : null);
  const [comparison, setComparison] = useState<string[]>(initialEntry?.insuranceIds ?? []);
  const [comparing, setComparing] = useState((initialEntry?.insuranceIds?.length ?? 0) >= 2);
  const [outbound, setOutbound] = useState<(typeof sources)[number] | null>(null);
  const [linkError, setLinkError] = useState(false);
  const [adSettings, setAdSettings] = useState(false);
  const results = findInsurance(query, group);
  const toggle = (id: string) => setComparison(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id].slice(-3));
  const details = (item: InsuranceType) => {
    const category = groups.find(value => value.id === item.group)!;
    return <>
      <Row title={text('保障方向', 'Coverage overview')} subtitle={label(item.coverage)} />
      <Row title={text('重点核对', 'Key considerations')} subtitle={text(item.caution, category.questions[1])} />
      <Row title={text('投保前问清楚', 'Questions before buying')} subtitle={label(category.questions)} />
      <Row title={text('理赔材料参考', 'Claim preparation')} subtitle={label(category.claims)} last />
      <Type size={12} muted>{text('具体保障、除外责任、材料及价格以所选产品条款和保险公司要求为准。', 'Coverage, exclusions, documents and pricing depend on the chosen policy and insurer.')}</Type>
    </>;
  };
  return <Page title={text('保险全景', 'Insurance explorer')} action={<Action kind="ghost" label={text('广告设置', 'Ad settings')} onPress={() => setAdSettings(true)} />} description={text('从个人健康到家庭资产、企业经营，按生活与业务场景了解保障。', 'Explore protection for your health, family, assets and business.')}>
    <FinanceAdPlacement category="insurance" />
    <FinanceAdSettings visible={adSettings} onClose={() => setAdSettings(false)} />
    <View style={{ padding: 20, borderRadius: 20, backgroundColor: colors.accentBg, gap: 14 }}>
      <ShieldCheck color={colors.accent} size={28} />
      <Type size={23} weight="600">{text('看懂保障，再做选择', 'Understand your protection')}</Type>
      <View style={{ flexDirection: 'row', gap: 22, flexWrap: 'wrap' }}>
        <Type weight="500">{text('8 大板块', '8 categories')}</Type>
        <Type weight="500">{text(`${insuranceTypes.length} 类保障导航`, `${insuranceTypes.length} coverage entries`)}</Type>
        <Type muted>{text('个人 · 家庭 · 企业', 'Personal · Family · Business')}</Type>
      </View>
      <Type size={12} muted>{text('中国大陆常见商业保险知识目录，包含部分附加险和产品形态。非在售产品清单，不代表与机构合作。', 'A mainland China commercial insurance guide including riders and product forms. Not a live product inventory or evidence of partnerships.')}</Type>
    </View>
    <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
      {([['catalog','险种大全','Browse'],['guide','投保指南','Guide'],['support','咨询服务','Support']] as const).map(([id, zh, en]) => <Choice key={id} label={text(zh,en)} selected={tab === id} onPress={() => setTab(id)} />)}
    </View>
    {tab === 'catalog' ? <>
      <Input label={text('搜索险种或保障', 'Search coverage')} placeholder={text('如：医疗、宠物、车险、雇主', 'Medical, pet, motor, employer…')} value={query} onChangeText={setQuery} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {groups.map(category => <Pressable key={category.id} accessibilityRole="button" accessibilityLabel={label(category.title)} accessibilityState={{ selected: category.id === group }} onPress={() => setGroup(current => current === category.id ? 'all' : category.id)} style={{ width: phone ? '48%' : '23%', minHeight: 68, padding: 13, borderRadius: 14, backgroundColor: group === category.id ? colors.accentBg : colors.soft, justifyContent: 'center', gap: 5 }}>
          <Type weight="500" color={group === category.id ? colors.accent : colors.ink}>{label(category.title)}</Type>
          <Type size={12} muted>{insuranceTypes.filter(item => item.group === category.id).length}{text(' 类保障', ' entries')}</Type>
        </Pressable>)}
      </View>
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <Choice label={text('全部险种', 'All types')} selected={group === 'all'} onPress={() => setGroup('all')} />
        <Action kind="secondary" label={text(`对比 (${comparison.length}/3)`, `Compare (${comparison.length}/3)`)} disabled={comparison.length < 2} onPress={() => setComparing(true)} />
        <Type size={13} muted>{text(`${results.length} 项结果`, `${results.length} results`)}</Type>
      </View>
      {!results.length ? <View style={{ gap: 12 }}><Type>{text('没有匹配的险种，试试更短的关键词或其他分类。', 'No matches. Try a shorter query or a different category.')}</Type><Action label={text('清除筛选', 'Reset filters')} onPress={() => { setQuery(''); setGroup('all'); }} /></View> : null}
      {groups.filter(category => results.some(item => item.group === category.id)).map(category => <View key={category.id} style={{ gap: 13 }}>
        <Type size={20} weight="600">{label(category.title)}</Type>
        {results.filter(item => item.group === category.id).map(item => <View key={item.id} style={{ borderRadius: 16, borderWidth: 1, borderColor: colors.line, padding: 16, gap: 10 }}>
          <Row title={label(item.title)} subtitle={label(item.coverage)} onPress={() => setSelected(item)} right={<ArrowUpRight size={18} color={colors.accent} />} last />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            <Action kind="ghost" label={text('保障详情', 'Coverage details')} onPress={() => setSelected(item)} />
            <Choice label={comparison.includes(item.id) ? text('已选对比', 'Selected') : text('加入对比', 'Compare')} selected={comparison.includes(item.id)} onPress={() => toggle(item.id)} />
          </View>
        </View>)}
      </View>)}
    </> : tab === 'guide' ? <>
      <Type size={21} weight="600">{text('投保前的 5 个步骤', 'Five steps before buying')}</Type>
      <Row title={text('01 盘点已有保障', '01 Review existing coverage')} subtitle={text('先了解基本医保、工伤保障、单位福利及已有保单，避免遗漏或重复配置。', 'Review social insurance, employer benefits and existing policies.')} />
      <Row title={text('02 确认风险与预算', '02 Identify risks and budget')} subtitle={text('明确要转移的风险、保障对象和能持续承担的保费；不要只按销量选择。', 'Identify the risk, insured person or asset, and sustainable premiums.')} />
      <Row title={text('03 核对保障与除外', '03 Read coverage and exclusions')} subtitle={text('比较保额、免赔、赔付比例、等待期、医院或地域、续保条件。产品名称相似不代表责任相同。', 'Compare limits, deductibles, benefit ratios, waiting periods, territory and renewal.')} />
      <Row title={text('04 如实告知与官方核验', '04 Disclose and verify')} subtitle={text('在保险公司官方渠道按询问如实告知，查看完整条款、销售主体和保单信息。请勿在小Q提交病历或证件。', 'Answer insurer questions accurately through official channels and verify terms and seller. Do not submit health records or ID here.')} />
      <Row title={text('05 保存保单与理赔路径', '05 Keep your policy and claims contacts')} subtitle={text('关注生效日、犹豫期（如适用）、缴费提醒和报案方式。事故发生后及时联系保险公司，保留相关证据。', 'Track effective dates, applicable cooling-off period, premiums and claim contacts. Preserve evidence after an incident.')} last />
      <Type size={20} weight="600">{text('常见疑问', 'Common questions')}</Type>
      <Row title={text('医疗险与重疾险有什么区别？', 'Medical vs critical illness?')} subtitle={text('医疗险通常报销符合约定的实际医疗费用；重疾险达到条款定义时通常按约定给付，两者触发条件不同。', 'Medical insurance generally reimburses eligible expenses; critical illness pays a defined benefit when policy criteria are met.')} />
      <Row title={text('一切险是否什么都赔？', 'Does all-risks cover everything?')} subtitle={text('不是。仍有除外责任、免赔、限额及投保人义务，必须阅读条款。', 'No. Exclusions, deductibles, limits and policyholder duties still apply.')} />
      <Row title={text('有社保还需要商业保险吗？', 'How does this relate to social insurance?')} subtitle={text('商业保险可补充特定风险，是否需要取决于已有保障、预算与需求。惠民保、商业护理险也不等同于基本医保或社会长护险。', 'Commercial cover can supplement specific gaps depending on needs and budget; it does not replace social insurance.')} last />
    </> : <>
      <Type size={21} weight="600">{text('咨询与服务', 'Questions & service')}</Type>
      <Tag>{text('人工客服尚未接通', 'Live support not connected')}</Tag>
      <Row title={text('想问保障内容？', 'Questions about coverage?')} subtitle={text('每个险种详情包含投保前问题与理赔材料参考，可以先在目录中查阅。', 'Each coverage entry includes questions to ask and claim-document guidance.')} />
      <Action label={text('返回险种大全', 'Browse insurance types')} onPress={() => setTab('catalog')} />
      <Row title={text('客服对话', 'Customer service conversation')} subtitle={text('尚未接通客服机构，暂不能发送消息或创建工单。', 'No support provider is connected. Messages and tickets are unavailable.')} />
      <Row title={text('个性化信息咨询', 'Personalized inquiries')} subtitle={text('信息询问服务尚未开放。现在可浏览通用知识；实际核保、报价和理赔结论请向保险公司确认。', 'Personalized inquiries are unavailable. General guidance is available; confirm underwriting, quotes and claims with the insurer.')} last />
      <Type size={20} weight="600">{text('官方信息入口', 'Official information')}</Type>
      {sources.map(source => <Row key={source.url} title={label(source.title)} subtitle={new URL(source.url).hostname} onPress={() => { setLinkError(false); setOutbound(source); }} right={<ArrowUpRight size={18} color={colors.accent} />} />)}
    </>}
    <Type size={12} muted>{text('资料整理：2026-10-22。参考平安、新华保险和中国人保公开目录，部分细分类别为编辑整理。此页不报价、不承保、不出单、不收款。', 'Reviewed 2026-10-22. Based on public Ping An, New China Life and PICC directories with editorial subcategories. No quotes, underwriting, policy issuance or payments.')}</Type>
    <Sheet visible={!!selected} title={selected ? label(selected.title) : ''} onClose={() => setSelected(null)}>{selected ? <>{details(selected)}<Action label={text('加入 / 移出对比', 'Toggle comparison')} onPress={() => toggle(selected.id)} /><Type size={12} muted>{comparison.includes(selected.id) ? text('已加入对比，最多保留最近 3 项。', 'Selected. Up to the most recent 3 entries are kept.') : text('可在目录中打开对比。', 'Open comparison from the catalogue.')}</Type></> : null}</Sheet>
    <Sheet visible={comparing} title={text('保障方向对比', 'Coverage comparison')} onClose={() => setComparing(false)}>
      <Type muted>{text('按保障目的对比，不代表产品优劣或购买建议。', 'Compare coverage purposes; this is not a product ranking or purchase recommendation.')}</Type>
      {insuranceTypes.filter(item => comparison.includes(item.id)).map(item => <View key={item.id} style={{ gap: 10 }}><Type size={20} weight="600">{label(item.title)}</Type>{details(item)}</View>)}
      <Action kind="secondary" label={text('清空对比', 'Clear comparison')} onPress={() => { setComparison([]); setComparing(false); }} />
    </Sheet>
    <Sheet visible={!!outbound} title={text('前往官方网站', 'Visit official website')} onClose={() => setOutbound(null)}>
      <Type>{text('将离开小Q查看机构公开信息，不会自动提交资料。', 'Leave Q to read public information. No data will be submitted automatically.')}</Type><Type selectable>{outbound?.url}</Type>
      {linkError ? <Type color={colors.danger}>{text('打开失败，请重试或复制链接。', 'Unable to open. Retry or copy the link.')}</Type> : null}
      <Action label={text('继续打开', 'Continue')} onPress={() => { if (outbound && sources.some(source => source.url === outbound.url)) void Linking.openURL(outbound.url).then(() => setOutbound(null)).catch(() => setLinkError(true)); }} />
    </Sheet>
  </Page>;
}
