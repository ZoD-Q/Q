# 正式后台交接与验收

## 基线和工作区

- 独立工作区：`/Users/kai/.codex/worktrees/q-admin-live/Q`，从已审核GitLab main `e1ecb427004abfd893b4781a230f86e334c7b72d`创建，detached HEAD。
- 同时取得GitHub main `e04453793e28f842c1a4de4f97f762a43b8eb324`；两端tree均为`da8de4fe62aba96532e9ea770d32f0d4122dc3b0`，文件无差异，选择与当时已部署Web一致的GitLab版本作为基线。
- 实现阶段仅在新工作区写入，保留原`q-admin-demo/Q`脏工作区。用户随后授权review通过后提交PR/MR；交付时仅在Mandow工作区干净且分支未被并发推进的前提下快进已验证提交，不重置、不强推、不混入旧演示更新。没有部署。

## 交付行为

`/q-admin/`和原`/q-admin/wallet-payments`进入Q登录，获服务端操作员授权后显示支付队列。正式导航仅四项：审核与退款、结算与储备、汇率状态、支付域审计。导航具有可重载的独立URL，内部切换保留同一已验证会话；离开已接模块、退出、401、刷新和BFCache恢复清理会话/敏感表单。普通Q账号的operator/me返回403后不读取任何操作员列表。

所有业务值来自合同接口。移除原演示目录、状态、趋势、伪署名、场景选择、样例业务操作和全局伪搜索；旧模块地址只显示未接入，无表格或占位数字。检索限已有的订单编号和支付审计订单筛选；没有聚合接口就不展示平台总量。加载/失败/无权限/成功空页/旧结果分开，时点说明区分服务器事件时间与本浏览器接收时间。订单切换与刷新按请求范围锁住旧详情的审批和退款，不能在effect清理前点击旧操作。

界面只使用黑`#000`、青`#0ff`、红`#f00`及同色透明层。旧三主题移除；正文、边框、焦点、图标、表单、错误、选中和禁用均纳入样式检查。禁用理由与状态有文字，不只靠颜色。日期输入使用严格的本机时间文本格式并保留毫秒，避免浏览器日历引入其他色彩；表单错误在页面内显示。dialog明确循环Tab焦点、Escape取消并返回触发控件。跳转链接未聚焦时用clip-path裁剪，聚焦才显示。

8张旧彩色PNG从源码删除，新制品不含mascot目录。Vite关闭public目录复制，独立`/privacy`源仍保留且正文/脚本与main相同，不再作为`/q-admin/privacy.html`重复打包；canonical隐私服务未被改动。

## 真实接口映射

| 功能 | 已接合同接口 | 边界 |
| --- | --- | --- |
| 身份 | `POST /v1/auth/login`、`GET /v1/payments/operator/me`、`POST /v1/auth/logout` | Q身份+服务端maker/checker；令牌仅内存 |
| 订单 | `GET /v1/payments/operator/orders`及`/{id}`；`POST /v1/payments/orders/{id}/proposals`、`/approvals` | 5队列、opaque cursor、精确订单查询；付款人与初审复审隔离，无全量total |
| 退款 | `POST /v1/payments/operator/orders/{id}/refunds`；`GET /operator/refunds/{id}`；同前缀`POST /approve`、`/evidence`、`/verify`、`/unknown`、`/evidence-rejections`；`GET /evidence`、`/document?version=N` | 全额原单、版本与hash绑定、补正历史、最小引用恢复；不从浏览器执行渠道退款 |
| 结算 | `/v1/payments/operator/settlements`列表/导入；`/{id}`、`/by-client-key/{key}`、`/{id}/document`、`/{id}/checks`；`POST /{id}/rechecks`、`/{id}/verify` | 原文件与映射独立校验、两人核材、旧详情失效禁写；operator_verified不代表银行API或换汇 |
| 汇率 | `GET /v1/payments/fx/status`、`POST /v1/payments/fx/activations` | 仅保存的参考价；激活回执匹配原候选及N+1，未知GET恢复再匹配原hash；后续无关代次不确认 |
| 审计 | `GET /v1/payments/operator/audit?limit=20&cursor=…&payment_id=…` | 仅支付域；事件时间来自服务器；未知动作名安全回退，只显示有类型的UUID/hash/版本元数据 |

不存在已授权的全平台用户/会话管理、AI调用总览、插件公共审核、视频运营、全局搜索或统计接口，本轮没有伪接入。已有用户私有API不被当作跨账号管理权限。新增纯前端模块，不改变后端合同或共享生成类型。

## 本地自动验证

所有命令在本工作区根运行：

- `npm --prefix web run typecheck`、`npm --prefix web run lint`通过。
- `npm --prefix web test`：43/43通过。涵盖恢复隔离、金额、证据、审计分页/边界、路由及严格本机时间。
- `npm --prefix web run build`通过。mode为admin且保留sourceDirty事实；生产包无测试API地址、演示目录或彩色图片。
- `npm --prefix web run test:e2e`：77/77通过。覆盖全部正式路径、历史路径、权限、空态/错误/旧结果、same-task切单、审计、原请求恢复、三色/对比、375px中英文、焦点、BFCache。写操作全部由受控回环响应拦截，不访问真实支付系统。
- `bash -n web/deploy/deploy.sh web/deploy/remote.sh`与`git diff --check`通过。
- `Q_NGINX_BIN=<本地Nginx路径> PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s web/deploy -p 'test_*.py'`：29/29通过、0跳过。官方Nginx 1.30.6及PCRE2源码核对官方摘要后，仅在`.local`构建。实际loopback Nginx验证根/深链/重载、同源CSP、no-store、缺文件404、LB回源相对Location与旧IP HTTP→HTTPS行为。不是公网TLS握手验收。

