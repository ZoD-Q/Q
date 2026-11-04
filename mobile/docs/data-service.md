# 金融数据服务（2026-11-03）

M6 理财模块改造（PAYATHON 七模块方案 §2.6，P1·Machine Pay 主对标）：把已在代码中落地的市场数据工具封装为按次付费的数据服务，理财页新增数据服务入口，形成「价格确认 → 支付 → 交付 → 计量回执 → 失败退回」的按量付费业务闭环。

## 服务目录（固定定价，元/次）

| 服务 | 单价 | 交付物 | 来源 |
| --- | ---: | --- | --- |
| 币种快照 | ¥0.05 | 一次链上参考价快照（价格、24h 变化、源方更新时间） | Chainlink · Ethereum |
| 公司公告检索 | ¥0.30 | 一次 SEC EDGAR 申报列表（最多 20 条近期申报） | SEC EDGAR |
| 新闻样本主题分析 | ¥0.50 | 一次 GDELT 去重标题样本与主题计数 | GDELT |
| Pro 理财问答额度 | ¥0.50 | 1 次深度问答额度（对话内消耗） | 小Q · Pro 问答 |

交付层复用 `market-data/client.ts` 的 `requestMarketReport`（匿名只读、512 KiB 上限、超时与来源校验沿用既有实现），付费后返回真实公开数据。

## 业务流程

1. 服务卡展示固定单价、交付物与来源；点击进入确认 Sheet（含查询对象选择、本次费用、扣费后余额、来源与核对日期）。
2. 确认支付后先扣费并生成 `awaiting_delivery` 订单与扣费分录。
3. 交付成功：订单置 `delivered`，展示数据摘要与计量回执（订单号、金额、时间、来源）。
4. 交付失败（网络/限流/无效参数）：`refundOrder` 全额退回，扣费与退回两条分录同屏可核对；已交付订单永不退回。
5. Pro 问答购买后计入额度并在服务卡显示可用次数，作为对话内付费点（Vibe Pay 素材）的计量底座。

## 合规边界（M6 红线逐条执行）

- 定位为「金融信息与数据服务」：只交付公开来源数据与整理结果，不构成投资建议、不承诺收益、不推荐产品（页内固定免责文案）。
- 每项服务标注来源与核对日期（`DATA_SERVICE_REVIEWED_ON`）。
- 计量账本为演示性质：`REAL_CHANNEL_CONNECTED=false`，界面明确标注「演示计量账本，与港币钱包及模拟银行资金完全分开，真实支付宝按量通道接入后替换为真实订单」。充值仅为「领取演示额度」，不宣称真实入金。
- 真实支付接入点：`chargeService` 的扣费事件即未来真实按量订单的挂接点（M1 skill 通道），当前仅在演示账本记账。

## 文件

- `mobile/native/src/prototype/data-service/catalog.ts`：服务目录、定价、合规文案常量
- `mobile/native/src/prototype/data-service/core.ts`：纯函数计量核心（账本/订单/分录/退回/问答额度）
- `mobile/native/src/prototype/data-service/page.tsx`：数据服务页（余额卡、服务卡、确认 Sheet、回执 Sheet、订单与用量）
- `mobile/native/src/prototype/financial-catalog/page.tsx`：理财页新增「金融数据服务」入口卡
- `mobile/native/src/prototype/services/index.tsx`、`app-shell.tsx`、`design.tsx`：路由与导航接入（PageId 新增 `data-service`，侧栏「数据服务」）
- `mobile/native/src/utils/data-service.test.mjs`：目录定价、扣费、交付、退回、问答额度断言

## 验证

- typecheck 通过；`test:utils` 全量 40 项通过（data-service 新增 4 项）。
- 未改动后端、数据库迁移与既有支付（钱包充值）链路；market-data 页面与测试不受影响。
