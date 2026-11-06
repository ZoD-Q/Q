# Q 钱包支付：交互、证据与能力边界

核对日期：2026-11-05。源码提供 CNY 付款、独立 HKD 账本、冻结报价、订单恢复、入账审批与钱包组件，并新增总额/冻结/可用余额、退款版本及补正状态。既有逐动作截图是原交付的历史证据，不自动覆盖新增实现；新版本的原生运行、安装包和部署状态分别验收。接口见[支付合同](../../backend/contracts/payments.md)与[操作合同](../../backend/contracts/payment-operations.md)，运维配置见[操作员说明](../../backend/src/payments/README.md)。

## 参考证据的分层

| 来源 | 实际观察 | 能支持的结论 |
| --- | --- | --- |
| KAI 官方 Web | 登录、会话过期、DEMO 资金账户及空资金流水 | Web 的实际布局、文案和交互；充值及提现显示尚未开放 |
| KAI.COM iOS 1.9.6，构建 141 | 官方包内 HBC 98 的静态分析；加密原生代码未解密 | 支付客户端的金额/方式/核对/状态/恢复流程；不能冒充 iPhone 操作截图或后台执行证据 |
| Q 实际组件的本地 QA | Safari 390×844 中操作源码组件，控制器使用固定数据替身 | 本地组件的排版、禁用状态、文案和交接动作；不是供应商收银台、真实账户或实付结果 |
| Q 回环接口与独立 PostgreSQL 测试 | 本地功能及并发验证 | Q 的合同与资金一致性；不证明商户渠道开通、上线或真实清算 |

KAI Web 缺失的付款页面明确记为“未观察/仅静态参考”。Web DEMO 余额不能代表真实资产。没有生成、拼接或虚构 KAI 原生页面来补齐截图。

## 用户交互与恢复

钱包展示独立 HKD 余额，模拟银行账户作为单独入口保留。余额未读取或读取失败显示未知，不用本地零值掩盖错误。报价前展示服务可用性和已启用渠道；缺失商户、汇率证据、费用、限额或审批配置时保持不可用，不回退到模拟充值。

输入是“希望到账 HKD”；核对页单独显示 HKD 到账、CNY 应付、所含费用、汇率来源、来源日期与有效期。所有金额经过整数最小单位校验，币种不能互换；显示也避免浮点除法改变分值。没有内置 KAI 费率，费用与汇率来自服务端。显式启用后的 ECB 版本化刷新只影响新报价，不改变已接受报价和旧订单。

确认前持久保存原 quote_id、client_request_id、所有者、API origin、方式及 HKD 金额，并在发送前再次确认写入。原生采用 SecureStore WHEN_UNLOCKED_THIS_DEVICE_ONLY；Web 只保存不含令牌的意图。持久化按来源与账号隔离，写入后读回检查；退出登录不删除原付款恢复材料。

网络未知、401、429、前后台切换和重启均保留原键。恢复先查询 Q 原键；只有 Q 的结构化 PAYMENT_NOT_FOUND 才允许重放同一个 Q 幂等创建命令，不授权重发未知的供应商写入。过期报价若从未预留创建，服务端返回持久 failed/not_created 回执；客户端核对该原键回执后才清除意图。另一设备仍有活跃收银台时，发现并保留该阻挡，不能因清除旧意图而允许新付款。

只有 awaiting_payment、未 detach、未到期且链接通过校验时，用户才能显式打开支付页面。confirming、待审批、credited 等状态不能重新打开付款链接。返回 Q 后查询原订单，不把浏览器关闭或回跳作为支付或入账证明。

客户端仅在当前会话、聚焦和前台下安排查询，间隔限制为 5–60 秒，单次窗口最多 20 次；重新激活可开启新窗口。后台取消拥有的请求并暂停定时器，不能宣称系统后台持续轮询。切号、逻辑退出和过时代次阻断后续令牌读取及延迟响应发布。

