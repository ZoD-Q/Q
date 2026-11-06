# 钱包支付操作、全额退款与结算证据

本文描述支付操作模块源码，不代表已经部署、发生真实付款或银行结算。基础支付合同见 [payments.md](payments.md)。新增机器合同片段为 [payment-operations.openapi.json](payment-operations.openapi.json)，由集成负责人合入主 OpenAPI 后生成客户端类型。

## 身份和权限

所有端点复用 Q Bearer 身份。maker/checker 来自可信运维环境；没有授予角色、替人登录或切换署名的 HTTP 接口。服务启动接受请求前调用 `sync_operator_policy`：角色集合的摘要和代次在数据库原子同步，相同集合不增代次。每个操作在身份 UUID 锁后持有策略共享锁并核对当前进程摘要；角色切换后旧进程拒绝继续读取/写入。切换角色的部署必须使用统一受控配置，不能让旧配置进程重新执行启动同步而回滚可信配置。

正常入账要求客户、maker、checker 三者不同且都 active，证据、提案与审批匹配；数据库增量触发约束也拒绝付款人自提案/自审批。退款允许既存 active/suspended 客户偿还既存义务，操作员仍须 active、当代角色且不同于客户。暂停不是清除欠款的理由；删除客户不在此例外中。

身份 UUID 排序 → 策略共享锁 → 订单 → 收银台 → 退款记录 → HKD 账户 UUID 排序。角色同步不取得身份锁，避免反向锁死。提案、审批、退款和结算证据操作写同事务不可变审计；审计只保留对象、行为、引用和哈希，不记录商户密钥、原文件、私人自由文本或完整银行流水。

## 操作员读接口

- `GET /v1/payments/operator/me`：当前 UUID、角色和服务端时间。
- `GET /v1/payments/operator/orders`：`queue=verification|first_review|second_review|credited|exceptions`，`limit=1..50`，时间/UUID 游标。退款订单归 exceptions；它们仍保留原付款事实。
- `GET /v1/payments/operator/orders/{id}`：冻结订单、商户/渠道单号、已核实付款时间、证据哈希、当前提案、审批、退款及最多200条操作审计。客户原订单接口继续本人隔离。
- `GET /v1/payments/operator/audit`：全局操作审计（含无 payment_id 的汇率/结算事件），按时间/UUID 分页，可按 payment_id 筛选。

入账仍调用原 `/orders/{id}/proposals` 与 `/approvals`，新接口不会直接改余额或把未核实的付款强制改成功。任何退款申请都阻断该付款继续提案/入账，不能通过普通审批绕过。

## 全额外部退款

只支持原单完整 CNY 实付金额。HKD 金额保持原报价，不能按新汇率重算。此阶段不调用七相退款写接口，不执行付款，不宣称自动退款/退款查询协议已经验证。

1. maker `POST /operator/orders/{id}/refunds`，提交 `client_request_id`、原因。原付款必须已有服务端核实的付款证据；未知是否支付不得猜测退款。每个付款最多一张工单，相同 key/原因/付款重放返回原记录，载荷变化冲突。
2. 已入账订单在身份/订单/账户锁中检查可用余额并足额冻结原 HKD 入账；余额不足拒绝。未入账订单冻结为零且禁止以后普通入账。退款申请与普通入账竞态序列化，不会既退原 CNY 又让 HKD 自由支用。
3. 不同 checker `POST /operator/refunds/{id}/approve {version}`，保存不可变批准时间；状态成为 `approved_external`。人到官方商户后台执行原路全额退款，Q 不代为执行。外部结果未知则 `POST .../unknown {version,notes}`：保留原引用、冻结及义务，不重发退款。备注仅存在受限工单，不写一般日志。
4. 原 maker `POST .../evidence`，提交版本、原始凭证 base64（1–128KiB）、唯一外部引用、实际执行时间和备注。服务端计算 SHA256；执行时间不得早于原付款或退款批准，不得在未来。每份原始凭证进入不可变版本历史；原哈希/引用/时间重放返回原结果。当前附件只有在独立复审明确退回后才能追加新版，不能编辑或删除旧原文。`GET .../{id}/document` 返回原始附件、no-store/nosniff，不执行或内联渲染文件。
5. 原 checker 可 `POST .../evidence-rejections {version,evidence_sha256,reason}` 明确退回当前材料，保存不可变退回理由并进入 `evidence_rejected`，冻结和原退款义务保持。maker 仅追加补正材料，不能因此再次向渠道执行退款。`GET .../evidence` 分页读取所有版本与退回历史，`GET .../document?version=N` 读取指定旧原文；历史引用/hash 永久绑定本退款，补正不能把它们移给其他订单。复审绑定最新工单版本及哈希，旧哈希或旧版本不能批准新材料。
6. 原 checker `POST .../verify {version,evidence_sha256}` 独立核对原材料。仅接受同一工单的已批准、未变更凭证。重复完成返回原结果，不再冲正。
7. 已入账退款在同一事务生成独立 `real_hkd_reversals` 与两条相反分录，引用唯一原交易/付款/退款，更新余额并完成退款；原 credit 交易和分录保持不可变，`payment_id` 原唯一约束保留。未入账退款保存 `failed/refunded` 终态、解除槽位和工作项。没有真实外部凭证不能仅勾选完成。

