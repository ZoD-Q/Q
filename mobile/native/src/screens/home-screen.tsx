import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, RefreshControl, ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Bell, ChevronRight, Clock3, Compass, CreditCard, History, Home, Layers3, Leaf, Menu, MessageSquarePlus, Plus, RefreshCw, ShieldCheck, Sparkles, TrendingUp, WalletCards, X, type LucideIcon } from 'lucide-react-native';
import type { LedgerTransaction, Wallet } from '@xiaoq/shared';
import { useApp } from '@/providers/app-provider';
import { Avatar, Button, Card, DotGrid, IconButton, Notice, Pill, QMark, Type } from '@/components/ui';
import { errorKey } from '@/services/api';
import { formatAmount } from '@/utils/money';
import { ProfilePanel } from '@/screens/profile-panel';
import { TransferDialog } from '@/screens/transfer-dialog';
import type { CopyKey } from '@/i18n';
import { readPendingTransfer } from '@/services/pending-transfer';
import type { PendingTransfer } from '@/services/pending-transfer-data';

type Panel = 'home' | 'profile' | 'messages' | 'newChat' | 'history' | 'plugins' | 'installments' | 'insurance' | 'finance';
const navigation: { key: Panel; label: CopyKey; icon: LucideIcon }[] = [
  { key: 'newChat', label: 'newChat', icon: MessageSquarePlus },
  { key: 'history', label: 'history', icon: History },
  { key: 'plugins', label: 'plugins', icon: Layers3 },
  { key: 'installments', label: 'installments', icon: CreditCard },
  { key: 'insurance', label: 'insurance', icon: ShieldCheck },
  { key: 'finance', label: 'finance', icon: TrendingUp },
];

function Sidebar({ panel, onNavigate }: { panel: Panel; onNavigate: (value: Panel) => void }) {
  const { colors, t, user } = useApp();
  const link = (key: Panel, label: string, Icon: LucideIcon, upcoming = false) => <Pressable key={key} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: panel === key }} onPress={() => onNavigate(key)} style={({ pressed }) => ({ flexDirection: 'row', gap: 12, minHeight: 47, alignItems: 'center', paddingHorizontal: 13, paddingVertical: 10, borderRadius: 11, backgroundColor: panel === key ? colors.surface : pressed ? colors.subtle : 'transparent' })}>
    <Icon size={18} strokeWidth={1.6} color={panel === key ? colors.text : colors.muted} /><Type size={13} weight={panel === key ? '600' : '400'} style={{ flex: 1 }} color={panel === key ? colors.text : colors.muted}>{label}</Type>{upcoming && key === 'plugins' ? <View style={{ width: 4, height: 4, borderRadius: 3, backgroundColor: colors.accent }} /> : null}
  </Pressable>;
  return <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, backgroundColor: colors.sidebar, padding: 19, gap: 23 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={t.profile} onPress={() => onNavigate('profile')} style={{ minHeight: 48, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 14 }}><DotGrid /><View style={{ flex: 1 }}><Type size={13} weight="600">{user!.display_name}</Type><Type size={10} muted>@{user!.handle}</Type></View><ChevronRight size={15} color={colors.soft} /></Pressable>
    <View style={{ gap: 6 }}>{link('home', t.workspace, Home)}<View style={{ height: 1, backgroundColor: colors.line, marginVertical: 11, marginHorizontal: 12 }} />{navigation.map(item => link(item.key, t[item.label], item.icon, true))}</View>
    <View style={{ flex: 1 }} />
    <View style={{ paddingHorizontal: 11, gap: 11 }}><View style={{ flexDirection: 'row', gap: 7, alignItems: 'center' }}><View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: colors.success }} /><Type size={10} muted>{t.demoOnly}</Type></View><View style={{ height: 1, backgroundColor: colors.line }} /></View>
    <Pressable accessibilityRole="button" accessibilityLabel={t.profile} onPress={() => onNavigate('profile')} style={{ flexDirection: 'row', gap: 11, alignItems: 'center', paddingHorizontal: 9, paddingBottom: 4, minHeight: 50 }}><Avatar name={user!.avatar} size={37} /><View style={{ flex: 1 }}><Type size={13} weight="600">{t.account}</Type><Type size={10} muted>{user!.display_name} · @{user!.handle}</Type></View><ChevronRight size={15} color={colors.muted} /></Pressable>
  </ScrollView>;
}

