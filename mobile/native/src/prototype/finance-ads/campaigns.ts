import type { FinanceAdCampaign } from "./policy";

/** Fictional demo inventory. No external URLs, real sponsors, rates or revenue claims. */
export const FINANCE_AD_CAMPAIGNS: readonly FinanceAdCampaign[] = [
  {
    id: "demo-installments-overview",
    category: "installments",
    enabled: true,
    startsAt: "2026-01-01T00:00:00Z",
    expiresAt: "2027-12-31T00:00:00Z",
    partner: { zh: "示例伙伴 A（虚构）", en: "Example Partner A (fictional)" },
    title: { zh: "分期信息，一眼看清", en: "A clearer view of installments" },
    summary: { zh: "看看分期方案说明可以怎样呈现。", en: "Preview how installment plan information could appear." },
    detail: { zh: "这张示例卡用于演示分期服务中的广告位置。伙伴、方案与合作关系均为虚构，不提供借款、额度或申请入口。", en: "This sample demonstrates an ad placement in installment services. The partner, plan and relationship are fictional. No lending, credit limit or application is available." },
  },
  {
    id: "demo-insurance-overview",
    category: "insurance",
    enabled: true,
    startsAt: "2026-01-01T00:00:00Z",
    expiresAt: "2027-12-31T00:00:00Z",
    partner: { zh: "示例伙伴 B（虚构）", en: "Example Partner B (fictional)" },
    title: { zh: "保障说明，清晰呈现", en: "Coverage information, clearly presented" },
    summary: { zh: "预览保障范围与条款介绍的展示方式。", en: "Preview a layout for coverage and policy information." },
    detail: { zh: "这张示例卡用于演示保险服务中的广告位置。伙伴和保险内容均为虚构，不提供保单、报价、承保承诺或投保入口。", en: "This sample demonstrates an ad placement in insurance services. The partner and insurance content are fictional. No policy, quote, coverage promise or application is available." },
  },
  {
    id: "demo-finance-overview",
    category: "finance",
    enabled: true,
    startsAt: "2026-01-01T00:00:00Z",
    expiresAt: "2027-12-31T00:00:00Z",
    partner: { zh: "示例伙伴 C（虚构）", en: "Example Partner C (fictional)" },
    title: { zh: "理财信息，慢慢读懂", en: "Make sense of finance information" },
    summary: { zh: "预览服务介绍，了解信息的呈现方式。", en: "Preview how a financial service introduction could look." },
    detail: { zh: "这张示例卡用于演示理财服务中的广告位置。伙伴和服务均为虚构，不推荐投资产品，不承诺收益，也不提供购买入口。", en: "This sample demonstrates an ad placement in finance services. The partner and service are fictional. It does not recommend investments, promise returns or offer purchases." },
  },
];
