# 内置银行插件与模拟港币账本

2026-10-21 源码合同；不代表服务器、TestFlight 或真实银行已接入。主界面不另建“银行演示”页面：银行在现有插件页添加，在首页对话调用，在钱包查看卡面、余额、转账记录和资金流水。

## 身份与插件

20 家银行为 Q 提供的受信内置 `bank_demo` 插件，使用 `q.bank-demo.<bank_id>` 服务标识及 `urn:q:bank-demo:<bank_id>` 内部身份。它们不是远程 MCP 服务，不声明银行 OAuth、真实绑卡或官方合作。既有远程插件仍为 `remote_mcp`，继续使用原 HTTPS、发现、OAuth/CIMD 和网络隔离规则。

`connection_kind`、`builtin_service_id` 由服务器和数据库约束决定；远程发现/添加请求不接受这些字段，第三方 Card 名称与 `_meta` 不能选择内置执行器。内置 `auth_status=anonymous` 仅表示没有外部银行授权步骤；每次使用仍须有效 Q 登录并检查连接归属。断开连接使未执行提案取消，重新添加不补发模拟资金。

银行 ID：`hsbc / hangseng / bochk / scb / bea / dbs / citi / icbc / ccb / ncb / citic / cmbwinglung / dahsing / fubon / chiyu / shacombank / bocom / za / mox / livi`。名字是场景标识，不代表这些银行向 Q 开放了业务 API。

## 钱包接口

全部使用 Q Bearer，返回 `Cache-Control: no-store`，不接受付款 user_id。字段以 [OpenAPI](openapi.json) 为准。

| 接口 | 行为 |
| --- | --- |
| `GET /v1/banking/wallet` | 只读当前 Q 用户的本人模拟账户、总余额、连接 ID、虚构收款人；空钱包不会自动开户 |
| `POST /v1/banking/connect` | `{bank_ids:[…]}`，1–20 个不同合法 ID；明确添加插件及账户，原子提交；重复相同银行不再次发放额度 |
| `GET /v1/banking/transactions` | 当前用户的模拟转账回执，不含初始化发行；可按 `bank_id` 筛选 |
| `GET /v1/banking/entries` | 当前用户本人账户的初始化、收入、支出分录；不返回虚构收款人或发行账户明细 |

两个列表支持 `limit=1..100`（默认 20）、`cursor` 和可选 `bank_id`，按 `(created_at DESC,id DESC)` 稳定分页。游标是不含秘密的 base64url 时间和 UUID；翻页保持同一筛选，未知或非法字段返回结构化校验错误。`next_cursor=null` 表示结束。

所有金额为整数港分，`currency=HKD`、`mode=demo`。每家新添加银行有两个用户私有的模拟账户：本人 `self` 和虚构陈小明 `demo_chen`，每户首次发行 `10_000_000` 分，即 HK$100,000。20 家本人账户初始合计 HK$2,000,000；不同 Q 用户的账户与陈小明资金空间完全隔离。

## 可调用工具

沿用 `POST /v1/plugins/invocations` 保存提案、`POST …/{id}/confirm` 显式确认、`POST …/{id}/cancel` 取消、`GET …/{id}` 查询；没有第二套执行协议。

| 工具 | 输入 | 输出 |
| --- | --- | --- |
| `bank_balance` | `{}` | 当前连接对应银行的本人模拟余额 |
| `bank_transfer` | `{to_bank_id,recipient:"self"|"demo_chen",amount_minor,memo?}` | 已保存交易回执与本人付款后余额；仅自转返回本人收款后余额 |
| `bank_transactions` | `{limit?:1..20}` | 当前连接银行涉及的最近模拟转账 |

来源银行由受信连接决定，身份由服务端会话决定；工具参数不能指定任意付款人、账号主键、执行器或幂等编号。`amount_minor` 为 1–9,007,199,254,740,991 的整数，实际不能超过可用余额；备注至多 120 个 Unicode 字符且无控制字符。同一账户不能自转。目标银行尚未添加时返回 `BANK_ACCOUNT_UNAVAILABLE`，不会擅自创建账户。

结果包含可读 `content` 文本及 `structuredContent`，业务拒绝返回 `isError=true` 和稳定错误码。转账结果 `kind=bank_transfer`，包含同一个交易 ID、银行/收款对象、金额、备注、时间及入账后的本人余额；陈小明余额不向付款方展示。

## 确认、并发与恢复

模型只能生成提案，不可确认。首页对明确的中/英文银行指令提供本地保守识别，不调用模型；它读取已添加连接、先保存请求与助手编号，再向服务器提交提案。缺字段、歧义、非 HKD、真实手机号、计划时间与多笔指令不降级成即时转账。填写表单只是生成可编辑的聊天文字。

内置确认使用同一个 PostgreSQL 事务锁定有效身份、连接和提案，复核版本、工具定义、状态与期限；随后调用 `ledger::bank_demo`。金额、两条相反分录、缓存余额、原 invocation ID 幂等记录和插件成功结果一起提交。账户按稳定 UUID 顺序锁定，普通账户不可透支。任何提交失败整体回滚；同一提案并发确认返回同一结果。

客户端确认响应丢失时先读取原提案；不得自动重新创建转账。提案准备超时使用已保存助手 UUID 作为同一个幂等键恢复。取消只影响未执行提案，不承诺撤销已记账交易。回执和钱包引用同一交易 ID，重新登录/重启从数据库读取，客户端没有第二套余额。

远程 MCP 的“先保存 running 再调用外部服务”路径保持原样；其 unknown 状态不因新增内置插件而改为可盲目重试。

## 数据与迁移

新增 `2026102102_bank_plugins.sql`；既有迁移及 QDC 表不改写。`ledger::bank_demo` 独占 HKD 余额写入；`banking` 负责受信工具定义、适配及钱包投影。初始化也有完整的发行/入账双分录，数据库约束验证每笔配对、缓存余额与分录总和，已入账交易和分录不可变。

交易不以外键依赖可删除的插件调用。注销 Q 账号会禁用银行模拟账户、清除单独保存的备注和插件私人内容，保留去标识化的最小不可变金额账本、银行/账户标识、时间和原 invocation UUID。新写入在身份锁和数据库触发器下拒绝已停用/删除用户。备份并非即时清除；见 [账号生命周期](account-lifecycle.md)。

升级须先备份，迁移和新版 API/客户端同步。旧 SQLx 程序不能假定可直接连接新增迁移后的库回退；按现有发布流程保留原库并用独立恢复库演练。这次仅在隔离开发/测试库应用，没有升级线上业务数据库。
