# MCP 实现来源与兼容范围

核对日期：2026-10-19。本文件记录 `src/plugins/{network,discovery,protocol,types}.rs` 的来源与有意限制，不替代上游规范或本仓库的[插件接入规范](../plugin-integration.md)。

## 固定来源

| 材料 | 固定版本 |
| --- | --- |
| MCP 核心 TypeScript schema | [`modelcontextprotocol/modelcontextprotocol`，`1155ca460e5097019f32769b38dcba194432e2fb`，`schema/2026-07-28/schema.ts`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/1155ca460e5097019f32769b38dcba194432e2fb/schema/2026-07-28/schema.ts) |
| MCP Server Card v1 schema | [`modelcontextprotocol/ext-server-card`，`526201bbc80231daa40ffcdecfc9da4e54e5dc93`，`schema.ts`](https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/schema.ts) |
| AI Catalog 1.0 材料 | [`Agent-Card/ai-catalog`，`9316f00de22f8baf0a7bb526cf92e27a40ca047e`](https://github.com/Agent-Card/ai-catalog/tree/9316f00de22f8baf0a7bb526cf92e27a40ca047e)；采用仓库接入规范选定的 URL 条目子集 |

前两项通过固定提交的原始文件核对，文件大小分别为 98,426 与 11,529 字节；SHA-256 分别为 `742750af0bb8c716e7030c4977c992b55d1adc4407e9e66997db5846baedc2cd` 与 `f8321e0ada31f32e372bb715c27f917229d02675d52b4fa9a14909df5905f2e9`。本仓库不复制整份上游规范。Catalog 的固定提交用于追溯参考材料，不宣称它已经成为最终标准。

## 实际协议范围

- 逐请求发送 `MCP-Protocol-Version`、`Mcp-Method` 和 `_meta` 中的协议版本、客户端能力；工具调用发送标准 `Mcp-Name` 与合法的 `x-mcp-header` 映射。不发送旧 `initialize` 或会话 ID。运行时先 `server/discover`，再按实际能力请求 tools/resources/prompts。
- 处理 JSON 与 SSE JSON-RPC 响应，校验请求 ID、`resultType`、发现和列表的缓存字段。SSE 收到完整最终响应即可结束读取，服务端保持连接不会阻塞结果交付。`input_required`、服务端请求以及未实现的异步结果显式返回不支持；工具调用不自动重试。
- 工具 schema 使用锁定在 Cargo.lock 的 `jsonschema` 离线校验器。支持明确的 draft 2020-12、2019-09 和 draft-07；限制大小、深度、节点和组合分支。仅支持无环的文档内 JSON Pointer `$ref`，拒绝外部引用、动态/递归引用。正则使用线性时间引擎，不支持的正则或 schema 会排除相应工具。这是有界兼容子集，并非完整 JSON Schema 或完整 MCP 认证。
- 保留工具标准结果，校验结构化输出，要求可理解的文本降级；支持经格式、大小和尺寸校验的 PNG/JPEG/WebP 图片。资源 URI 交还原 MCP 端点，不由宿主直接读取任意 URL。当前客户端能力为 `{}`，未宣称 MCP Apps UI 支持。
- Card 使用官方 v1 字段与 HTTPS Streamable HTTP 端点；Catalog 使用 `specVersion: "1.0"` 与独立 Card URL。页面发现只解析静态链接。Card URL 保留路径、查询参数顺序和重复参数，身份不会按展示名称合并。
- 2026-10-20 补充：官方 Card v1 没有 `owner`/`publisher` 身份认证字段。Q 的可选所有者展示使用 `_meta["com.kaicloudpay.q/owner"].name`，依据 [官方 JSON schema 的 ServerCard 与 MetaObject](https://raw.githubusercontent.com/modelcontextprotocol/ext-server-card/main/schema.json) 和 [命名空间约定](https://github.com/modelcontextprotocol/ext-server-card#schema-url-conventions)。缺失或无效的可选值忽略；它不是运行时协议扩展、账户绑定或权限依据。自动入口识别仅复用现有 Card/Catalog/静态页面发现，不新增 RPC。

## 网络与验证证据

生产网络仅 HTTPS，拒绝凭据 URL、片段和常见秘密查询参数。DNS 的全部地址必须属于支持的公网单播范围；每次连接固定已验证地址并检查实际远端地址。匿名 GET 最多跟随三次重新验证的跳转；OAuth/MCP POST 不跟随跳转，不自动重试。代理、Cookie 与 Referer 不参与转发。请求与响应均有时间和体积上限。

模块内测试覆盖地址/URL 边界、凭据和跳转隔离、Card/Catalog/页面/域名入口、schema 和头映射、JSON/SSE、请求元数据与保持打开的 SSE。协议 fixture 使用独立字面版本、请求 schema 断言及预制响应，避免客户端常量和服务端 fixture 同时写错而自洽。它是可执行的选定协议测试，不等价于第三方 SDK 认证、上游全部 schema 自动生成测试或生产安全审计。测试的实际执行结果以本次合并请求及 CI 日志为准。

`plugin-test-fixtures` 测试代码仅允许显式注入最多四个固定回环 origin，未列入的目标仍执行生产策略。实际本地联调的 `Q_MCP_LOCAL_FIXTURE_ORIGIN` 还要求调试构建与该 feature 同时开启，只允许一个精确的字面回环 origin 和端口；发布构建或未启用 feature 时设置该变量会拒绝启动，没有任意 HTTP/私网访问开关。

本次本地验证记录（2026-10-19）：正式后端 crate 的 `--all-features --lib plugins::` 测试 22 项通过；启用 `ai-test-fixtures,plugin-test-fixtures` 后，`tests/plugins.rs` 的 7 项和 `tests/ai_plugins.rs` 的 1 项被显式执行并全部通过。集成测试在真实 PostgreSQL 的独立随机 schema 中迁移、测试并清理，只访问回环 MCP/OAuth/模型 fixture；覆盖确认并发与重放、所有权、结果未知后的恢复、来源变更、OAuth CIMD/PKCE/state/issuer/resource/刷新及撤销、授权账号切换、保存配额和过期材料清理、模型提议与已保存结果续写。两个集成目标的 `clippy -D warnings` 也通过。实际本地图库与真实模型的额外联调记录见 [MCP 宿主](../../../mobile/docs/mcp-host.md)，它不代表生产插件或真实第三方 OAuth 授权已经验收。
