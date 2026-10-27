import { test } from "node:test";
import assert from "node:assert/strict";
import { canShowCampaign, selectCampaign, recordImpression, recordDetailClick } from "./policy.ts";
import { FINANCE_AD_CAMPAIGNS } from "./campaigns.ts";

const campaign = FINANCE_AD_CAMPAIGNS[0];
const enabled = { enabled: true, hiddenCampaignIds: [] };
const now = Date.parse("2026-10-27T00:00:00Z");

test("configured categories select one fictional campaign using only the open category", () => {
  assert.equal(FINANCE_AD_CAMPAIGNS.length, 3);
  for (const category of ["installments", "insurance", "finance"]) {
    const selected = selectCampaign(FINANCE_AD_CAMPAIGNS, category, enabled, {}, "visit", now);
    assert.equal(selected.category, category);
    assert.match(selected.partner.zh, /虚构/);
  }
  const secondCandidate = { ...campaign, id: "second-demo" };
  assert.equal(selectCampaign([campaign, secondCandidate], "installments", enabled, {}, "visit", now), campaign);
});

test("unhydrated preferences, global refusal, campaign refusal and disabled inventory suppress ads", () => {
  for (const preferences of [null, { ...enabled, enabled: false }, { ...enabled, hiddenCampaignIds: [campaign.id] }]) {
    assert.equal(selectCampaign(FINANCE_AD_CAMPAIGNS, "installments", preferences, {}, "visit", now), null);
  }
  assert.equal(canShowCampaign({ ...campaign, enabled: false }, "installments", enabled, {}, "visit", now), false);
  assert.equal(canShowCampaign(campaign, "insurance", enabled, {}, "visit", now), false);
});

test("campaign dates fail closed, include the start, and exclude expiry", () => {
  assert.equal(canShowCampaign(campaign, "installments", enabled, {}, "visit", Date.parse(campaign.startsAt)), true);
  for (const time of [Date.parse(campaign.startsAt) - 1, Date.parse(campaign.expiresAt), Date.parse(campaign.expiresAt) + 1, NaN]) {
    assert.equal(canShowCampaign(campaign, "installments", enabled, {}, "visit", time), false);
  }
  for (const patch of [{ startsAt: "bad" }, { expiresAt: "bad" }, { startsAt: campaign.expiresAt }]) {
    assert.equal(canShowCampaign({ ...campaign, ...patch }, "installments", enabled, {}, "visit", now), false);
  }
});

test("effect replays do not increment views; the third stays visible and a fourth is suppressed", () => {
  let counts = {};
  for (let visit = 1; visit <= 3; visit += 1) {
    const id = `visit-${visit}`;
    counts = recordImpression(counts, campaign, "installments", enabled, id, now);
    assert.equal(counts[campaign.id].presentationIds.length, visit);
    assert.equal(recordImpression(counts, campaign, "installments", enabled, id, now), counts);
    assert.equal(canShowCampaign(campaign, "installments", enabled, counts, id, now), true);
  }
  assert.equal(canShowCampaign(campaign, "installments", enabled, counts, "visit-4", now), false);
  assert.equal(recordImpression(counts, campaign, "installments", enabled, "visit-4", now), counts);
  assert.equal(selectCampaign(FINANCE_AD_CAMPAIGNS, "insurance", enabled, counts, "visit-4", now).category, "insurance");
  assert.equal(canShowCampaign(campaign, "installments", { ...enabled, enabled: false }, counts, "visit-3", now), false);
});

test("only explicit details clicks attached to a displayed presentation count", () => {
  assert.deepEqual(recordDetailClick({}, campaign.id, "unseen"), {});
  const viewed = recordImpression({}, campaign, "installments", enabled, "visit", now);
  assert.equal(recordDetailClick(viewed, campaign.id, "unseen"), viewed);
  const clicked = recordDetailClick(viewed, campaign.id, "visit");
  assert.equal(clicked[campaign.id].clicks, 1);
  assert.equal(clicked[campaign.id].presentationIds.length, 1);
  assert.equal(recordDetailClick(clicked, campaign.id, "visit")[campaign.id].clicks, 2);
});
