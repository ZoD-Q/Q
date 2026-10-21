# 聊天历史持久化与长私聊修复验收

2026-10-21。源码变更，尚未部署服务器或更新 TestFlight 安装包。旧版仅在内存的 AI 内容无法追回。

## 行为

AI 对话按已鉴权的 Q 账号保存 PostgreSQL 快照；先确认问题及待回答状态已保存，再请求模型。完成、停止与离页保存最终状态。重新登录后分页读取摘要、按需读取正文；排序使用不变的创建时间及 UUID，修改旧对话不会改变分页位置。模型上下文的截取不影响完整历史保存。

同一对话的保存串行执行，未知结果沿用原请求编号和载荷。跨设备版本冲突不会覆盖服务器，可重试同步或明确选择“重载云端版本（替换本机未保存内容）”。重载先等待已发出的保存结束，再读取并替换本机版本；摘要刷新不会单独推进本机正文版本。恢复未完成流时显示已中断，不自动调用模型或执行工具。

每账号最多 100 个对话，每对话最多 2,000 条消息、4 MiB 快照，单条正文最多 1 MiB UTF-8；限制会明确拒绝，不静默删旧记录。当前没有单独删除对话或批量导出界面。异常退出前尚未确认保存的回答片段可能无法恢复；未知保存意图只在当前进程保留。历史无自动到期，删除账号清除在线 AI 快照，普通数据库备份包含历史。

私聊首次取最新 100 条；向前补历史与向后同步新消息分别维护游标。补页按消息身份去重并保持顺序，新消息不因补页或发送回执跳过。当前原生列表使用 `maintainVisibleContentPosition` 保持补页位置。已读仍为累计序号，以实际加载且可见的消息推进。

## 实际验证

以下命令从仓库根目录运行，具体输出保存在本机忽略目录 `.local/history-validation/`。测试数据库为独立 `q_history_test`；页面联调用独立 `q_history_ui`。未使用业务库、真实模型额度或真实插件业务。

- 移动端：`npm --prefix mobile run typecheck`、`lint`、`test:utils`、`test:video`、`test:plugins`、`test:api-workbench`、`test:chat`、`test:account`、`test:social` 全部通过，共 204 项（13 / 10 / 39 / 11 / 56 / 42 / 33）；`export:web` 通过。
- Rust：`cargo fmt --manifest-path backend/Cargo.toml --check`、`cargo clippy --manifest-path backend/Cargo.toml --all-targets --all-features -- -D warnings`、`cargo test --manifest-path backend/Cargo.toml` 通过。
- PostgreSQL：设置专用 `TEST_DATABASE_URL` 后，`cargo test --manifest-path backend/Cargo.toml --test NAME -- --ignored` 的 `postgres`、`ai_history`、`social`、`account_lifecycle`、`social_backup` 通过；AI 流式替身用 `--features ai-test-fixtures --test ai_chat`，插件与续答用 `--all-features --test plugins` / `ai_plugins`，均通过。备份恢复使用匹配本地服务器的 PostgreSQL 17.10 客户端，配置 `Q_PG_BIN_DIR` 和测试角色认证，不读取业务配置。
- AI 账号隔离、相同保存重放、改载荷拒绝、过期版本冲突、并发同版本只有一个成功、创建顺序及同时间分页、注销清除、私有响应 `no-store` 与错误格式均有测试。
- 实际转储恢复：普通私聊与 AI 正文恢复可读，另一账号无权读取 AI 历史；阅后正文和举报内容仍不恢复。
- 桌面与 390px 浏览器实际交互：24 个 AI 对话分页和详情、新问题在模型调用前保存、完整回答保存、刷新重登恢复、切号隔离、窄屏无横向溢出通过。仅模型 SSE 为明确测试替身；账号与历史使用真实 Rust / PostgreSQL。
- 私聊浏览器：250 条旧消息先显示最新页，补两页至第 1 条，再接收新增消息通过；完整页合并及 250+ 条消息的数据库回归通过。
- 隐私页同步说明 AI 保存、期限与注销清理；独立 Web 的 `typecheck`、`lint`、`test`、`build`、`test:e2e` 通过（17 项逻辑、17 项浏览器测试）。本机使用已有 Chromium revision 1232；CI 使用其锁定浏览器。
- 独立只读 review 已完成并复核修复：摘要刷新与正文版本错配、历史路由加载取消、保存重试与重载并发覆盖。

## 未覆盖与部署要求

本轮没有完成新代码的 iOS / Android 设备交互验收，原生长列表位置与前后台行为需继续在设备检查；不以 Web 交互冒充真机验证。Expo 静态 Web 初始加载有既有 React #418 hydration 警告，已用未修改的基线导出复现；本次历史交互成功，未把该警告写成已修复。

CI 增加隔离 PostgreSQL 的 `ai_history` 作业步骤。首次远端运行的 PostgreSQL 17 恢复测试在全部内容断言通过后，因关闭连接尚未被服务器观察到而清理临时库失败；清理改为仅对本测试创建的两个 UUID 临时库使用 `DROP DATABASE … WITH (FORCE)`，不终止配置测试库或业务库连接。远端结果以 MR 最新提交为准。本地仅 PostgreSQL 17.10，17/18 双版本由 CI 执行。合并仍须人工审核，不自动合并或部署。

部署前备份并应用新增迁移，再更新客户端；旧安装包不因此自动保存历史。新迁移后旧 SQLx 程序不能假定可直接回退启动，保留原库，按既有部署恢复流程评估。异地备份不属于本次范围。
