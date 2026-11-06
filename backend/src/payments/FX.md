# ECB 汇率快照与操作员复核

本说明对应 2026-11-05 源码，不代表已部署。FX 只决定新报价采用的公共汇率，不写钱包余额、不审批付款、不修改已接受报价或订单金额。

## 启动与接入

根集成负责人在迁移完成、PaymentRuntime 和操作员 DB 政策同步后调用：

1. `fx::bootstrap(&pool, &runtime).await?`：留存配置快照作为过渡基线，注册业务政策/自动模式代次；启动重放不改已有证据、获取时间或有效期。
2. `fx::spawn(pool.clone(), runtime.clone())`：返回后台任务句柄，服务关闭时 abort/await。只有明确 `Q_PAYMENT_FX_AUTO_REFRESH=1` 才联网；缺省、空值或 `0` 使用原有人工配置模式，其余值启动失败。

仍需完整、明确版本的支付商户配置和 PaymentPolicy。`rate_max_age_seconds` 上限为 345600（96 小时），不是从进程启动或最近成功轮询开始计时。自动模式只访问固定的 `https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml`，没有可配置来源 URL、代理或重定向；商户密钥不进入 FX 请求。

人工模式继续按当前环境策略中的 rate 报价，状态接口也展示这一份 rate，不会展示自动模式残留的旧 active 行作为正在使用的汇率。其 `snapshot_id=null`、`evidence_verified=false` 表示既有可信运维配置只提供了哈希，系统未冒充拥有或在线验证其原 XML。

## 证据与时间

- `payment_fx_evidence` 不可变保存最多 262144 字节的原始 XML，数据库核验 SHA256 与正文一致；`payment_fx_snapshots` 不可变保存解析结果和证据引用。不得编辑或删除，新的事实追加记录。
- 严格 UTF-8、禁 DTD、限制 4096 XML 节点，核验 ECB Envelope/Cube 命名空间、唯一来源日、唯一大写货币项、完整 CNY/HKD、正数十进制；拒绝零、指数、重复/缺币种、坏 XML 和未来来源日。
- ECB 日 XML没有可信日内发布时间，因此网络快照采用 `source_date 00:00:00 UTC` 作为保守 `rate_at`。抓取时间单独保存；重新下载同日同哈希、304 或重启都不会改原快照的 fetched_at/到期时间。
- `R = ceil(100 × CNY_per_EUR / HKD_per_EUR × 10^8) / 10^8`，使用 checked i128 有理数，无浮点报价。费用/金额继续沿用既有 `quote_math`。
- 初次 bootstrap 保留既有运维快照的原 rate_at/fetched_at，明确标为未验证配置证据；不把配置哈希当成新下载的 ECB XML，也不借切换自动模式续命。

## 后台协调与异常

数据库 singleton 控制行保存 60 秒租约、随机 token、epoch、政策 generation 和捕获的 active snapshot。网络不持事务锁；写回必须同时核验上述围栏、租约尚未过期及当前自动模式。后来的 worker、显式复核或政策变更可以使旧结果失效，不能晚到覆盖。

网络显式禁用环境代理和 HTTP 自动重试。固定 ECB 主机在每次获取时只解析一次，所有地址必须通过既有 `is_public_address` 检查，再 pin 到 HTTPS 客户端；保留原域名 SNI/证书验证，不开放自定义 URL。DNS、TLS、HTTP 和有界正文合计 30 秒，短于租约；不跟随重定向。

接口的 `generation` 是 FX 状态复核代次：业务政策/模式、active/candidate/hold 改变或显式激活会前移，304及相同证据轮询不前移。它与不含 rate 的 `policy_fingerprint` 分开，所以正常汇率更新不让旧报价失效；却能阻止很久以前的复核请求在相同候选再次出现时被重放成新决定。

正常每 15 分钟获取一次；失败按 120/240/480/900 秒退避，不自动重发同一 HTTP 请求。工作循环每 15 秒检查数据库 due 时间，多个进程共同遵守同一调度。网络/HTTP 失败保留最后有效率，但不会延长它；证据过期则新报价关闭。

坏结构、未来/旧日期、同日不同证据、相对当前批准率绝对变化达到 2% 等进入 hold。候选/原证据保留供查看：