客户钱包保留 `currency/balance_minor/updated_at`，新增 `frozen_minor/available_minor`；均为 HKD 分，`available=balance-frozen`。账本保留原字段，新增 `kind=credit|refund_reversal` 与可空 `refund_id`；冲正金额为负。客户订单新增可空 `refund_id/refund_version/refund_status/refunded_at`（refund_version随每次退款状态变更递增，客户端必须丢弃已观察版本之前的迟到结果），旧付款状态不被删除。已退款的原已入账订单仍保留 `credited` 历史事实，界面须结合退款字段显示已全额退回，不能只显示充值成功。

余额约束为旧 credit 分录加独立 reversal 分录的总和；user 账户非负且冻结不超过余额，clearing 对手账户允许负值。未完成退款阻止删号；完整外部退回并冲正/解除未入账义务、余额归零后不永久锁号。历史支付和退款记录继续保留。

## 对账与结算材料

`POST /operator/settlements` 接受 maker 原请求号、kind/source、可空银行引用/金额及两份材料：

- `evidence_base64`：规范化 UTF-8 JSON（最多128KiB），服务端计算 `mapping_sha256`。形如 `{ "currency":"CNY", "rows":[{"merchant_order_no":"…","provider_trade_no":"…","gross_minor":100,"channel_fee_minor":1,"net_minor":99}] }`。严格字段、最多200行，整数金额与 `gross-fee=net` 必须成立。`entry_kind` 可为 payment/refund，缺省 payment 兼容旧文件。同订单可以有支付行和退款行，按条目类型及原单/退款引用去重。支付行 gross>0、fee/net非负；退款行须提供 `refund_external_reference`，gross 等于原冻结 CNY 实付的负数，fee/net 可为有界正负数表示扣费/退费。匹配已完成双人核实的真实退款引用、原付款证据，以及已入账订单的独立冲正或未入账订单的已退款终态。新 FX 不改变这些冻结金额。
- `source_document_base64`：原始 PDF/UTF-8 CSV（最多256KiB），`source_document_media_type=application/pdf|text/csv`，服务端计算 `evidence_sha256`。原文作为 opaque 敏感附件存储，不执行公式、PDF脚本、不抓取外链。规范化 JSON 不能代替银行/渠道原材料。

三类记录分别为：

| kind | 币种与核对 | 完成含义 |
| --- | --- | --- |
| order_reconciliation | CNY、非空行；逐行匹配原支付或已核实退款、冻结 CNY 金额及对应入账/冲正/未入账退款终态；支付与退款两类事实分别记录 | 订单与钱包入账对应关系经操作员复核 |
| bank_settlement | CNY、非空行及银行引用/金额；以上核对加 net 合计等于所填银行金额（有界 signed，允许负额/零净额），可含同一订单的支付和退款两行 | 原始银行/渠道材料和批次对应经两人复核，非银行 API 认证 |
| hkd_reserve | HKD、空行及银行引用/正金额；须原始储备材料 | 操作员对所附 HKD 储备凭证的复核，非已执行换汇、客户入账或储备全覆盖证明 |

同kind、原文件哈希与规范化映射哈希的组合不能重复入批；原文件可用于不同对账层次或不同映射批次，新的原文件可提交同映射的纠正材料，日后新的HKD储备凭证也不被空行映射阻挡。原记录保留不覆盖。同kind/币种/银行引用只允许一份operator_verified记录，由数据库部分唯一索引防止并发重复确认；待复核/差异材料可保留多个版本；原key原载荷重放返回同记录。`GET /operator/settlements/by-client-key/{key}` 仅恢复当前 maker 的原请求，不导入/写入、不替换文件；网络未知时先查原key。无需把银行原文件存入浏览器持久化。

`GET /operator/settlements` 分页，`GET .../{id}` 读详情。`GET .../{id}/document?part=source|mapping` 返回权限保护的附件（默认source）；Content-Disposition=attachment、nosniff、no-store。不同 checker 核对两份附件，以 `POST .../{id}/verify {mapping_sha256,evidence_sha256}` 绑定原材料。差异记录不能强行核销。若原材料正确、差异仅因 Q 尚待入账，可 `POST .../{id}/rechecks {}` 以原文件/映射重新核对当前 Q，不必改文件或换请求号。每次计算进入不可变历史，当前 `check_version` 递增，旧差异/时间/计算人始终保留；`GET .../{id}/checks` 分页读取。只有新计算为零差异才进入待复核，仍有差异继续拒绝。正式 verify 在事务内再次计算并留历史，不信先前零差异；若从旧差异发现现已一致，先保存新计算并要求刷新查看，再次独立确认，不能直接跳过材料复核。已正式确认记录不被重查覆盖。记录的 `source_validation=operator_supplied`，`status=operator_verified` 仅表示双人复核，不冒充银行实时确认。

七相旧版文档提供查单、批量订单、退款，未列银行结算批次或外汇兑换协议。本模块不由支付订单推导银行已到账，不把内部 clearing 账户当真实银行储备。CNY 收款、渠道费用、银行净入账、HKD 储备与客户 HKD 债务是不同事实。

## 验证与发布限制

使用隔离 PostgreSQL 17/18：`TEST_DATABASE_URL=… cargo test --manifest-path backend/Cargo.toml --features payments-test-fixtures --test payment_operations -- --ignored`。测试只用回环供应商替身，不请求七相实付/退款，不连接业务库。保留旧迁移；本增量有不可变冲正和原始证据，执行退款后不能回滚到忽略新 journal/冻结的旧服务二进制。停止新写入并前向修复，不删除表或改原交易回退。

真实验收须另由付款人及两位操作员分别完成：微信/支付宝各一笔小额付款、独立审批、恰好一次入账、一笔原路全额退回、渠道/银行真实结算凭证核对；未完成前不能宣称实账/换汇/清算闭环已通过。
