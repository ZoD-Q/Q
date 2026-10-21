# 小Q · Q makes kai smile

当前阶段是可交互的前端设计原型。首页以大模型对话与输入框为中心，侧栏承载视频创作、插件、分期、保险、理财、钱包、API 工作台、资料和消息。默认白色青蓝主题，同时保留暖色与夜色、中英文切换。

协作开发先读 [根 AGENTS.md](../AGENTS.md) 和 [移动端补充规范](AGENTS.md)。实际插件接入以 [Q 插件规范](../backend/docs/plugin-integration.md) 为准；“我的连接”支持真实 MCP，“目录参考”保留原始目录。

## 打开预览

从项目目录运行：

```sh
cd mobile
npm install
npm run dev
```

浏览器地址通常为 http://localhost:8081 。原生Expo开发用 `npm run dev:native`；终端按i/a可打开已配置的模拟器。当前SDK58需要兼容版本Expo Go。

默认启动只运行前端，不依赖Rust API或PostgreSQL。余额、交易和保险方案仍是界面预览；首页可登录 Q 后通过 Rust API 使用真实 DeepSeek 对话，API 工作台可使用个人可灵凭据生成视频。详见 [工作台说明](docs/video-api-workbench.md)。

视频创作直接预览：http://localhost:8081/?view=video 。创作者广场：http://localhost:8081/?view=creators 。

插件工作台：http://localhost:8081/?view=plugin-workbench 。也可从侧栏「插件工作台」或插件页「接入我的插件」进入。

## TestFlight 发布准备

当前准备版本 `0.1.0 (2)`，图标采用气泡 Q 的清透版本。Apple 团队为 Raimy Ni（`3996RYYTPW`），Bundle ID 为 `com.kaicloud.xiaoq`，App Store Connect 应用 ID 为 `6824424446`，登记名称“小Q - Q makes kai smile”。此前构建 1 于 2026-10-20 12:17（北京时间）上传成功，12:29 确认为 `VALID / READY_FOR_BETA_TESTING`。构建 2 已签名归档，但 Mac 锁定导致上传账号不可读取，尚未上传；100 人外部组已建立，公开链接关闭，未提交 Beta 审核或邀请测试者，真机安装仍待验收。[TestFlight](https://appstoreconnect.apple.com/apps/6824424446/testflight/ios)

当前发布 API 地址为 `EXPO_PUBLIC_API_URL=https://q.kaicloudpay.com`，公网 HTTPS 登录与真实 DeepSeek 流式调用已验证；服务器当前运行 `4af1ed7` 社交版本，见 [部署状态](../backend/deploy/STATUS.md)。该变量只放公开 API 地址，不能包含凭据；服务端密钥不进入移动端环境。Release 不再回落到设备本机地址。

`native/app.config.ts` 在 `Q_STORE_BUILD=1` 或 EAS profile 为 `production` / `testflight` 时检查 API 地址，拒绝空值、HTTP、回环/私网、凭据、查询参数和片段。普通开发与 Web 导出不受此门禁影响。它只检查地址格式，不能替代 DNS、TLS 和真实服务验收；本次原生归档已启用该标志，并将同一公开 API 地址传入 JS 打包环境，后续归档也必须如此。

在已设置实际 `EXPO_PUBLIC_API_URL` 的终端，从 `mobile/native` 运行 `Q_STORE_BUILD=1 npx expo config --type public` 可先执行配置检查。`npm run test:utils` 已包含此门禁的边界测试。Expo Go 和 iOS 资源导出通过，不等于签名 IPA 或 TestFlight 处理成功；上传后还需检查 Apple 构建状态并实际安装验收。

本轮新增账号删除、注册规则确认和 AI 数据分享许可。依赖的新后端及 `https://q.kaicloudpay.com/privacy` 页面尚未部署，不能只上传新客户端就开放公测。发布顺序与数据恢复限制见[公测记录](../backend/deploy/PUBLIC-BETA.md)。

## 页面与交互

- 视频创作：提示词、模型/API Key演示配置、1000品牌选择、每个5%最高50%的模拟优惠、生成/取消/结果、本地发布。
- 创作者广场：内置原创演示短片、上下浏览、暂停/静音/喜欢、本地视频选择与会话内发布，不联网生成或上传。
- 聊天：DeepSeek Flash / Pro、深度思考、多轮上下文、流式回答、停止和手动重试；复用 Q 登录，未接入的搜索和附件明确标注。见 [对话说明](docs/deepseek-chat.md)。
- 插件：真实个人 MCP 连接、四类发现、授权、工具确认、调用恢复与原生图片查看器；另保留指定 Excel 中 139 条记录的目录参考、搜索和本地收藏。使用与本地 300 张照片示例见 [MCP 宿主](docs/mcp-host.md)。
- 插件工作台：四类入口说明与本地链接检查，分步生成 Server Card / Catalog / 介绍页 / 接入清单，可检查粘贴 Card 的关键字段。清楚区分必需、按需交付与添加、授权、首次调用；不联网探测，不提交或接通插件。
- 分期：服务商品、期数选择、每期和总额、完整计划预览。
- 保险：场景、保障比较、所选方案和确认预览。
- 钱包：演示余额、流水筛选、收款与转账流程、渠道选择。
- API 工作台：Q 登录、个人可灵连接、文生视频任务与结果；需单独启动后端并配置加密密钥。
- 资料与消息：复用 Q 身份的资料更新、好友申请与接受、私聊、阅后消息和举报；使用前台轮询，尚无 OS 离线推送或端到端加密。账号隔离、恢复和数据保留边界见 [社交说明](docs/social-chat.md)。三主题与双语继续保留。

演示界面的交互状态保留于本次浏览；AI 历史仅保留本次会话。账号、社交、MCP 连接和 API 工作台任务按各自合同由后端持久化，不能把它们当作刷新即重置的示例数据。

## 目录

根目录保留 `web`、`mobile`、`backend` 三个业务目录，以及 `AGENTS.md` 等必要仓库级文件。

- `native/src/prototype`：界面、设计组件及主动启用的 API 工作台。
- `native/src/app`：Expo路由入口。
- `native/src/screens`、`providers`、`services`：上一阶段API联调实现保留；聊天与工作台复用会话存储和现有身份端点。
- `shared`：由后端OpenAPI生成的共享类型。
- `docs`：设计依据、插件来源与验收记录。
- `../backend`：Rust业务、API合同、数据库和后端开发工具。
- `../web`：独立管理工作台静态演示；普通用户 Web 产品尚未实现，移动端浏览器预览来自 Expo。

## 检查

```sh
npm run typecheck
npm run lint
npm run test:utils
npm run test:video
npm run test:plugins
npm run test:api-workbench
npm run test:chat
npm run test:account
npm run test:social
npm run api:generate
npm run export:web
```

阅读 [设计说明](docs/design-direction.md)、[插件来源](docs/plugin-catalog-source.md)、[验收记录](docs/testing.md)。后续接回API前先读 `../backend/contracts/api.md`。

工作台的功能范围与测试见 [插件工作台说明](docs/plugin-workbench.md)。
