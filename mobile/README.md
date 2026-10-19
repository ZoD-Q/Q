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
- 资料与消息：本次浏览的资料保存、三主题、双语，示例好友与会话。

原型交互状态保留于本次浏览，刷新会重置；API 工作台的连接与任务由后端持久化。

## 目录

根目录保留 `web`、`mobile`、`backend` 三个业务目录，以及 `AGENTS.md` 等必要仓库级文件。

- `native/src/prototype`：界面、设计组件及主动启用的 API 工作台。
- `native/src/app`：Expo路由入口。
- `native/src/screens`、`providers`、`services`：上一阶段API联调实现保留；聊天与工作台复用会话存储和现有身份端点。
- `shared`：由后端OpenAPI生成的共享类型。
- `docs`：设计依据、插件来源与验收记录。
- `../backend`：Rust业务、API合同、数据库和后端开发工具。
- `../web`：以后独立Web产品的目录，当前浏览器预览来自Expo。

## 检查

```sh
npm run typecheck
npm run lint
npm run test:plugins
npm run test:chat
npm run export:web
```

阅读 [设计说明](docs/design-direction.md)、[插件来源](docs/plugin-catalog-source.md)、[验收记录](docs/testing.md)。后续接回API前先读 `../backend/contracts/api.md`。

工作台的功能范围与测试见 [插件工作台说明](docs/plugin-workbench.md)。
