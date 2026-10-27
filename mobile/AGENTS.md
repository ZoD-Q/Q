# 小Q 移动端补充规范

先读 [根协作规范](../AGENTS.md)，本文件补充 `mobile/` 的约束。

- 本目录是 npm workspace：`native/` 为 Expo iOS/Android 应用，`shared/` 为传输类型与纯逻辑。独立浏览器产品位于 `../web/`，不要把 Expo 预览宣称为已完成独立 Web 产品。
- `npm run dev` 只启动前端，`npm run dev:native` 启动原生开发。不能把 PostgreSQL 或 Rust API 接入默认 UI 启动链。
- 当前入口是 `native/src/prototype/`，AI 对话、社交、账号资料、MCP 和 API 工作台按用户操作启用真实网络；银行内置模拟插件、钱包 HKD 余额和流水连接服务端；保险、分期、理财等其他页面按实际实现保留设计原型。旧 `screens/`、`providers/`、`services/` 的 API 联调代码仍保留，不顺手删除旧账号、账本或测试。
- 首页已转为市场研究与金融知识，移除账单、分期、储蓄工具入口；旧本地结果保留兼容，`localOnly` 会话和 `localFinance` 消息不得进入云历史、模型或插件请求。公开金融数据只在点击查询时匿名读取，新建研究草稿保留来源与时间、不自动发送、不复制旧财务内容；来源权限和原生/Web 差异见 [公开数据工具](docs/market-data.md)。广告位仅为虚构演示，选择不接收财务或聊天数据，持久拒收不自动恢复。历史计算与广告边界见 [本地财务助手](docs/finance-agent.md)。
- Expo Router 路由放 `native/src/app/`，页面主体、状态和领域逻辑放路由之外。复用已有主题、文案和组件，当前默认 light 白底青蓝，保留 dark / warm、中英文。
- 涉及网络前读 [API 合同](../backend/contracts/api.md)，外部输入做运行时校验。`npm run api:generate` 生成 `shared/src/generated.ts`，不得手改；更改共享合同、依赖锁文件先与集成负责人协调。
- 当前原型语言 `zh/en`、默认主题 `light` 与 API 的 `zh-CN/en`、默认 `warm` 不同；接回时显式转换并保留用户偏好，不能悄悄改 wire 值。
- 原生会话使用 SecureStore；不把服务密钥放客户端。真实供应商 API Key 只作为工作台临时输入，经可信后端加密保存，提交或关闭后清理；原视频演示输入仍不是生产凭据。
- 保留的 Web 联调实现将 Bearer 令牌仅存内存；localStorage 只存无令牌的待确认转账意图，重新登录后按发起人恢复。恢复操作不等于持久化会话令牌。
- 金额用整数最小单位；前端不负责授权或最终余额。未知转账结果保留原幂等键与完整载荷，跨重启恢复；401/429 不能把待确认请求变成新转账。
- 社交与 AI 会话分离；阅后正文只在活动页面内存短时显示，切号、离页、后台和到期时清除。未知消息/举报结果保留原编号，先查询再用原载荷恢复；Web 不持久化令牌、消息正文或举报原因。退出先使共享会话逻辑失效，物理清理失败不得让其他模块恢复旧身份。见 [社交说明](docs/social-chat.md)。
- 插件“目录参考”为 Excel 来源内容，保留 ID、未命名记录与讨论组语义，不按同名去重；“我的连接”为真实个人 MCP 连接。连接开发须读 [插件规范](../backend/docs/plugin-integration.md)。
- 视频只播放活动项，处理后台、遮罩、离开页面与 Reduce Motion；文件取消、替换和卸载时释放临时媒体 URL 和资源。品牌名称不代表广告合作，时长/比例选项不代表真实生成能力。
- 安全区、键盘、窄屏、可访问名称和原生触控尺寸须实际检查。网页灵感用原生组件实现；未来 Apps 容器须符合标准沙箱，不随意执行工具返回的 HTML。
- 从本目录运行 `npm run typecheck`、`npm run lint`，按变更运行 `test:utils` / `test:video`；UI 变更再做 `export:web` 和实际页面检查，原生行为在设备/模拟器验证。只测浏览器不能声称 iOS/Android 已验收。

详细依据：[架构](docs/architecture.md)、[最新设计](docs/ui-research-2026-10-18.md)、[插件来源](docs/plugin-catalog-source.md)、[视频原型](docs/video-prototype.md)、[验收记录](docs/testing.md)。

- DeepSeek 密钥只在服务端。聊天与 API 工作台共用串行会话存储，变更令牌须通知订阅者；旧 401 只条件删除对应令牌，延迟登录写入须有代次 guard。聊天停止应取消上游读取，不能只停止更新文字。见 [对话说明](docs/deepseek-chat.md)。
- 插件调用先保存记录；服务端明确支持并受信的内置余额、流水查询可按当前用户请求自动完成，其他操作展示服务及完整业务内容后确认。普通聊天不展示原始工具名、端点或 JSON；必要技术材料收在高级设置。`unknown` 结果不能重新执行；查询服务端历史恢复。续答须验证保存成功、当前账号/会话及已完成结果，历史重载不自动调用模型。图片通过所属连接的 `resources/read` 按需读取，不能执行工具返回的 HTML。模型只接收服务端已保存的结果 ID，不信客户端工具正文。见 [MCP 宿主](docs/mcp-host.md)。
