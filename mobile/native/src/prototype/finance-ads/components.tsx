import { useEffect, useId, useState, type ReactNode } from "react";
import { AppState, Pressable, Switch, View } from "react-native";
import { ArrowUpRight, Info, X, type LucideIcon } from "lucide-react-native";
import { Sheet, Type, useDesign } from "../design";
import { FINANCE_AD_CAMPAIGNS } from "./campaigns";
import { displayPreferences } from "./preference-core";
import { selectCampaign, type FinanceAdCategory } from "./policy";
import { useFinanceAds } from "./provider";

function AdButton({ label, onPress, icon: Icon, disabled = false }: { label: string; onPress: () => void; icon?: LucideIcon; disabled?: boolean }) {
  const { colors } = useDesign();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ minHeight: 48, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: colors.soft, opacity: disabled ? 0.45 : pressed ? 0.65 : 1 })}
    >
      <Type size={14} weight="500" style={{ flexShrink: 1 }}>{label}</Type>
      {Icon ? <Icon size={17} color={colors.ink} accessible={false} /> : null}
    </Pressable>
  );
}

function PreferenceIssue() {
  const { preferences, retryPreferences } = useFinanceAds();
  const { text, colors } = useDesign();
  if (!preferences.error) return null;
  return (
    <View accessibilityLiveRegion="polite" style={{ gap: 12, padding: 16, borderRadius: 16, backgroundColor: colors.soft }}>
      <Type size={14} weight="500" color={colors.danger} selectable>
        {preferences.error === "read" ? text("广告偏好读取失败，当前不展示广告。", "Ad preferences could not be loaded. Ads are hidden.") : text("广告偏好保存失败，当前已隐藏广告。", "Ad preferences could not be saved. Ads are hidden.")}
      </Type>
      {preferences.error === "write" ? <Type size={13} muted selectable>{text("本次关闭仍然有效。重启后可能恢复为上次保存的设置，请重试保存。", "Your current choice still applies. Restarting may restore the last saved setting; please retry saving.")}</Type> : null}
      <AdButton label={preferences.loading || preferences.saving ? text("正在重试…", "Retrying…") : preferences.error === "read" ? text("重试读取", "Retry loading") : text("重试保存", "Retry saving")} disabled={preferences.loading || preferences.saving} onPress={() => { void retryPreferences(); }} />
    </View>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return <View style={{ gap: 8 }}><Type size={15} weight="600">{title}</Type><Type size={14} muted>{children}</Type></View>;
}

/** Mount once for the visible service page; each mount has one deduplicated presentation. */
export function FinanceAdPlacement({ category }: { category: FinanceAdCategory }) {
  const { colors, text, locale } = useDesign();
  const { preferences, counts, trackImpression, trackDetailClick, hideCampaign } = useFinanceAds();
  const instanceId = useId();
  const presentationId = `${instanceId}:${category}`;
  const [detailVisible, setDetailVisible] = useState(false);
  const [active, setActive] = useState(AppState.currentState !== "background" && AppState.currentState !== "inactive");
  const [now, setNow] = useState(Date.now);
  const campaign = active ? selectCampaign(FINANCE_AD_CAMPAIGNS, category, displayPreferences(preferences), counts, presentationId, now) : null;

  useEffect(() => {
    const subscription = AppState.addEventListener("change", next => { setActive(next === "active"); setNow(Date.now()); });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!campaign) return;
    // Preserve a third presentation while rejecting a fourth, including React effect replays.
    trackImpression(campaign.id, category, presentationId, Date.now());
  }, [campaign, category, presentationId, trackImpression, now]);

  useEffect(() => {
    // Keep the clock current even while a preference write temporarily hides the placement.
    const nextBoundary = Math.min(...FINANCE_AD_CAMPAIGNS.filter(item => item.category === category)
      .flatMap(item => [Date.parse(item.startsAt), Date.parse(item.expiresAt)]).filter(time => time > now));
    if (!Number.isFinite(nextBoundary)) return;
    const delay = Math.min(Math.max(nextBoundary - Date.now(), 1), 2_147_483_647);
    const expiry = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(expiry);
  }, [category, now]);

  if (preferences.error) return <PreferenceIssue />;
  if (!campaign) return null;
  const closeAd = () => { setDetailVisible(false); void hideCampaign(campaign.id); };
  const categoryName = category === "installments" ? text("分期", "Installments") : category === "insurance" ? text("保险", "Insurance") : text("理财", "Finance");

  return (
    <>
      <View style={{ padding: 18, gap: 14, borderRadius: 20, backgroundColor: colors.accentBg }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ flex: 1, gap: 3 }}>
            <Type size={12} weight="600" color={colors.accent}>{text("广告位演示", "AD PLACEMENT DEMO")}</Type>
            <Type size={12} muted>{text("无真实广告合作", "No real advertising partnership")}</Type>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={text("关闭此广告", "Hide this ad")}
            onPress={closeAd}
            style={({ pressed }) => ({ width: 48, height: 48, borderRadius: 14, justifyContent: "center", alignItems: "center", backgroundColor: pressed ? colors.soft : "transparent" })}
          ><X size={19} color={colors.muted} accessible={false} /></Pressable>
        </View>
        <View style={{ gap: 6 }}>
          <Type size={19} weight="600">{campaign.title[locale]}</Type>
          <Type size={14} muted>{campaign.summary[locale]}</Type>
          <Type size={12} muted>{campaign.partner[locale]}</Type>
        </View>
        <AdButton label={text("查看演示详情", "View demo details")} icon={ArrowUpRight} onPress={() => {
          if (trackDetailClick(campaign.id, category, presentationId, Date.now())) setDetailVisible(true);
        }} />
      </View>
      <Sheet visible={detailVisible} title={text("广告演示详情", "Ad demo details")} onClose={() => setDetailVisible(false)}>
        <View style={{ gap: 22 }}>
          <View style={{ gap: 6 }}>
            <Type size={12} weight="600" color={colors.accent}>{text("广告位演示 · 无真实广告合作", "AD DEMO · No real advertising partnership")}</Type>
            <Type size={21} weight="600">{campaign.title[locale]}</Type>
            <Type size={13} muted>{campaign.partner[locale]}</Type>
          </View>
          <DetailSection title={text("这是什么", "About this demo")}>{campaign.detail[locale]}</DetailSection>
          <DetailSection title={text("为什么看到这张卡片", "Why this card appears")}>
            {text(`仅因为你打开了「${categoryName}」服务页。展示不使用聊天内容、余额、交易记录、个人资料或财务助手数据。`, `Only because you opened the ${categoryName} service page. Selection does not use chats, balances, transactions, profile information or finance assistant data.`)}
          </DetailSection>
          <DetailSection title={text("你可以控制展示", "You control the display")}>
            {text("每个示例活动在本次应用会话最多展示 3 次。关闭此广告会在这台设备保留；广告设置还可关闭全部演示。计数仅保留在本机会话，不上传。", "Each sample campaign appears at most 3 times per app session. Hiding this ad is remembered on this device; ad settings can turn off all demos. Session counts stay on this device and are not uploaded.")}
          </DetailSection>
          <AdButton label={text("关闭此广告", "Hide this ad")} icon={X} onPress={closeAd} />
        </View>
      </Sheet>
    </>
  );
}

