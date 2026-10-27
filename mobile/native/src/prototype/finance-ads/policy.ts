export type FinanceAdCategory = "installments" | "insurance" | "finance";
export type AdCopy = Readonly<{ zh: string; en: string }>;
export type FinanceAdCampaign = Readonly<{
  id: string;
  category: FinanceAdCategory;
  enabled: boolean;
  startsAt: string;
  expiresAt: string;
  partner: AdCopy;
  title: AdCopy;
  summary: AdCopy;
  detail: AdCopy;
}>;

export type AdPreferences = Readonly<{
  enabled: boolean;
  hiddenCampaignIds: readonly string[];
}>;

export type AdCampaignCount = Readonly<{
  presentationIds: readonly string[];
  clicks: number;
}>;
export type AdSessionCounts = Readonly<Record<string, AdCampaignCount>>;
export const AD_SESSION_IMPRESSION_LIMIT = 3;

/** Only the open service category enters this policy. No account or financial data. */
export function canShowCampaign(
  campaign: FinanceAdCampaign,
  category: FinanceAdCategory,
  preferences: AdPreferences | null,
  counts: AdSessionCounts,
  presentationId: string,
  now: number,
): boolean {
  if (!preferences?.enabled || !campaign.enabled || campaign.category !== category ||
    preferences.hiddenCampaignIds.includes(campaign.id) || !presentationId || !Number.isFinite(now)) return false;
  const start = Date.parse(campaign.startsAt);
  const end = Date.parse(campaign.expiresAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || now < start || now >= end) return false;
  const presentations = counts[campaign.id]?.presentationIds ?? [];
  return presentations.includes(presentationId) || presentations.length < AD_SESSION_IMPRESSION_LIMIT;
}

/** A placement chooses at most one configured campaign. */
export function selectCampaign(
  campaigns: readonly FinanceAdCampaign[],
  category: FinanceAdCategory,
  preferences: AdPreferences | null,
  counts: AdSessionCounts,
  presentationId: string,
  now: number,
): FinanceAdCampaign | null {
  return campaigns.find(campaign => canShowCampaign(campaign, category, preferences, counts, presentationId, now)) ?? null;
}

export function recordImpression(
  counts: AdSessionCounts,
  campaign: FinanceAdCampaign,
  category: FinanceAdCategory,
  preferences: AdPreferences | null,
  presentationId: string,
  now: number,
): AdSessionCounts {
  if (!canShowCampaign(campaign, category, preferences, counts, presentationId, now)) return counts;
  const previous = counts[campaign.id] ?? { presentationIds: [], clicks: 0 };
  if (previous.presentationIds.includes(presentationId)) return counts;
  return { ...counts, [campaign.id]: { ...previous, presentationIds: [...previous.presentationIds, presentationId] } };
}

/** A click means explicitly opening demo details, never an application or transaction. */
export function recordDetailClick(counts: AdSessionCounts, campaignId: string, presentationId: string): AdSessionCounts {
  const previous = counts[campaignId];
  if (!previous?.presentationIds.includes(presentationId)) return counts;
  return { ...counts, [campaignId]: { ...previous, clicks: previous.clicks + 1 } };
}