“切换支付方式”先展示确认：旧订单仍可能完成付款和入账。detach 仅让出收银台入口，不是撤销或退款；原订单继续保留。已入账结果触发重新读取服务端钱包，不在客户端直接加余额。

提现页仅使用 Q 自身已配置的支持地址发起咨询，发送邮件不代表出款受理或完成。没有复制 KAI 的提现/客服地址，也没有自动银行出款、KPS 或自动渠道退款。

退款工单在真实操作员后台处理，客户端只读实际服务端结果。已入账记录进入退款处理时显示冻结与可用金额；退款完成显示原交易冲正，不能继续以绿色“已入账”暗示这笔资金仍可用。新退款版本触发余额重读，旧版本和迟到账号响应不能覆盖当前结果；旧安装包需更新才能完整展示这些附加状态。

## 逐操作截图记录

现有 4 张 KAI 官方 Web、28 张 Q 固定数据 QA 和 4 张 Q 本机隔离接口截图已归档到 wallet-payments/screenshots；图像字节保持不变，没有导出 AX 文本。[归档清单](wallet-payments/screenshots/manifest.json) 记录 SHA256、字节数、尺寸、原始文件名及按同名取最后一条的采集日志。KAI 登录与会话过期两张原件没有对应日志，清单保留空元数据，不补造采集时间或断言。其余有 expected 的日志已与本地对应 AX 文本核对。没有图像文件的操作仍列为待采集。

### KAI 官方 Web 实际观察

| 操作 | 已归档截图 | 范围及结果 |
| --- | --- | --- |
| 打开登录 | [01-login](wallet-payments/screenshots/kai-web/01-login.jpg) | 官方 Web 登录界面；不记录凭据 |
| 会话过期 | [02-session-expired](wallet-payments/screenshots/kai-web/02-session-expired.jpg) | 短会话失效状态 |
| 资产 → 资金 → 资金账户 | [03-demo-funds-account](wallet-payments/screenshots/kai-web/03-demo-funds-account.jpg) | DEMO 余额分项，充值/提现尚未开放 |
| 资金 → 资金流水 | [04-demo-ledger-empty](wallet-payments/screenshots/kai-web/04-demo-ledger-empty.jpg) | 交易/分录组织及空列表，不补造交易 |
| 充值金额、核对、付款、审批、detach | 不适用：Web 入口未开放；仅 iOS HBC 静态参考 | 没有运行态 KAI 原生截图；不能称已完整点击实测 |

### Q 源码组件本地 QA

下表均为实际组件与固定数据替身，Safari 响应式 390×844。测试金额、费率、来源、订单与结果不代表真实服务。交接测试拦截外部访问，没有打开供应商或发起付款。

