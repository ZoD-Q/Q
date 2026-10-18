# 小Q 移动端补充规范

先读 [根协作规范](../AGENTS.md)，本文件补充 `mobile/` 的约束。

- 本目录是 npm workspace：`native/` 为 Expo iOS/Android 应用，`shared/` 为传输类型与纯逻辑。独立浏览器产品位于 `../web/`，不要把 Expo 预览宣称为已完成独立 Web 产品。
- `npm run dev` 只启动前端，`npm run dev:native` 启动原生开发。不能把 PostgreSQL 或 Rust API 接入默认 UI 启动链。
- 当前入口是 `native/src/prototype/` 的设计原型；旧 `screens/`、`providers/`、`services/` 的 API 联调代码仍保留。切换入口或重新接回后端必须是明确任务，不顺手删除旧账号、账本或测试。
- Expo Router 路由放 `native/src/app/`，页面主体、状态和领域逻辑放路由之外。复用已有主题、文案和组件，当前默认 light 白底青蓝，保留 dark / warm、中英文。
- 涉及网络前读 [API 合同](../backend/contracts/api.md)，外部输入做运行时校验。`npm run api:generate` 生成 `shared/src/generated.ts`，不得手改；更改共享合同、依赖锁文件先与集成负责人协调。
- 当前原型语言 `zh/en`、默认主题 `light` 与 API 的 `zh-CN/en`、默认 `warm` 不同；接回时显式转换并保留用户偏好，不能悄悄改 wire 值。
- 原生会话使用 SecureStore；不把服务密钥放客户端。视频 API Key 演示输入应短暂保留并及时清理，示例凭据不是生产凭据。
- 保留的 Web 联调实现将 Bearer 令牌仅存内存；localStorage 只存无令牌的待确认转账意图，重新登录后按发起人恢复。恢复操作不等于持久化会话令牌。
- 金额用整数最小单位；前端不负责授权或最终余额。未知转账结果保留原幂等键与完整载荷，跨重启恢复；401/429 不能把待确认请求变成新转账。
- 当前插件列表仅为 Excel 来源内容展示；保留 ID、未命名记录与讨论组语义，不按同名去重。实际连接开发须读 [插件规范](../backend/docs/plugin-integration.md)。
- 视频只播放活动项，处理后台、遮罩、离开页面与 Reduce Motion；文件取消、替换和卸载时释放临时媒体 URL 和资源。品牌名称不代表广告合作，时长/比例选项不代表真实生成能力。
- 安全区、键盘、窄屏、可访问名称和原生触控尺寸须实际检查。网页灵感用原生组件实现；未来 Apps 容器须符合标准沙箱，不随意执行工具返回的 HTML。
- 从本目录运行 `npm run typecheck`、`npm run lint`，按变更运行 `test:utils` / `test:video`；UI 变更再做 `export:web` 和实际页面检查，原生行为在设备/模拟器验证。只测浏览器不能声称 iOS/Android 已验收。

详细依据：[架构](docs/architecture.md)、[最新设计](docs/ui-research-2026-10-18.md)、[插件来源](docs/plugin-catalog-source.md)、[视频原型](docs/video-prototype.md)、[验收记录](docs/testing.md)。