export function FinanceAdSettings({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colors, text, locale } = useDesign();
  const { preferences, counts, setEnabled } = useFinanceAds();
  const unavailable = !preferences.hydrated || preferences.loading;
  return (
    <Sheet visible={visible} title={text("广告演示设置", "Ad demo settings")} onClose={onClose}>
      <View style={{ gap: 24 }}>
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: "row", gap: 16, alignItems: "center", minHeight: 48 }}>
            <View style={{ flex: 1, gap: 4 }}>
              <Type size={16} weight="600">{text("允许广告演示", "Allow ad demos")}</Type>
              <Type size={13} muted>{preferences.loading ? text("正在读取本机偏好…", "Loading device preferences…") : preferences.saving ? text("正在保存偏好…", "Saving preferences…") : preferences.preferences.enabled && preferences.hydrated && !preferences.error ? text("已开启", "On") : text("当前不展示", "Currently hidden")}</Type>
            </View>
            <View style={{ minWidth: 52, minHeight: 48, justifyContent: "center", alignItems: "center" }}>
              <Switch
                accessibilityLabel={text("允许广告演示", "Allow ad demos")}
                accessibilityHint={text("只影响这台设备上的演示广告", "Affects demo ads on this device only")}
                disabled={unavailable}
                value={preferences.hydrated && preferences.preferences.enabled}
                onValueChange={value => { void setEnabled(value); }}
                trackColor={{ false: colors.line, true: colors.accent }}
              />
            </View>
          </View>
          <Type size={13} muted>{text("关闭后持续生效，只有你手动开启才会恢复。单独关闭的广告不会因重新开启总开关而恢复。偏好仅保存在这台设备。", "Turning this off lasts until you turn it on again. Individually hidden ads stay hidden when you re-enable demos. Preferences are saved only on this device.")}</Type>
        </View>
        <PreferenceIssue />
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
            <Info size={18} color={colors.muted} accessible={false} />
            <Type size={15} weight="600">{text("本机会话计数", "This device session")}</Type>
          </View>
          <Type size={13} muted>{text("展示按每次打开服务页计数，重复渲染不重复计数；点击仅指打开演示详情，不代表申请、成交或收益。计数只在内存中，不上传，重启后清零。", "A service page visit counts once; re-renders do not add views. Clicks only mean opening demo details, never applications, transactions or earnings. Counts stay in memory, are not uploaded, and reset on restart.")}</Type>
          {FINANCE_AD_CAMPAIGNS.map(campaign => (
            <View key={campaign.id} style={{ paddingVertical: 14, borderTopWidth: 1, borderColor: colors.line, gap: 6 }}>
              <Type size={14} weight="500">{campaign.title[locale]}</Type>
              <Type size={13} muted selectable style={{ fontVariant: ["tabular-nums"] }}>
                {text(`展示 ${counts[campaign.id]?.presentationIds.length ?? 0} · 详情点击 ${counts[campaign.id]?.clicks ?? 0}`, `Views ${counts[campaign.id]?.presentationIds.length ?? 0} · Detail clicks ${counts[campaign.id]?.clicks ?? 0}`)}
              </Type>
              {preferences.preferences.hiddenCampaignIds.includes(campaign.id) ? <Type size={12} color={colors.accent}>{text("已单独关闭", "Individually hidden")}</Type> : null}
            </View>
          ))}
        </View>
        <Type size={13} muted>{text("全部内容均为虚构广告位演示，无真实广告合作、投放或金融交易。", "All content is a fictional ad placement demo, with no real advertising partnership, delivery or financial transaction.")}</Type>
      </View>
    </Sheet>
  );
}