function ComingSoon({ panel, onBack }: { panel: Exclude<Panel, 'home' | 'profile'>; onBack: () => void }) {
  const { colors, t } = useApp();
  const Icon = panel === 'messages' ? Bell : navigation.find(item => item.key === panel)?.icon || Compass;
  const title = panel === 'messages' ? t.notifications : t[panel];
  const description = panel === 'newChat' ? t.chatNotice : panel === 'history' ? t.historyNotice : panel === 'messages' ? t.notificationSub : t.futureBody;
  return <View style={{ gap: 28 }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><Type size={28} weight="500">{title}</Type><Pill>{t.soon}</Pill></View>
    <Card style={{ alignItems: 'center', paddingVertical: 64, gap: 20 }}><View style={{ width: 82, height: 82, borderRadius: 27, backgroundColor: colors.subtle, alignItems: 'center', justifyContent: 'center' }}><Icon size={35} strokeWidth={1.1} color={colors.muted} /></View><Type size={23} weight="500" style={{ textAlign: 'center' }}>{panel === 'messages' ? t.unopened : t.futureTitle}</Type><Type muted style={{ textAlign: 'center', maxWidth: 430, lineHeight: 25 }}>{description}</Type><Button label={t.backHome} variant="secondary" onPress={onBack} icon={ArrowRight} /></Card>
    {panel === 'finance' ? <View style={{ gap: 12 }}>{(['securities', 'baoge', 'whale'] as const).map(item => <Card key={item} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20 }}><Type>{t[item]}</Type><Pill>{t.soon}</Pill></Card>)}<Type muted size={12}>{t.partnerNotice}</Type></View> : null}
    <Type muted size={11}>{t.futureNotice}</Type>
  </View>;
}

function TransactionRow({ item, last }: { item: LedgerTransaction; last: boolean }) {
  const { colors, t, locale } = useApp();
  const incoming = item.direction === 'in';
  const welcome = item.kind === 'welcome';
  const Icon = welcome ? Sparkles : incoming ? ArrowDownLeft : ArrowUpRight;
  const title = welcome ? t.welcomeCredit : `${incoming ? t.transferIn : t.transferOut} ${item.counterparty_name}`;
  const date = new Date(item.created_at).toLocaleString(locale === 'en' ? 'en-GB' : 'zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return <View style={{ flexDirection: 'row', gap: 13, alignItems: 'center', paddingVertical: 19, borderBottomWidth: last ? 0 : 1, borderColor: colors.line }}>
    <View style={{ width: 39, height: 39, borderRadius: 14, backgroundColor: incoming ? colors.successSoft : colors.subtle, alignItems: 'center', justifyContent: 'center' }}><Icon size={19} strokeWidth={1.6} color={incoming ? colors.success : colors.muted} /></View>
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}><Type size={13} weight="500">{title}</Type><Type size={10} muted>{welcome ? t.welcomeMemo : item.memo || `@${item.counterparty_handle}`}</Type></View>
    <View style={{ alignItems: 'flex-end', gap: 3 }}><Type selectable size={14} weight="600" color={incoming ? colors.success : colors.text} style={{ fontVariant: ['tabular-nums'] }}>{incoming ? '+' : '−'}{formatAmount(item.amount_minor)} <Type size={10} color={incoming ? colors.success : colors.muted}>Q</Type></Type><Type size={10} muted>{date}</Type></View>
  </View>;
}

