# DeepSeek 对话

2026-10-19。首页从示例回复改为真实 DeepSeek 文本对话。用户使用已有 Q 账号登录，也可注册 Q 账号；未登录时点击发送会保留草稿，登录后再次点击发送，不自动把草稿发给模型。

## 功能

- 默认 DeepSeek Flash（`deepseek-flash`），可选 Pro（`deepseek-v4-pro`）；深度思考显式开关。旧 `deepseek-chat/reasoner` 标识不再使用。
- 流式显示回答，支持停止、错误提示与手动重试。只有完整回答进入后续上下文，重试不重复用户消息。
- 历史保留本次应用会话；长对话按完整轮次选取最近内容，截取上下文时有提示，不缩短最新用户输入。刷新不会恢复聊天历史。
- 不把原始推理文本混入答案。附件、联网搜索和其他模型尚未接入，页面如实标注。插件工具已通过独立的提案、确认与结果续答链路接入，见 [MCP 宿主](mcp-host.md)；插件模式固定关闭深度思考。
- Chat 与 API 工作台共用 Q 身份。会话变更立即清理旧历史和侧栏标题，原生令牌仍在 SecureStore，浏览器令牌仅在内存。

## 本地运行

密钥只放 `backend/.env` 的 `DEEPSEEK_API_KEY`，不要写入前端、`EXPO_PUBLIC_*`、日志或 Git。该文件需设置仅当前用户读写的权限。供应商地址固定为官方 HTTPS 接口，禁重定向和自动重试；没有配置密钥时会明确显示不可用。

普通使用只启动前端，默认连接长期运行的 `https://q.kaicloudpay.com`。只有明确进行本地接口开发时才分别启动本机后端与前端，且选择独立本地测试模式：

```sh
npm --prefix backend run db:start
npm --prefix backend run dev
Q_LOCAL_API_TEST=1 EXPO_PUBLIC_API_URL=http://127.0.0.1:8787 npm --prefix mobile run dev
```

如果开发数据库已经由另一个 Q 工作区启动，复用其 `DATABASE_URL`，不要同时在同一个端口启动第二份数据目录，也不要删除现有数据。本机 Rust API 是 `127.0.0.1:8787`；前端默认连接公网服务，显式本地测试可用 `EXPO_PUBLIC_API_URL` 配置（仅公开服务地址，不包含模型密钥）。默认 CORS 包含前端 8081；更换预览端口时同步 `Q_CORS_ORIGINS`。

AI 未增加数据库迁移。注册沿用原有身份与模拟钱包流程；聊天不会将 QDC 演示余额作为真实费用扣除。供应商请求使用服务端配置的 DeepSeek 账户。

## 实现和验证

- Rust `backend/src/ai.rs` 负责鉴权后的流式代理、固定模型/地址、请求预算、限流并发、安全错误和取消。消息不落数据库，日志不记录正文或密钥。
- `ai-chat/stream.ts` 解码真正的 SSE 帧，处理 UTF-8 分片、CRLF、注释保活、大小限制、超时和 Abort；意外断流不能算完成。
- `state-model.ts` 负责完整轮次上下文与重试；`use-chat.ts` 绑定请求 ID 和会话代次，防止旧回答写进新对话或新账号。
- `services/session-core.ts` 串行化所有会话存储操作，支持条件删除、过期写入回滚、原子版本快照和变更通知。

```sh
npm --prefix mobile run test:chat
npm --prefix mobile run test:api-workbench
npm --prefix mobile run test:utils
npm --prefix mobile run typecheck
npm --prefix mobile run lint
npm --prefix mobile run export:web
cargo fmt --manifest-path backend/Cargo.toml --check
cargo clippy --manifest-path backend/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path backend/Cargo.toml
TEST_DATABASE_URL=postgresql://USER:PASSWORD@HOST/TEST_DATABASE \
  cargo test --manifest-path backend/Cargo.toml --features ai-test-fixtures --test ai_chat -- --ignored
```

本地模拟供应商和 PostgreSQL 测试不调用真实模型，数据库用独立临时 schema。默认构建不启用测试供应商注入。真实验证使用短文本：直接供应商验证成功后，完整 Q 登录 → Rust → SSE 客户端的两轮对话分别返回“记住了。”与“白桦”，确认上下文能传递；测试登录随后注销。测试创建的专用 `chatqa_` 账号保留为明确的开发验证数据，不清理其他用户或账本。

## 参考

当前模型、thinking 和流协议按 [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) 与 [思考模式说明](https://api-docs.deepseek.com/guides/thinking_mode/) 核对。完整本地合同、事件与预算见 [API 合同](../../backend/contracts/api.md)。

## 本轮验收记录

本地验证：42 项聊天/会话测试，以及工具、视频、插件、API 工作台合计 50 项既有前端回归均通过；类型、Lint、OpenAPI 再生一致性和 Web 导出通过。Rust 格式与全功能静态检查通过，21 项单元/供应商替身测试、10 项隔离 PostgreSQL 集成测试通过。合并期间另一任务停止共享开发数据库造成过一次连接失败，重新启动项目原有数据库后重跑通过，没有重建数据目录。

独立审查覆盖流终止/取消、上游秘密、账号切换、晚到恢复、原子会话清理和大回答分帧，问题修复后复核通过。iOS 已启动新预览，但设备窗口定位工具无法完成专用设备的交互验收；浏览器自动操作当前关闭，Android 未实测。真实两轮模型验收是完整 HTTP/SSE 客户端链路验证，不冒充所有平台点击验收。

## 服务状态与恢复（2026-10-21）

公开 `/v1/ai/status` 只报告该后端是否配置 AI，不验证 DeepSeek 额度或实时可用性。客户端分别显示检查中、尚未配置和检查失败。状态 GET 独立于登录和对话生命周期，关闭登录弹窗、刷新状态不会取消彼此或正在生成的回答。短暂网络失败/超时/5xx 最多尝试三次，间隔 1 秒、3 秒，每次超时 8 秒；格式错误、鉴权错误和错误地址不自动重试。离页取消，重新进入前台或手动重查时重新检查。

失败保留最后一次已知配置，并如实提示它不是当前成功检查；不会因一次状态探测失败清除身份或草稿。没有缓存时必须先取得有效配置才发送。实际聊天 POST 仍不自动重发，用户通过手动重试处理失败，避免重复计费。网络、供应商停机或额度问题仍可能发生，这些恢复措施不是无限可用性承诺。
