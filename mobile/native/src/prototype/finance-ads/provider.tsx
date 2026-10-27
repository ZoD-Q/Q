import { createContext, use, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { FINANCE_AD_CAMPAIGNS } from "./campaigns";
import { displayPreferences } from "./preference-core";
import { adPreferenceStore } from "./preference-store";
import { canShowCampaign, recordDetailClick, recordImpression, type AdSessionCounts, type FinanceAdCategory } from "./policy";

function useAdState() {
  const preferences = useSyncExternalStore(adPreferenceStore.subscribe, adPreferenceStore.getSnapshot, adPreferenceStore.getSnapshot);
  const [counts, setCounts] = useState<AdSessionCounts>({});
  const countsRef = useRef(counts);
  useEffect(() => { void adPreferenceStore.hydrate(); }, []);

  const trackImpression = useCallback((campaignId: string, category: FinanceAdCategory, presentationId: string, now: number) => {
    const campaign = FINANCE_AD_CAMPAIGNS.find(item => item.id === campaignId);
    if (!campaign) return false;
    const allowed = displayPreferences(adPreferenceStore.getSnapshot());
    if (!canShowCampaign(campaign, category, allowed, countsRef.current, presentationId, now)) return false;
    const next = recordImpression(countsRef.current, campaign, category, allowed, presentationId, now);
    if (next !== countsRef.current) { countsRef.current = next; setCounts(next); }
    return true;
  }, []);

  const trackDetailClick = useCallback((campaignId: string, category: FinanceAdCategory, presentationId: string, now: number) => {
    const campaign = FINANCE_AD_CAMPAIGNS.find(item => item.id === campaignId);
    if (!campaign || !canShowCampaign(campaign, category, displayPreferences(adPreferenceStore.getSnapshot()), countsRef.current, presentationId, now)) return false;
    const next = recordDetailClick(countsRef.current, campaignId, presentationId);
    if (next === countsRef.current) return false;
    countsRef.current = next;
    setCounts(next);
    return true;
  }, []);

  return {
    preferences,
    counts,
    trackImpression,
    trackDetailClick,
    setEnabled: adPreferenceStore.setEnabled,
    hideCampaign: adPreferenceStore.hideCampaign,
    retryPreferences: adPreferenceStore.retry,
  };
}

const FinanceAdsContext = createContext<ReturnType<typeof useAdState> | null>(null);

export function FinanceAdsProvider({ children }: { children: ReactNode }) {
  const value = useAdState();
  return <FinanceAdsContext value={value}>{children}</FinanceAdsContext>;
}

export function useFinanceAds() {
  const value = use(FinanceAdsContext);
  if (!value) throw new Error("FinanceAdsProvider missing");
  return value;
}
