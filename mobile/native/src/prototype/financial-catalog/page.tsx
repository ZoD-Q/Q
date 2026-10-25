import { useState } from 'react';
import { Linking, View } from 'react-native';
import { ExternalLink, Landmark, ShieldCheck, WalletCards } from 'lucide-react-native';
import { Action, Choice, Input, Page, Row, Sheet, Tag, Type, useDesign } from '../design';
import { useQAccount } from '../account/account-state';
import { useFinancialPreview } from '../services/preview-state';
import { findListings, listings, reviewedOn, trustedSource, type Category, type Copy, type Listing } from './catalog';

const titles: Record<Category, Copy> = { installments: ['分期', 'Installments'], insurance: ['保险', 'Insurance'], finance: ['理财', 'Investments'] };
const icons = { installments: WalletCards, insurance: ShieldCheck, finance: Landmark };

export function FinancialCatalogPage({ category }: { category: Category }) {
  const { text, colors, phone } = useDesign();
  const account = useQAccount();
  const { savedListings, setSavedListings } = useFinancialPreview();
  const [query, setQuery] = useState('');
  const [savedOnly, setSavedOnly] = useState(false);
  const [selected, setSelected] = useState<Listing | null>(null);
  const [comparison, setComparison] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const [outbound, setOutbound] = useState<Listing | null>(null);
  const [linkError, setLinkError] = useState(false);
  const [checks, setChecks] = useState<string[]>([]);
  const label = (pair: Copy) => text(pair[0], pair[1]);
  const matches = findListings(category, query).filter(item => !savedOnly || savedListings.includes(item.id));
  const compareItems = listings.filter(item => comparison.includes(item.id));
  const toggleComparison = (id: string) => setComparison(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id].slice(-2));
  const open = (item: Listing) => { setChecks([]); setSelected(item); };
  const requestLogin = () => { setSelected(null); account.requestAuth(); };
  const save = (item: Listing) => {
    if (!account.session) { requestLogin(); return; }
    setSavedListings(current => current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id]);
  };
  const openOfficial = async () => {
    if (!outbound || !trustedSource(outbound.url)) { setLinkError(true); return; }
    try { await Linking.openURL(outbound.url); setOutbound(null); }
    catch { setLinkError(true); }
  };
  const details = (item: Listing) => <>
    <Row title={text('了解内容', 'Overview')} subtitle={label(item.summary)} />
    <Row title={text('办理条件', 'Eligibility')} subtitle={label(item.eligibility)} />
    <Row title={text('费用与价格', 'Costs and pricing')} subtitle={label(item.costs)} />
    <Row title={text('需要注意', 'Important considerations')} subtitle={label(item.risk)} last />
  </>;
  return <Page title={label(titles[category])} description={text('了解真实机构与公开产品，比较后前往官方了解详情。小Q不受理申请或付款。', 'Explore real providers and public offerings, compare them and visit official sources. Q does not process applications or payments.')}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><Tag accent>{text('官方公开信息', 'Official public information')}</Tag><Tag>{text('付款未开放', 'Payments unavailable')}</Tag></View>
    <Input label={text('搜索机构、产品或代码', 'Search provider, product or code')} value={query} onChangeText={setQuery} placeholder={text('输入关键词', 'Enter a keyword')} />
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      <Choice label={text('全部', 'All')} selected={!savedOnly} onPress={() => setSavedOnly(false)} />
      <Choice label={text('我的收藏', 'Saved')} selected={savedOnly} onPress={() => { if (!account.session) requestLogin(); else setSavedOnly(true); }} />
      <Action kind="secondary" label={text(`对比 ${comparison.length}/2`, `Compare ${comparison.length}/2`)} disabled={comparison.length !== 2} onPress={() => setComparing(true)} />
    </View>
    <Type size={13} muted>{text('公开资料整理于 ', 'Public information reviewed on ')}{reviewedOn}{text('，并非实时行情、报价或合作认证。', '; not live pricing or evidence of a partnership.')}</Type>
    {!matches.length ? <View style={{ gap: 12 }}><Type>{savedOnly ? text('本次登录会话暂无收藏。', 'No saved entries in this sign-in session.') : text('没有匹配的机构或产品。', 'No matching provider or product.')}</Type><Action kind="secondary" label={text('查看全部', 'View all')} onPress={() => { setQuery(''); setSavedOnly(false); }} /></View> : matches.map(item => <View key={item.id} style={{ paddingBottom: 22, gap: 10, borderBottomWidth: 1, borderColor: colors.line }}>
      <Row title={label(item.title)} subtitle={label(item.company) + ' · ' + label(item.kind)} icon={icons[category]} onPress={() => open(item)} last />
      <Type size={14} muted>{label(item.summary)}</Type>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Action label={text('查看详情', 'View details')} onPress={() => open(item)} />
        <Choice label={text('加入对比', 'Compare')} selected={comparison.includes(item.id)} onPress={() => toggleComparison(item.id)} />
        <Action kind="ghost" label={savedListings.includes(item.id) ? text('取消收藏', 'Unsave') : text('收藏', 'Save')} onPress={() => save(item)} />
      </View>
    </View>)}
    <Type size={13} muted>{text('收藏仅保留本次登录会话，退出或刷新后清除。小Q不收集身份证、银行卡、健康告知或征信资料。', 'Saved entries last for this sign-in session and clear on logout or reload. Q does not collect ID, bank-card, health or credit information here.')}</Type>
    <Sheet visible={!!selected} title={selected ? label(selected.title) : ''} onClose={() => setSelected(null)}>
      {selected ? <>
        <Type weight="500">{label(selected.company)}</Type>
        {details(selected)}
        <Type weight="500">{text('阅读准备清单', 'Reading checklist')}</Type>
        {selected.preparation.map((item, index) => <Choice key={index} label={label(item)} selected={checks.includes(String(index))} onPress={() => setChecks(current => current.includes(String(index)) ? current.filter(value => value !== String(index)) : [...current, String(index)])} />)}
        <Type size={13} muted>{text('勾选只帮助整理阅读进度，不代表已符合条件或已提交申请。', 'Checking an item only tracks reading; it does not establish eligibility or submit an application.')}</Type>
        <Row title={text('官方信息来源', 'Official source')} subtitle={selected.sourceTitle} last />
        <Type selectable size={12} muted>{selected.url}</Type>
        <Type size={12} muted>{text('核对日期：', 'Reviewed: ')}{reviewedOn} · {selected.evidence === 'search' ? text('官方搜索索引核对；页面正文需前往官网查看', 'Checked against official search results; visit the source for the full page') : text('已读取官方页面', 'Official page read')}</Type>
        <Action icon={ExternalLink} label={text('查看官方信息', 'View official information')} onPress={() => { setLinkError(false); setOutbound(selected); setSelected(null); }} />
        <Action kind="secondary" label={savedListings.includes(selected.id) ? text('取消收藏', 'Unsave') : text('收藏此条目', 'Save this entry')} onPress={() => save(selected)} />
        <Type size={13} muted>{text('未接通机构业务接口，申请进度、核保、开户和付款不可在小Q完成。', 'Provider APIs are not connected. Q cannot process application tracking, underwriting, account opening or payments.')}</Type>
      </> : null}
    </Sheet>
    <Sheet visible={comparing} title={text('公开信息对比', 'Compare public information')} onClose={() => setComparing(false)}>
      <Type size={13} muted>{text('按同类公开信息对比，不做排名或个性化推荐。', 'A comparison of public information, without ranking or personalized recommendations.')}</Type>
      <View style={{ flexDirection: phone ? 'column' : 'row', gap: 22 }}>{compareItems.map(item => <View key={item.id} style={{ flex: 1, minWidth: 0, gap: 10 }}><Type size={18} weight="500">{label(item.company)}</Type><Type>{label(item.title)}</Type>{details(item)}</View>)}</View>
    </Sheet>
    <Sheet visible={!!outbound} title={text('打开官方页面', 'Open official page')} onClose={() => setOutbound(null)}>
      {outbound ? <><Type>{text('即将离开小Q，打开以下官方信息页面：', 'You are leaving Q for this official information page:')}</Type><Type weight="500">{label(outbound.company)}</Type><Type selectable size={13}>{outbound.url}</Type><Type muted>{text('不会自动登录、提交资料或付款。外部网站由该机构管理，后续操作及费用请在官方渠道确认。', 'No automatic login, data submission or payment. The provider manages the external site; confirm any further actions and costs there.')}</Type>{linkError ? <Type color={colors.danger}>{text('未能打开，请重试或复制上方链接。', 'Unable to open. Retry or copy the link above.')}</Type> : null}<Action label={text('继续打开', 'Continue')} icon={ExternalLink} onPress={() => void openOfficial()} /><Action kind="ghost" label={text('返回', 'Back')} onPress={() => setOutbound(null)} /></> : null}
    </Sheet>
  </Page>;
}