| 操作 | 已归档截图 | 本地观察 |
| --- | --- | --- |
| 输入 HKD 与微信方式 | [01-amount-wechat](wallet-payments/screenshots/q-web/01-amount-wechat.jpg) | 到账金额输入和默认选择 |
| 切换支付宝 | [02-method-alipay](wallet-payments/screenshots/q-web/02-method-alipay.jpg) | 只改变方式，不提交付款 |
| 核对报价 | [03-quote-review](wallet-payments/screenshots/q-web/03-quote-review.jpg) | HKD/CNY、费用、来源与有效期 |
| 确认并建立订单 | [04-order-creating](wallet-payments/screenshots/q-web/04-order-creating.jpg) | 原请求保存后的创建状态 |
| 等待付款 | [05-awaiting-payment](wallet-payments/screenshots/q-web/05-awaiting-payment.jpg) | 明确标为订单应付金额，待付款状态才提供显式交接 |
| 触发收银台交接 | [06-checkout-handoff](wallet-payments/screenshots/q-web/06-checkout-handoff.jpg) | 按钮被触发，外部跳转受替身拦截 |
| 查询付款确认 | [07-confirming](wallet-payments/screenshots/q-web/07-confirming.jpg) | 不再提供重复打开付款页 |
| 等待入账审批 | [08-credit-review](wallet-payments/screenshots/q-web/08-credit-review.jpg) | 付款确认与余额入账分开 |
| 入账处理状态 | [09-crediting](wallet-payments/screenshots/q-web/09-crediting.jpg) | 固定测试状态，非实账执行截图 |
| 已入账结果 | [10-credited](wallet-payments/screenshots/q-web/10-credited.jpg) | 展示服务端替身的到账结果，不再提供付款入口 |
| 查看待处理空列表 | [11-orders-pending-empty](wallet-payments/screenshots/q-web/11-orders-pending-empty.jpg) | 空状态与刷新入口 |
| 查看历史 | [12-orders-history](wallet-payments/screenshots/q-web/12-orders-history.jpg) | 固定测试订单，不是用户交易记录 |
| 请求切换方式 | [13-detach-confirm](wallet-payments/screenshots/q-web/13-detach-confirm.jpg) | 明确旧订单仍可能完成 |
| 确认解除关联 | [14-detached](wallet-payments/screenshots/q-web/14-detached.jpg) | 保留原订单，未表达退款 |
| 清空金额 | [15-amount-empty](wallet-payments/screenshots/q-web/15-amount-empty.jpg) | 报价按钮禁用 |
| 输入非法精度 | [16-amount-invalid](wallet-payments/screenshots/q-web/16-amount-invalid.jpg) | 明确两位小数限制 |
| 等待报价 | [17-quote-loading](wallet-payments/screenshots/q-web/17-quote-loading.jpg) | 等待期间控件禁用 |

| 等待报价过期 | [18-quote-expired](wallet-payments/screenshots/q-web/18-quote-expired.jpg) | 支付按钮禁用，提示重新获取并核对报价 |
| 报价请求失败 | [19-quote-error](wallet-payments/screenshots/q-web/19-quote-error.jpg) | 提示尚未建立新订单，保留重试入口，不能误报已扣款 |
| 查询失败订单 | [20-order-failed](wallet-payments/screenshots/q-web/20-order-failed.jpg) | 保留原订单编号与查询入口，不自动重付 |
| 查询到期订单 | [21-order-expired](wallet-payments/screenshots/q-web/21-order-expired.jpg) | 禁止重新打开收银台，保留原订单继续核实 |
| 显示人工核实 | [22-review-required](wallet-payments/screenshots/q-web/22-review-required.jpg) | 异常证据不显示为已入账，明确需核实 |
| 网络中断 | [23-network-unknown](wallet-payments/screenshots/q-web/23-network-unknown.jpg) | 显示未知结果并保留原订单、原请求，不建议换单付款 |
| 网络恢复后查询 | [24-network-recovered](wallet-payments/screenshots/q-web/24-network-recovered.jpg) | 恢复原订单查询，不新增付款请求 |
| 服务未就绪 | [25-service-unavailable](wallet-payments/screenshots/q-web/25-service-unavailable.jpg) | 充值不可用，不发放本地模拟余额 |
| 未配置提现地址 | [26-withdrawal-unconfigured](wallet-payments/screenshots/q-web/26-withdrawal-unconfigured.jpg) | 仅解释咨询与未开放边界，没有可发送的提现命令 |
| 深色英文输入页 | [27-dark-english](wallet-payments/screenshots/q-web/27-dark-english.jpg) | 窄屏、英文标签与深色主题下保留金额/方式层级 |
| 暖色英文输入页 | [28-warm-english](wallet-payments/screenshots/q-web/28-warm-english.jpg) | 使用现有语义颜色，主题改变不改变交易语义 |

### Q 正式钱包组件与本机隔离接口

以下画面使用正式 `PaymentWalletEntry`，连接本机 Rust API 和独立 PostgreSQL 测试账户；余额零由接口返回，未接供应商，也不是用户资产。临时验收路由不会随产品提交。