- `same_date_rewrite`、`rate_jump`：只有已通过结构、币种、日期和时效校验的不可变候选可显式复核激活。
- 坏 XML、缺币种、未来或过期/倒退来源日没有可人工激活的候选，不能通过填写理由放行。
- 取得与当前已验证 active 证据完全相同且仍有效的干净 XML，可解除没有 review candidate 的临时异常 hold；有待复核跃变/同日改写不能由 304 或恢复旧内容静默消除。
- 更新到后一天、完整合法且未触发异常的正常快照可以自动恢复。hold/旧证据不修改任何已接受报价；hold 作为明确安全停用会拒绝新的供应商订单，原订单按原键恢复始终优先。

GET 状态提供不足 24h、不足 6h、过期、held 四个告警标志和剩余秒数。Worker 还在阈值/hold/失效/采集失败状态变化时写最小 tracing warn，恢复时写 info；同状态每 15 秒检查不重复刷屏。日志仅包含固定告警类别、上次成功采集时间及剩余秒数，不写商户、汇率/金额、证据正文或秘密。进程重启会重新观察并最多报告一次当前异常，未启用自动刷新则没有后台任务日志。

这提供后台 UI 与服务日志告警，可供后续 q-health 监控接入；没有配置外部短信/邮件通道，不表示通知已经送达。

`last_success_at` 包含成功的条件检查（304），只表示采集通路最近一次成功；源日期和 `current.fetched_at/expires_at` 独立保存，不因这项检查时间更新而变新。

## 报价首次切换

新指纹包含商户/凭据版本、费用、额度、时效和审核人政策，排除独立的公共 rate 快照。正常刷新后，原报价在其原 expiry 内按原金额履行，不能用新率重算。

旧版本签名包含整份 policy。首次切换时，create 从原报价不可变 `rate_snapshot` 重建旧版 policy 哈希并与当前业务政策/凭据比较；不能只删除 rate 字段后让所有旧报价失败。费用、额度、时效、审核人或凭据变化仍拒绝旧报价创建新单。订单原键恢复和过期未创建回执仍先于当前配置/FX 就绪检查，因此配置失效不会抹掉原请求。

新充值在 capabilities、报价和创建订单之前，均要求付款人之外仍有有效且互异的 maker/checker 两人组合；不足时返回 `PAYMENT_REVIEWERS_UNAVAILABLE`，不能先收款再发现无人可审。付款人后来被授予审核角色，不影响已有订单按原请求键恢复。

## 操作员状态与显式复核

机器可读合同：`backend/contracts/payment-fx.openapi.json`，由根合并主 OpenAPI 并再生共享类型。

- `GET /v1/payments/fx/status`：普通 Q 会话加当前 maker/checker 角色；核验 B 的 DB 角色摘要/代次。返回 mode/state、当前证据、candidate、FX generation、轮询/错误和告警信息，不返回 XML、商户或密钥。
- `POST /v1/payments/fx/activations`：仅复核当前候选，不接收新 XML、汇率、日期或金额。请求必须提供 `candidate_id`、精确 `evidence_sha256`、状态接口的 `expected_generation` 和去空白后 10–500 字理由（禁控制字符）。

复核流程：操作员先查看来源日期、汇率、原证据哈希及异常原因，在官方来源核实；明确选择该候选并提交上述绑定信息。事务依序锁身份、DB 角色政策、FX singleton，重新校验角色、candidate/hash/generation、原始有效期与可激活原因，追加不可变 `payment_fx_activations` 和操作审计，再切换 active 并使旧 worker 租约失效。不会发起付款或产生账本分录。

普通账号 403；身份失效 401；角色政策变更 409 `PAYMENT_OPERATOR_POLICY_CHANGED`；候选、证据或 generation 改变 409 `PAYMENT_FX_CHANGED`，须重新读取状态，不能盲目重试。无支付配置为 503 `PAYMENTS_UNAVAILABLE`。复核无需另外创建身份或绕过 Q 登录；已撤销角色不能用旧进程的静态 UUID 名单继续操作。

复核响应丢失时先 GET status，核对 active 的 snapshot_id/哈希，不创建新候选、不重复猜测提交。所有正常报价仍保留原指纹与到期时间，FX 复核代次不是报价金额版本。

## 验证与上线边界

`payment_fx` 使用单独 TEST_DATABASE_URL 和随机 schema；测试不访问 ECB 或供应商、不触业务库。覆盖初次新旧报价切换、自动刷新、原金额恢复、304/同日重取/旧 XML/重启不续命、多 worker/过期 lease、坏/未来证据与可复核异常、显式激活、角色/凭据停用、人工模式率与状态一致、24h/6h 告警。

本文件和代码不授权部署。上线前由根按经审核 main 构建/迁移/备份/发布流程验证，保留旧证据和密钥；不要为恢复修改旧快照、旧报价、已执行迁移或账本。