首次浏览器回归发现原生dialog的Tab会离开页面、两个新增FX用例在POST尚未发送时就刷新，以及旧空页文案断言；分别补焦点循环、等待真实提交状态和更新断言后，完整77项通过。没有把这些首次失败算作通过。

## Rust + 隔离PostgreSQL实接口

使用集成负责人提供的`http://127.0.0.1:18788`QA服务和既有隔离数据库，前端`127.0.0.1:5174`；本任务没有重启服务或修改数据库。私有QA凭据仅由本机脚本在内存读取，不打印、不入库。

实际验证maker/checker分别读取订单五队列与真实订单详情、退款只读状态、结算列表、汇率保存状态和支付审计；支付审计各返回11条既有QA事件。普通payer登录后operator/me返回403，页面不挂载操作员导航/数据。所有实际业务请求均为GET；仅身份登录/登出使用POST。没有执行真实或QA业务审批、退款、FX激活、材料导入或其他账本写入。

界面出现的QA业务记录来自Rust/PG返回，不是写进前端的样例。服务端现有队列和结算可为空，页面如实展示当前页。生产接口未做本轮业务调用，不能把本结果称为实账验收。

本地证据（均不入库）：

- `.local/formal-admin-qa/real-api-result.json`：角色、路径、HTTP状态、详情读取与0业务写请求。
- `.local/formal-admin-qa/maker-audit.png`、`checker-fx.png`、`maker-order-detail.png`、`checker-order-detail.png`、`ordinary-denied.png`：真实隔离API页面截图。
- `web/test-results/operators-desktop.png`、`operators-mobile.png`：受控回归中的桌面/375px界面。
- `.local/nginx-route-qa/result.json`、`sources.json`、`test-results.log`：Nginx来源校验、二进制和实际路由验收。

## 发布前限制

- 独立复核已通过，用户已授权提交GitHub PR与GitLab MR；合并与发布仍由人工决定。两端CI断言已改为admin，远端通过状态须在对应提交的实际流水线核验，不能用本地结果替代。
- 必须先更新服务器受信Web helper，再发布admin制品；新旧mode严格交叉核对，保留旧demo制品的受控回退。见[发布流程](deployment.md)。
- 全部正式HTML同源CSP/no-store；官方HTTPS终止后的HTTP回源根跳转为相对Location。缺失旧图片和脚本是404，不回退HTML。
- 未接平台管理模块继续未接入。未做真实资金支付、双审入账、退款、银行清算或生产FX激活，未做原生设备验收；本任务只涉及独立Web。

## 变更文件

- `.github/workflows/checks.yml`
- `.gitlab-ci.yml`
- `AGENTS.md`
- `web/AGENTS.md`
- `web/README.md`
- `web/deploy/deploy_tools.py`
- `web/deploy/test_deploy.py`
- `web/deploy/test_nginx_routes.py`
- `web/docs/deployment.md`
- `web/docs/design.md`
- `web/docs/formal-admin-2026-11-06.md`
- `web/docs/validation.md`
- `web/docs/wallet-payments.md`
- `web/index.html`
- `web/public/mascot/01-running.png`
- `web/public/mascot/02-system-error.png`
- `web/public/mascot/03-thinking.png`
- `web/public/mascot/04-streaming.png`
- `web/public/mascot/05-stream-interrupted.png`
- `web/public/mascot/06-paused.png`
- `web/public/mascot/07-network-offline.png`
- `web/public/mascot/08-complete.png`
- `web/scripts/stamp-build.mjs`
- `web/src/App.tsx`
- `web/src/Dashboard.tsx`
- `web/src/Detail.tsx`
- `web/src/catalog.ts`
- `web/src/domain.test.ts`
- `web/src/domain.ts`
- `web/src/execution-time.test.ts`
- `web/src/payment-audit.test.ts`
- `web/src/payments/AuditPanel.tsx`
- `web/src/payments/FxPanel.tsx`
- `web/src/payments/OrdersPanel.tsx`
- `web/src/payments/PaymentWorkspace.tsx`
- `web/src/payments/RefundPanel.tsx`
- `web/src/payments/SettlementPanel.tsx`
- `web/src/payments/audit-data.ts`
- `web/src/payments/controls.tsx`
- `web/src/payments/execution-time.ts`
- `web/src/payments/payments.css`
- `web/src/payments/session.tsx`
- `web/src/routes.test.ts`
- `web/src/routes.ts`
- `web/src/selectors.test.ts`
- `web/src/selectors.ts`
- `web/src/state.tsx`
- `web/src/styles.css`
- `web/src/ui.tsx`
- `web/tests/admin.spec.ts`
- `web/tests/appearance.spec.ts`
- `web/tests/payments-fx.spec.ts`
- `web/tests/payments-races.spec.ts`
- `web/tests/payments-settlement.spec.ts`
- `web/tests/payments.spec.ts`
- `web/vite.config.ts`