| 操作 | 截图 | 本地观察与设计目的 |
| --- | --- | --- |
| 打开支付钱包 | [29-wallet-isolated-api](wallet-payments/screenshots/q-web/29-wallet-isolated-api.jpg) | 独立 HKD 余额；模拟银行账户单独入口，避免混淆资金性质 |
| 打开提现咨询 | [30-withdrawal-q-support](wallet-payments/screenshots/q-web/30-withdrawal-q-support.jpg) | Q 自有支持地址，不复用 KAI 地址；本次没有点击发送邮件 |
| 点击充值 | [31-wallet-funding-unavailable](wallet-payments/screenshots/q-web/31-wallet-funding-unavailable.jpg) | 接口缺配置时明确不可用，不制造可付款状态 |
| 停止本机接口后刷新余额 | [32-wallet-read-error](wallet-payments/screenshots/q-web/32-wallet-read-error.jpg) | 原余额清为未知值“—”，提示重新读取，不错误显示零或旧余额 |

### iOS 源码组件验收

独立 iOS 27 模拟器、官方 Expo Go 58.0.4，固定数据与内存恢复材料，无供应商调用：

| 动作 | 截图 | 实际结果 |
| --- | --- | --- |
| 输入金额 | [amount-keyboard](wallet-payments/screenshots/q-ios/amount-keyboard.jpg) | 数字键盘输入 100 → 100.5；输入框可见，向上拖动收起键盘后报价按钮可点 |
| 核对报价 | [quote-review](wallet-payments/screenshots/q-ios/quote-review.jpg) | HKD100.50、CNY91.36、费用、来源与倒计时可滚动核对；均为测试值 |
| 切换支付方式 | [detach-sheet](wallet-payments/screenshots/q-ios/detach-sheet.jpg) | 建原订单并切到待付款后，警示、解除关联及保留按钮可见；点击保留关闭弹层 |

本次未验证原生 SecureStore 跨重启、生产 AppShell 安全区、真机或 Android；临时验收顶栏并非正式产品布局。临时路由与主入口改动已在提交前移除/还原。

### 尚无截图的状态与平台

| 项目 | 当前证据 | 截图状态 |
| --- | --- | --- |
| 模拟银行账户切换/返回 | 正式入口接线与实际 TSX 事件检查；原银行钱包函数体保留 | 仅事件验证，未新增此步截图 |
| 单独禁用某个渠道 | 客户端校验测试；服务整体不可用已有第 25 张 | 待采集 |
| 过期原键 not_created 恢复、多设备槽位阻挡 | 控制器/接口测试；报价失败/到期已有第 18–19 张 | 待采集 |
| 401/429、跨重启恢复 | 本地控制器及持久化测试；网络未知/恢复已有第 23–24 张 | 待采集 |
| 切号、退出、聚焦/后台切换 | 钱包会话与取消/代次测试 | 待采集 |
| 邮件打开失败 | 第 30 张已记录配置后的咨询页面；本次未点击发送邮件 | 未触发发送或邮件失败分支 |
| Android、真机、生产安全区、辅助功能与 Reduce Motion | iOS 组件键盘/报价/弹层已有上述实拍；其余需单独验收 | 其余未覆盖 |
| 真实支付、审批运营、到账、退款/提现 | 本次未执行 | 无实账截图；不可用本地替身补足 |

## 完成与发布检查

本地组件测试包含金额精度、未知结果恢复、存储失败、401/429、会话代次、前台轮询、原键重放、付款链接状态、not_created 终态及多设备槽位阻挡。独立 PostgreSQL 验收另见服务端合同。测试数量与结果以最终集成记录为准，不将代码存在或截图打开写成全部验收通过。

提交前运行本次范围所需的移动端类型/规范/功能检查、Web 导出、Rust 检查、隔离数据库测试及生成类型一致性检查。追加修复后重新验证受影响部分。GitHub PR 与 GitLab MR 对应最新提交的各自 CI，人工审核后合并；本工作不自动合并、部署、交易或执行真实付款。