export function HomeScreen() {
  const { t, colors, user, call } = useApp();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const desktop = width >= 900;
  const columns = width >= 1150;
  const [panel, setPanel] = useState<Panel>('home');
  const [drawer, setDrawer] = useState(false);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [transactions, setTransactions] = useState<LedgerTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<CopyKey | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [initialTransfer, setInitialTransfer] = useState<PendingTransfer | null>(null);
  const [recoveringTransfer, setRecoveringTransfer] = useState(true);
  const [recoveryError, setRecoveryError] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => { setRefreshing(true); setRevision(value => value + 1); }, []);
  useEffect(() => {
    let active = true;
    void Promise.all([call<Wallet>('/v1/wallet'), call<{ items: LedgerTransaction[] }>('/v1/wallet/transactions')])
      .then(([nextWallet, activity]) => { if (active) { setWallet(nextWallet); setTransactions(activity.items); setError(null); } })
      .catch(err => { if (active) setError(errorKey(err)); })
      .finally(() => { if (active) { setLoading(false); setRefreshing(false); } });
    return () => { active = false; };
  }, [call, revision]);
  const senderId = user!.id;
  useEffect(() => {
    let active = true;
    void readPendingTransfer(senderId).then(intent => {
      if (active && intent) { setInitialTransfer(intent); setTransferOpen(true); }
    }).catch(() => { if (active) setRecoveryError(true); })
      .finally(() => { if (active) setRecoveringTransfer(false); });
    return () => { active = false; };
  }, [senderId]);
  const openTransfer = async () => {
    setRecoveringTransfer(true); setRecoveryError(false);
    try { const intent = await readPendingTransfer(senderId); setInitialTransfer(intent); setTransferOpen(true); }
    catch { setRecoveryError(true); }
    finally { setRecoveringTransfer(false); }
  };
  const navigate = (next: Panel) => { setPanel(next); setDrawer(false); };
  return <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top, paddingBottom: insets.bottom }}>
    <View style={{ height: desktop ? 76 : 66, borderBottomWidth: 1, borderColor: colors.line, flexDirection: 'row', alignItems: 'center', paddingHorizontal: desktop ? 30 : 14, justifyContent: 'space-between', backgroundColor: colors.background }}>
      <View style={{ flexDirection: 'row', gap: desktop ? 13 : 6, alignItems: 'center' }}>{!desktop ? <IconButton label={t.workspace} icon={Menu} onPress={() => setDrawer(true)} /> : null}<Pressable accessibilityRole="button" accessibilityLabel={t.workspace} onPress={() => navigate('home')} style={{ flexDirection: 'row', alignItems: 'center', gap: 11, minHeight: 44 }}><QMark size={desktop ? 32 : 25} /><Type size={desktop ? 14 : 12} weight="600">{t.tagline}</Type></Pressable></View>
      <View style={{ flexDirection: 'row', gap: 18, alignItems: 'center' }}>{desktop ? <Type size={11} muted>{t.noRealServices}</Type> : null}<IconButton label={t.messages} icon={Bell} active={panel === 'messages'} onPress={() => navigate('messages')} /></View>
    </View>
    <View style={{ flex: 1, flexDirection: 'row' }}>
      {desktop ? <View style={{ width: 237, borderRightWidth: 1, borderColor: colors.line }}><Sidebar panel={panel} onNavigate={navigate} /></View> : null}
      <ScrollView key={panel} contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" refreshControl={panel === 'home' ? <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} /> : undefined} contentContainerStyle={{ paddingHorizontal: desktop ? 44 : 22, paddingTop: desktop ? 37 : 27, paddingBottom: 42, width: '100%', maxWidth: 1270, alignSelf: 'center' }}>
        {panel === 'profile' ? <ProfilePanel /> : panel !== 'home' ? <ComingSoon panel={panel} onBack={() => navigate('home')} /> : <View style={{ gap: 29 }}>
          <View style={{ gap: 7 }}><View style={{ flexDirection: 'row', gap: 7, alignItems: 'center' }}><Leaf size={13} strokeWidth={1.6} color={colors.accent} /><Type size={11} color={colors.accent} weight="500">{t.morning}，{user!.display_name}</Type></View><Type size={desktop ? 34 : 27} weight="500" style={{ letterSpacing: -.7 }} accessibilityRole="header">{t.homeTitle}</Type><Type muted size={13}>{t.homeSub}</Type></View>
          <View style={{ flexDirection: columns ? 'row' : 'column', gap: 20, alignItems: 'stretch' }}>
            <View style={{ flex: 1.65, minHeight: 244, borderRadius: 22, borderCurve: 'continuous', backgroundColor: colors.wallet, padding: desktop ? 29 : 24, gap: 21, overflow: 'hidden' }}>
              <View pointerEvents="none" accessibilityElementsHidden style={{ position: 'absolute', right: -52, top: 42, width: 220, height: 220, borderWidth: 1, borderColor: `${colors.walletText}14`, borderRadius: 150 }} /><View pointerEvents="none" accessibilityElementsHidden style={{ position: 'absolute', right: -22, top: 73, width: 158, height: 158, borderWidth: 1, borderColor: `${colors.walletText}12`, borderRadius: 150 }} />
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}><WalletCards size={17} strokeWidth={1.5} color={colors.walletMuted} /><Type size={12} color={colors.walletMuted}>{t.balance}</Type></View><View style={{ borderWidth: 1, borderColor: `${colors.walletMuted}55`, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}><Type size={8} weight="600" color={colors.walletMuted} style={{ letterSpacing: 1.1 }}>DEMO</Type></View></View>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 9 }}>{loading ? <ActivityIndicator color={colors.walletText} style={{ height: 64 }} /> : <Type selectable size={width < 420 ? 43 : 48} color={colors.walletText} weight="500" style={{ letterSpacing: -1.5, fontVariant: ['tabular-nums'] }}>{wallet ? formatAmount(wallet.balance_minor) : '—'}</Type>}<Type size={16} color={colors.walletMuted}>Q</Type></View>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}><Pressable accessibilityRole="button" accessibilityLabel={t.send} accessibilityState={{ disabled: !wallet || recoveringTransfer }} disabled={!wallet || recoveringTransfer} onPress={() => void openTransfer()} style={({ pressed }) => ({ borderRadius: 10, paddingHorizontal: 16, paddingVertical: 11, flexDirection: 'row', gap: 9, alignItems: 'center', minHeight: 44, backgroundColor: colors.walletText, opacity: !wallet || recoveringTransfer ? .45 : pressed ? .8 : 1 })}><ArrowUpRight size={17} color={colors.wallet} /><Type size={12} weight="600" color={colors.wallet}>{t.send}</Type></Pressable><Type size={10} color={colors.walletMuted}>@{user!.handle}</Type></View>
              <Type size={9} color={colors.walletMuted}>{t.walletFootnote}</Type>
            </View>
            <Card style={{ flex: 1, padding: 25, justifyContent: 'space-between', minHeight: columns ? 244 : 178 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><Avatar name={user!.avatar} size={49} selected /><Pill tone="green">{t.demo}</Pill></View>
              <View style={{ gap: 4 }}><Type size={17} weight="500">{t.accountActive}</Type><Type muted size={11}>{user!.bio || t.accountActiveSub}</Type></View>
              <Pressable accessibilityRole="button" accessibilityLabel={t.profileAction} onPress={() => navigate('profile')} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', minHeight: 32 }}><Type size={12} weight="500">{t.profileAction}</Type><ArrowRight size={14} color={colors.text} /></Pressable>
            </Card>
          </View>
          {error ? <View style={{ gap: 10 }}><Notice text={t[error]} /><Button label={t.retry} variant="secondary" onPress={refresh} loading={refreshing} /></View> : null}
          {recoveryError ? <View style={{ gap: 10 }}><Notice text={t.recoveryReadError} /><Button label={t.retry} variant="secondary" loading={recoveringTransfer} onPress={() => void openTransfer()} /></View> : null}
          <View style={{ gap: 15 }}><View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><View style={{ gap: 4 }}><Type size={19} weight="500">{t.activity}</Type><Type muted size={11}>{t.activitySub}</Type></View><IconButton label={t.refresh} icon={RefreshCw} onPress={refresh} /></View>
            <Card style={{ paddingHorizontal: desktop ? 24 : 17, paddingVertical: 1, gap: 0 }}>
              {loading ? <View style={{ height: 116, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={colors.muted} /></View> : transactions.length ? transactions.map((item, index) => <TransactionRow key={item.id} item={item} last={index === transactions.length - 1} />) : <View style={{ padding: 32, gap: 12, alignItems: 'center' }}><Clock3 size={25} color={colors.soft} /><Type muted size={13}>{t.emptyTransactions}</Type></View>}
            </Card>
          </View>
          <View style={{ gap: 17, marginTop: 1 }}><View style={{ gap: 4 }}><Type size={19} weight="500">{t.exploreTitle}</Type><Type muted size={11}>{t.exploreSub}</Type></View><View style={{ flexDirection: columns ? 'row' : 'column', gap: 14 }}>{[
            { key: 'plugins', icon: Layers3, title: t.plugins, subtitle: t.pluginSub },
            { key: 'installments', icon: CreditCard, title: t.installments, subtitle: t.installmentSub },
            { key: 'insurance', icon: ShieldCheck, title: t.insurance, subtitle: t.insuranceSub },
          ].map(({ key, icon: Icon, title: tileTitle, subtitle }) => <Pressable key={key} accessibilityRole="button" accessibilityLabel={tileTitle} onPress={() => navigate(key as Panel)} style={({ pressed }) => ({ flex: 1, borderWidth: 1, borderColor: colors.line, borderRadius: 17, padding: 20, gap: 19, backgroundColor: pressed ? colors.subtle : 'transparent' })}><View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><Icon size={23} strokeWidth={1.3} color={colors.muted} /><Type size={9} muted>{t.soon}</Type></View><View style={{ gap: 4 }}><Type size={14} weight="500">{tileTitle}</Type><Type size={10} muted>{subtitle}</Type></View></Pressable>)}</View></View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, justifyContent: 'center', paddingTop: 3 }}><Plus size={12} color={colors.soft} /><Type size={10} color={colors.soft}>{t.tagline}</Type></View>
        </View>}
      </ScrollView>
    </View>
    <Modal visible={drawer && !desktop} transparent animationType={process.env.EXPO_OS === 'web' ? 'none' : 'fade'} onRequestClose={() => setDrawer(false)}>
      <View style={{ flex: 1, flexDirection: 'row', backgroundColor: '#00000055' }}><View style={{ width: Math.min(300, width - 55), backgroundColor: colors.sidebar, paddingTop: insets.top, paddingBottom: insets.bottom }}><View style={{ flexDirection: 'row', paddingHorizontal: 18, height: 65, alignItems: 'center', justifyContent: 'space-between' }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><QMark size={28} /><Type weight="600">{t.brand}</Type></View><IconButton label={t.cancel} icon={X} onPress={() => setDrawer(false)} /></View><Sidebar panel={panel} onNavigate={navigate} /></View><Pressable accessibilityRole="button" accessibilityLabel={t.cancel} onPress={() => setDrawer(false)} style={{ flex: 1 }} /></View>
    </Modal>
    {transferOpen && wallet ? <TransferDialog balance={wallet.balance_minor} initialPending={initialTransfer} onClose={() => { setTransferOpen(false); setInitialTransfer(null); }} onComplete={refresh} /> : null}
  </View>;
}
