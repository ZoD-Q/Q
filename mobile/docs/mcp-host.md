# Q MCP 连接与照片测试插件

2026-10-19。当前实现把「我的连接」与已有目录参考分开。个人连接不要求开发者账号、Registry 或人工上架；连接成功不代表已授权，也不代表已执行业务工具。

## 使用

1. 在 Q 登录后进入「插件 → 我的连接 → 添加插件」。粘贴发布者的 Card、Catalog、介绍页或域名，选择对应入口类型。
2. 查看发现的服务名称、Card 地址与实际 MCP 端点，添加需要的服务。四类发现均由后端执行，不在客户端直接抓取。
3. 需要授权的服务会显示单独的授权状态。在浏览器中完成后回到 Q 检查结果。插件返回 401 不会使 Q 账号退出。
4. 查看工具与参数，先预览调用，再确认执行一次；或者选择「在聊天中使用」，让小Q提出调用。聊天仍须显式确认。完成后可以让小Q使用已存结果继续回答。
5. 查看最近调用可以恢复页面刷新前的记录。`running / unknown` 仅查询状态，不重新发送同一业务调用。

工具定义与结果属于外部数据。模型拿到的工具结果来自服务端按当前用户查询的记录，客户端只提交调用 ID；图片字节、HTML、Apps UI 元数据不会发送给文本模型。模型不得声称看见未输入的图片。工具模式固定关闭深度思考，界面明确显示这一点，避免丢失供应商要求的推理上下文。普通文字对话仍支持深度思考。

重新授权会提升连接的授权版本，并取消旧版本待确认提案；旧账号的工具结果不能回灌到新账号的对话。每份提案保存不可变的连接名称、Card、实际接收端和工具定义，历史不会随服务地址更新而改写。

当前保存上限为每个 Q 账号 100 个连接、5,000 条调用及 64 MiB 调用 JSON 预算；未完成或未知的调用额外预留结果空间。达到上限会拒绝新提案，已有记录的查询、原键恢复与确认仍可用，未知记录和幂等标识不会被清除。历史归档管理尚未提供，需要管理员处理。发现结果最多 20 份、每份候选总计 512 KiB、10 分钟有效，下一次发现会清理过期记录；每个连接最多保留 20 份未过期 OAuth 尝试，新授权会清理过期材料。

## 图片结果

宿主使用标准 `resource_link` 与 `resources/read` 提供原生图片查看器，也展示受支持的内联图片和文字。前后翻页、横向滑动和图片重新读取都不重新执行工具。每次只加载当前一张；切换图片、账号或退出页面会取消读取。标题、作者署名、来源和许可说明保持可见，外部链接只在用户点击后打开。

这是通用结果查看器，不是 MCP Apps HTML 宿主。当前不执行 `ui://` HTML、脚本或 iframe，也不发送 `ui/initialize`；Apps 工具保留文本结果可用。完整 Apps 沙箱/CSP、输入请求交互、后台任务、公共插件索引尚未实现。

## 美女 MCP 测试服务

服务源码在 `backend/examples/beauty_mcp.rs`；图库、许可清单与来源说明在 `backend/examples/beauty-gallery-data/`。`browse_photos` 返回图库资源链接，`random_photo` 返回一张；工具不会在运行中抓取公网图片，也不要求密钥、订阅或付款。名字仅用于测试展示，照片人物不代表与 Q 合作或代言。

普通插件连接只接受公开 HTTPS 目标。测试服务本地监听 `127.0.0.1:8795`；本地联调须显式使用后端 `plugin-test-fixtures` 调试构建和 `Q_MCP_LOCAL_FIXTURE_ORIGIN=http://127.0.0.1:8795`。该例外只允许这个精确回环 origin，不允许整个内网，也不能用于发布构建。

从仓库根目录，两个终端分别运行：

```sh
cargo run --manifest-path backend/Cargo.toml --example beauty_mcp
Q_MCP_LOCAL_FIXTURE_ORIGIN=http://127.0.0.1:8795 cargo run --manifest-path backend/Cargo.toml --features plugin-test-fixtures --bin xiaoq-backend
```

第二条需要已有 `DATABASE_URL`；如使用 `backend/.env`，在 `backend/` 目录运行等价命令，保持数据库与其他服务进程不变。不要同时占用两个 `8787` 进程。前端仍单独启动，不自动启动数据库或任何插件服务。添加的 Card 为 `http://127.0.0.1:8795/server-card.json`。部署到真实 HTTPS 域名后不需要本地例外；部署不在本次任务范围。

## 验证入口

```sh
npm --prefix mobile run test:plugins
npm --prefix mobile run test:chat
npm --prefix mobile run typecheck
npm --prefix mobile run lint
npm --prefix mobile run export:web
cargo test --manifest-path backend/Cargo.toml --all-features
TEST_DATABASE_URL=… cargo test --manifest-path backend/Cargo.toml --all-features --test plugins -- --ignored
TEST_DATABASE_URL=… cargo test --manifest-path backend/Cargo.toml --all-features --test ai_plugins -- --ignored
```

PG 测试创建自己的随机 schema，不删除既有用户或账本；所有供应商测试使用显式回环替身，不读真实模型密钥。客户端测试覆盖提案归属、结果只用 ID 回灌、续答失败重试、图片 MIME 与内容降级。远端 GitLab 流水线、真实第三方 OAuth、iOS/Android 点击与手势须分别记录，不能由纯逻辑测试替代。

本次本地验证（2026-10-19）：101 项客户端测试、类型检查、Lint、Web 导出通过；Rust 格式、默认/全 feature 严格 clippy、46 项单元测试与 18 项隔离 PostgreSQL 测试通过。独立代码审查修复后复核通过。300 张图库照片已完整解码并逐张经实际 MCP `resources/read` 返回，全部 SHA-256 与许可清单一致。

实际联调另外使用本地 Q API 和真实 DeepSeek Flash 完成两次请求：先生成待确认工具提案，确认一次返回 3 张照片，再根据已保存结果续答；重复确认返回同一记录，图片字节经 Q 宿主读取与源文件一致。两次模型请求合计 1,954 tokens。使用新建的本地 QA 账号，验证后撤销测试会话；未修改既有用户与账本。生产部署、真实第三方 OAuth 授权及 Apps HTML 沙箱未验收。浏览器自动操作被本机设置关闭，专用 iOS 模拟器仍受窗口定位/Expo 首次提示限制，未声称通过 iOS/Android 手势或完整点击验收。
