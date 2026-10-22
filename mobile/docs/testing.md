# 本地运行与验收

默认工作流是独立前端设计预览，原有 **QDC 模拟钱包** 后端与验收数据保留。100 个最小单位 = 1.00 Q；没有真实充值、提现或兑换。

## 前端预览

仅需 Node.js 22+，从仓库进入移动端工作区：

```sh
cd mobile
npm install
npm run dev
```

`npm run dev` 只启动 Expo 浏览器预览；`npm run dev:native` 启动原生 Expo 开发。它们不加载后端 `.env`，不检查 API 健康，也不启动 PostgreSQL。网页预览是移动界面；根目录 `web/` 已有独立管理工作台静态演示，普通用户 Web 产品尚未实现。

前端检查从 `mobile/` 执行：

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
npm run export:web
npm run api:generate
```

最后一项从 `../backend/contracts/openapi.json` 生成 `shared/src/generated.ts`。

## 可选后端与数据库

复查保留的账号/账本功能时，另开终端，从仓库进入后端：

```sh
cd backend
npm install
npm run db:start
npm run dev
```

后端需要 Rust 工具链，默认 `$HOME/.cargo/bin/cargo`；`Q_CARGO_BIN` 可覆盖。npm 开发依赖单独锁定 `embedded-postgres@17.10.0-beta.17` 和 `pg`。捆绑的是 PostgreSQL 17.10，版本后缀不表示数据库预发行版。无需 Docker、Homebrew 或系统 PostgreSQL，也可使用自备 `DATABASE_URL`。

本地数据库只监听 `127.0.0.1:55432`，默认连接为：

```text
postgresql://xiaoq:xiaoq_demo_local@127.0.0.1:55432/xiaoq_demo
```

数据目录是仓库的 `backend/.local/postgres`，日志和持久性快照也在 `backend/.local/`。首次启动创建数据库，后续启动完整保留数据，辅助脚本从不清库。数据库进程独立于启动命令，需显式正常停止：

```sh
# 在 backend/ 中执行
npm run db:status
npm run db:stop
npm run db:start
```

`db:stop` 使用 PostgreSQL fast shutdown，保留所有已提交记录。目录迁移前生成的物理恢复副本为 `backend/.local/postgres-before-layout.tar`，仅作本机恢复材料，不属于需要提交或分发的源码。

## 配置

`backend/scripts/run-backend.mjs` 读取 `backend/.env`，环境变量优先。默认设置如下：

| 变量 | 默认值与作用 |
| --- | --- |
| `DATABASE_URL` | 上述本地 PostgreSQL；可指定其他 PostgreSQL |
| `Q_BIND` | `127.0.0.1:8787` |
| `Q_CORS_ORIGINS` | `http://localhost:8081` 和 `http://127.0.0.1:8081`；运行依赖 API 的其他端口预览时显式设置 |
| `Q_SEED_DEMO` | 仅连接恰好为默认本地 URL 时默认 `true`，其他数据库默认 `false` |
| `Q_CARGO_BIN` | `$HOME/.cargo/bin/cargo` |
| `Q_API_URL` | API 黑盒测试目标，默认 `http://127.0.0.1:8787` |
| `EXPO_PUBLIC_API_URL` | 客户端默认 `https://q.kaicloudpay.com`；本地测试需显式地址与 `Q_LOCAL_API_TEST=1` |

`Q_SEED_DEMO=true` 首次创建 `kai`、`lin`，密码 `Qdemo12345!`，首次各发一次 1000.00 Q。重复启动不会重置资料、余额或补发欢迎金。当前演示余额以已有账本为准。

普通开发、模拟器与发布客户端统一默认连接 `https://q.kaicloudpay.com`。只有本地测试显式设置 `Q_LOCAL_API_TEST=1` 和 `EXPO_PUBLIC_API_URL`：iOS/浏览器用 `http://127.0.0.1:8787`，Android 模拟器用 `http://10.0.2.2:8787`。原生测试项目使用独立应用标识；数据库仍只绑定本机回环地址。发布配置门禁与剩余准备见 [移动端说明](../README.md#testflight-发布准备)。

## API 验收与只读迁移检查

在 `backend/` 中，API 和数据库运行后可以执行：

```sh
npm run test:api
Q_VERIFY_DATABASE=true npm run test:api
```

黑盒验收会创建两个随机测试账户并记入模拟账本，不消费 Kai/Lin 的余额，不删除旧记录。第二个命令另作只读数据库审计。

只检查搬迁或重启后的数据是否一致时，在没有其他写入的窗口中运行：

```sh
npm run db:snapshot
# 正常停止 API/数据库，完成必要搬迁并重新启动。
npm run db:verify
```

快照只含资料、模拟账户、交易和分录，不保存密码或会话令牌。比对全部资料与账本，同时检查 Kai/Lin 欢迎金各一笔。目录搬迁采用这一只读流程，不重新运行会新增交易的 API 验收。

Rust 检查从 `backend/` 执行：

```sh
$HOME/.cargo/bin/cargo fmt --check
$HOME/.cargo/bin/cargo clippy --all-targets -- -D warnings
$HOME/.cargo/bin/cargo test
TEST_DATABASE_URL=postgresql://xiaoq:xiaoq_demo_local@127.0.0.1:55432/xiaoq_demo \
  $HOME/.cargo/bin/cargo test --test postgres -- --ignored
```

## 本次目录迁移验证

- 根目录可见条目只保留 `web/`、`mobile/`、`backend/`；Git 元数据和忽略规则保留。
- Rust 源码、SQL 迁移、Rust 测试与 Cargo 文件共 11 个文件，迁移前后 SHA-256 完全一致。没有更改业务规则或数据库 schema。
- API 与 PostgreSQL 正常停止后搬迁。停库时的 1308 个数据文件在移动后逐个哈希一致，并保留本机物理恢复包。
- 新路径下 `npm run db:start`、`npm run dev`、HTTP `/health` 和 `npm run db:verify` 通过：5 个资料、21 笔交易及所有账户余额/分录与迁移前完全一致，Kai/Lin 欢迎金仍各一笔。此次没有新增验收账户或转账。
- mobile/backend 各自 `npm install` 成功；workspace 链接指向 `mobile/native` 与 `mobile/shared`。OpenAPI 类型生成成功，脚本语法检查通过。
- 再次正常停止后端和 PostgreSQL 后，从 `mobile/` 执行 `npm run dev -- --port 8083`，Metro `/status` 返回 `packager-status:running`；此时 8787、55432 均没有监听，验证默认前端不依赖后端。临时 8083 预览随后正常停止。
- 目录迁移不重复运行会写入新账本数据的 API 黑盒套件；当前界面设计的类型、lint、导出与视觉验收由前端集成检查单独记录。

## 上一阶段验收记录

- PostgreSQL 17.10 在 `127.0.0.1:55432` 启动成功；重复 start、正常 stop、重复 stop、重新 start、status 均通过。监听地址检查确认为 `127.0.0.1`。
- 脚本语法检查通过。
- API 黑盒和账本只读审计：14 组全部通过；包括 10 路并发余额竞争、6 路同键重放、8 路双向转账，以及同键改成不存在收款人仍返回 409。测试账户为 `qa_mvcbo24v_fecb_a`、`qa_mvcbo24v_fecb_b`。
- Rust API 正常 SIGINT 退出后，带 `Q_SEED_DEMO=true` 重启：4 个资料、16 笔交易、全部余额和分录完全一致；`kai`、`lin` 的欢迎金各仍只有一笔；健康检查返回 200。
- 只读代码审查确认：会话有效期为 7 天，认证时检查过期时间；密码计算使用阻塞线程并限制并发；转账有序锁定双方账号，数据库延迟约束检查每笔借贷和逐账户余额。后端测试另在独立 PostgreSQL schema 验证过期会话返回 401，没有修改公共演示数据。
- Rust 检查：fmt、clippy（所有目标、警告视作错误）通过，7 项单元测试与 3 项独立 PostgreSQL schema 集成测试通过。
- 前端：TypeScript、ESLint、5 项金额/串行任务/会话存储/pending 恢复/错误分类测试通过；最新 Web 静态导出和 Android Hermes bundle 导出通过。OpenAPI 已生成共享 TypeScript 类型。
- 浏览器实际界面：注册新账号、编辑昵称/头像/简介、暖纸/白昼/夜色保存、中英文切换通过；Kai → Lin 的 12.34 Q 转账在两侧余额与流水中可见。已有演示数据完整保留，没有重置钱包。
- 断线恢复的真实端到端验收：独立 8082 QA 预览通过仅本机 8788 临时代理提交 1.23 Q；代理在后端提交成功后延迟响应超过客户端 12 秒超时。页面显示结果未确认；刷新后重新登录 `ui_mvcc3sde`，自动找回原请求但不自动发送；点击重试成功。交易为 `8b4258d1-b181-4e8b-a035-98bb4efa6d5d`，重试前后余额均为 99310 最小单位，该测试转账始终只有 1 笔。临时代理在验收后停止，不属于正式运行依赖。
- iOS：SDK 58 Expo Go 在 iPhone 18 Pro / iOS 27.0 模拟器成功运行，实际显示已登录账户、资料页、语言与来自后端的余额。尚未构建独立签名 IPA，也未做 App Store 发布。
- Android：代码与资源导出通过，但本机缺少 Android system image，未进行 Android 模拟器或真机运行验收。导出通过不等于已完成设备验证。
- 独立前端审查发现并修复：未确认转账跨刷新丢键、旧资料保存响应覆盖、旧退出响应清理新账号、错误语言不随设置更新。最终复核通过。
- 依赖审计仍有上游 Expo 工具链相关的告警，主要涉及 `braces`、`node-forge`、`uuid`；未用会大幅降级依赖的自动修复命令。本交付用于本地开发验收，公开部署前需另行处理依赖与部署加固。

## 第二轮：前端设计原型

- 新入口只使用DesignProvider，没有后台会话恢复、钱包读取或API请求；后端与数据库停止时也可完整浏览。
- TypeScript与ESLint通过，Web静态导出成功。插件176条原始记录逐字段与Excel比对通过，其中139条有展示内容。
- 独立审查修复：中文IME确认候选防误发送、首条消息保留模型选择、资料跨页保留、弹窗键盘避让、长英文选择项换行、钱包弹窗内校验反馈。
- 当前浏览器自动化受Work设置禁用，未将静态导出冒充逐页浏览器点击验收；预览已通过Codex打开请求并提供localhost地址。
- 本轮未修改Rust业务、迁移、账本或原始Excel。目录搬迁已另行核验数据与业务文件哈希一致。
- 新版iOS Expo Go实际运行通过：聊天首页、抽屉侧栏、139条插件目录与详情、分期期数3→6及每期金额400→200、保险比较页均可显示；聊天建议填入及本地发送成功。已看到手机窄屏实际截图。当前模拟器使用硬件键盘，软件键盘遮挡需后续真机复核，未据此宣称全面键盘验收。

## 第三轮：白色青蓝与信息减重（2026-10-18）

- 安装并参考UI UX Pro Max及Anthropic frontend-design；研究记录见ui-research-2026-10-18.md。
- 默认light主题改白底青蓝，暖色/夜色仍可选择。按钮与局部变化使用Expo58兼容Reanimated，并适配减少动态效果。
- 独立审查修复了模型选项切页丢失、消息滚动未遵循减少动态效果、短窗口导航无法滚动；iOS横屏检查后补充左右安全区。
- iPhone18Pro/iOS27实际显示白色新版首页，139插件目录搜索“学一学”返回1条；当前没有后台API请求。
- 桌面浏览器自动化受Work设置限制，软件键盘和最大字体模式未全面实测，不能视作完整多设备认证。

## 第四轮：视频创作与创作者广场

- 用户明确限定为前端原型，不接真实模型；后台与数据库未改动。
- 新增侧栏视频创作、右上创作者广场、提示词/模型/演示API Key/广告品牌/报价/生成取消/结果发布完整交互。
- 1000品牌目录与报价10项检查通过：0/1/10品牌、重复ID、11品牌拒绝、整数金额及小数单位取整。
- iPhone实际选择0→1→10品牌，显示0%→5%→50%，第11品牌呈不可再选；1个时20.00→19.00 Q，2个时20.00→18.00 Q。
- iPhone实际演示Key连接、生成进度、取消保留输入、重新生成完成通过。
- 内置原创5秒短动画已实际播放；切到下一条时上一条暂停。演示素材明确非提示词生成，未真实植入广告。
- 实际完成结果→发布表单→本机发布，带2个广告标记的作品进入列表顶部（1/4）并播放，未上传网络。
- 本地文件picker和web blob生命周期经7项分支检查；未声称完成真实相册/云盘选片的全设备验收。
- TypeScript、ESLint和Web导出通过；Android/真机/软件键盘全覆盖尚未完成。浏览器自动化仍受Work设置限制。

## 可灵 API 工作台（2026-10-19）

- 移动端 typecheck、lint、export:web 通过；工作台边界与恢复测试 8/8，原工具测试 5/5，视频演示测试 10/10。
- Rust fmt、Clippy（all-targets/all-features）、9 项单元测试通过；独立 PostgreSQL 测试库中的既有测试 3/3、视频测试 2/2 通过。视频测试覆盖加密与账号隔离、并发幂等、原键恢复、缺失/不支持结果重新查询、撤销、重定向和大响应保护。
- 浏览器实际操作：本地 Q 登录、保存测试连接、参数选择、明确提交确认、任务从受理到生成中、成功但无可播放结果的提示。检查了 375px 窄屏。
- iPhone 17e / iOS 27 / Expo Go 58：侧栏入口、登录、SecureStore 恢复、跨端读取连接/任务、密钥遮掩和软件键盘。修复添加连接弹层重复键盘避让；连接名称/API Key 输入和保存入口可滚动访问。
- 独立审查修复了确定拒绝后的待确认请求死锁、未知任务阻塞其他创作、账号切换草稿残留、结果缺失后无法再查询、OpenAPI 鉴权声明，以及测试预览数据库 URL 参数绕过。
- 未使用真实可灵密钥或额度，未验证真实供应商视频播放；当前本地 UI 替身故意没有视频输出。Android、完整横屏/最大字体/屏幕阅读器矩阵未验收。没有 GitLab CI，未声称流水线通过。

## 合并后的模拟器联调与修复（2026-10-19）

以已合并的 `19a8b64` 为基线，继续使用 iPhone 17e / iOS 27 / Expo Go 58 和独立 `xiaoq_video_preview`、`xiaoq_video_test` 数据库；没有使用真实供应商凭据或额度。

发现并修复：

1. 成功任务的带签名视频 URL 被永久缓存，手动查询不能刷新。现在可重新查询；最新一次查询才可写回，旧响应不能覆盖新链接。刷新失败保留已成功状态和原安全地址，并显示查询错误。
2. 提交仍在进行时，提前查询可能先把任务变为未知，随后供应商的明确拒绝被忽略。现在未绑定供应商任务 ID 的未知记录可被原提交的明确拒绝正确终结，仍不自动重发。
3. 设备上待确认记录损坏时，连接与历史也无法加载。现在分别读取；可查看历史和撤销连接，新生成继续禁止，损坏记录不被覆盖；会话过期优先清理身份。

回归测试均先复现失败再修复：移动端专项 11/11；Rust 单元 9/9；真实 PostgreSQL 既有 3/3、视频 5/5。typecheck、lint、export:web、fmt、Clippy 通过，独立复审无阻塞项。

模拟器实际操作：恢复已有登录；未知受理和慢响应任务显示待确认，查询原任务后进入生成中；离开工作台再进入仍能恢复任务；数据库确认两条场景各只有一条任务；令测试会话失效后显示重新登录，换用 lin 后连接、任务和草稿均不带入 kai 的数据。原生表单保存与撤销通过，数据库确认撤销后加密凭据已清空。临时 URL 更新及并发顺序由可控供应商/数据库回归验证，未宣称真实生成媒体已播放。Android 和完整字体/无障碍矩阵仍未覆盖。


## TestFlight 配置与仓库对齐（2026-10-19）

在 `0b99f90ef5f78293041bde8ae6b93758c0695933` 基线上恢复本次发布配置，保留已合入的账号、社交、二维码依赖和 GitLab 检查流程。版本为 `0.1.0 (1)`，Bundle ID 为 `com.kaicloud.xiaoq`；新增气泡 Q 图标和显式发布 API 配置检查，Release 不再回落到设备回环地址。

- `npm --prefix mobile ci` 成功，锁文件保持不变。安装审计报告 27 项上游告警（8 moderate、19 high）；未使用会改变依赖基线的自动修复或强制升级。
- `npm --prefix mobile run typecheck`、`lint` 通过。
- 七组测试共 146 项通过、0 失败、0 跳过：`test:utils` 13、`test:video` 10、`test:plugins` 29、`test:api-workbench` 11、`test:chat` 48、`test:account` 16、`test:social` 19。
- `npm --prefix mobile run api:generate` 完成后，`shared/src/generated.ts` 与当前基线无差异。
- 使用 `EXPO_NO_DOTENV=1 EXPO_PUBLIC_API_URL=https://q.kaicloudpay.com Q_STORE_BUILD=1 npm --prefix mobile run export:web` 导出成功，包含首页及四个社交路由。该地址的 HTTPS、登录、真实 DeepSeek 流式和 MCP 公开元数据验收见 [部署状态](../../backend/deploy/STATUS.md)。
- 本轮检查没有操作原生 `ios/` 生成目录、业务数据库或第三方插件；差异检查通过。以上结果不等于签名 IPA、TestFlight 上传或安装成功，Android/真机与完整无障碍矩阵仍未覆盖。

### 原生归档与 Apple 上传（2026-10-20）

- `0.1.0 (1)` 固定使用上述 `0b99f90` 基线加本次发布配置；冻结后新合入的修复不自动包含在该构建中。原生预构建及 115 个 Pods 安装完成；Release 模拟器编译和 App Store 签名归档均成功，归档启用 `Q_STORE_BUILD=1` 与 `EXPO_PUBLIC_API_URL=https://q.kaicloudpay.com`。
- 主应用及四个嵌入框架的签名验证通过。App Store 描述文件与 `com.kaicloud.xiaoq`、团队一致；1024px 图标不透明，iPhone/iPad 方向与启动配置齐全，11 个隐私清单可解析，非豁免加密声明为 false。
- 初次模拟器构建跳过应用签名，导致安全凭据存储初始化失败。恢复模拟器 ad-hoc 签名后，干净安装启动不再出现该错误；真机 Distribution 签名使用独立配置。完整登录、重启恢复及流式对话的原生交互验收因共用窗口未完成，不能将其他聊天替换的安装包当作本构建证据。
- 12:17:21（北京时间）上传返回 `Upload succeeded`、`EXPORT SUCCEEDED`；12:29:39 查询 App Store Connect 确认构建 `a22b6658-c0fc-4a8c-a5b4-19ffdd8ed106` 为 `VALID`、`READY_FOR_BETA_TESTING`，非豁免加密为 false，未过期。外部测试为 `READY_FOR_BETA_SUBMISSION`；未提交 Beta 审核、未邀请测试者，TestFlight 真机安装仍待验收。本地记录位于忽略目录 `.local/testflight/archive/`。
- 上传提示 React、ReactNativeDependencies、hermesvm 三个预编译框架缺少 dSYM；其本地上游包也未提供符号。上传本身成功，但这些框架的崩溃日志符号化不完整。

## 公开测试构建 2 准备（2026-10-20）

在 `160508a` 基线上集成本轮账号生命周期、AI 许可及发布配置，版本为 `0.1.0 (2)`；保留上游社交、插件、图库与应用资料变更。

- 七组 199 项通过且无跳过：utils 13、video 10、plugins 39、api-workbench 11、chat 52、account 42、social 32。typecheck、lint、公开 HTTPS 配置下 export:web、配置正负门禁及差异检查通过；api:generate 前后内容一致，152 个受检输入与 HEAD 前后未变。
- 独立 iPhone iOS 26.5 Release 验收：登录、重启恢复、退出清理、注册规则勾选开关；AI 拒绝时请求计数为 0 且草稿保留，同意后计数为 1，撤回后再次请求需确认。使用独立数据库和明确标记的本机 AI 替身，不等于真实供应商验收。
- 已进入隔离测试账号删除页面并核对内容，最终删除动作尚待授权；iPad、Android、物理设备 TestFlight 及完整无障碍矩阵未覆盖。
- 构建 2 正式签名归档通过，内含公开 HTTPS API，未含本机测试地址或凭据。上传因 Mac 锁定无法读取 Xcode 账号而失败，未取得 Apple 构建 2 处理结果；构建 1 的 VALID 状态不能替代它。

本机证据在忽略目录 `.local/public-beta/validation/` 和 `.local/public-beta/archive/`。后端、隐私页、远端 CI、人工合并与外部 Beta 审核仍须按[公测发布记录](../../backend/deploy/PUBLIC-BETA.md)完成。

## 模拟器默认服务与对话恢复（2026-10-21）

问题复现：Q Public Beta QA / iOS 26.5 中安装的 `0.1.0 (2)` 为此前的本机验收包，实际访问 `http://127.0.0.1:57637/v1/ai/status`。临时服务停止后，聊天与插件登录均无法连接；应用将未知/失败配置统一显示为对话服务不可用。另复现正常慢检查被误报、关闭登录弹窗取消配置检查、一次失败清空最后可用配置三个生命周期问题。

修复：普通客户端默认使用 `https://q.kaicloudpay.com`；本地接口必须选择独立测试应用。Debug/Release 都有单独原生应用构建检查阶段，不依赖 React Native 是否跳过 JS 打包；CocoaPods 配置阶段不把 Pod 标识误当应用标识。状态检查与登录/生成分离，检查中不误报，暂时失败有限重试且保留最后已知状态；重查不自动重发聊天或清空身份。

验证：

- 移动端 typecheck、lint、七组测试通过（utils 23、video 10、plugins 39、api-workbench 11、chat 67、account 42、social 32，共 224 项）；OpenAPI 再生成无差异、Web 导出通过。
- 新测试覆盖慢检查、登录关闭、晚到响应、隐藏取消、重试上限、会话 401、流式回答中重查；构建测试实际执行 Expo 配置与原生检查脚本，覆盖 `SKIP_BUNDLING=1`、Pod 阶段、陈旧项目标识和本地测试隔离。
- 后端 fmt、全功能 clippy、默认单元/中间件测试通过；独立 PostgreSQL 17.10 测试库中身份/账本 3 项、AI 2 项、AI 插件 1 项全部通过。没有操作业务账本。
- 公网 HTTPS 健康、AI 配置、已有验收账号登录/资料、视频/插件连接列表与注销通过。两次短 DeepSeek Flash 验证（回环和公网各一次）均收到 status/delta/done、每次 47 tokens，未输出密钥或账号凭据；服务器代码和配置未修改。
- Release 模拟器实际构建成功，并覆盖安装到出问题的设备，保留应用数据；检查 `.app` 身份、内嵌 JS 和 EXConstants 元数据均指向公网，不含旧 57637 测试端口。关闭 Metro 和诊断服务后重启，首页不再显示不可用；虚构凭据的登录返回明确账号密码错误，说明请求已到达后端。
- 独立复审修复了 Pod 标识误判和 Debug 跳过打包门禁的问题，最终无阻塞项。iOS 26.5 模拟器为实际界面证据，Android、真机与 TestFlight 新包未验收；配置与本次供应商成功不是永久可用性承诺。

### 合并云端历史后的复验

保留同分支 `2fa7477` / `199a953` 的账号历史与恢复检查；修复合并后的状态调用，并补充旧后端首次历史列表 404/405 的显式会话模式。该模式在本次登录内保持，不会因服务器后来升级而静默上传之前的本机对话；网络/5xx、详情或写入失败不触发降级。

合并结果的七组移动端测试 235 项通过（23 / 10 / 39 / 11 / 77 / 42 / 33），类型、lint、接口生成一致性及 Web 导出通过。Rust fmt、全功能 clippy、61 单元及 3 中间件测试通过；隔离 PostgreSQL 的账号生命周期、AI、历史、插件、身份/账本、社交、视频共 45 项及真实 pg_dump/pg_restore 1 项通过。

最终 Release 在问题模拟器重新安装并成功运行：使用现有专用验收账号真实登录，显示旧后端的会话历史说明，发送短文本并得到真实 DeepSeek `OK` 回答，随后退出验收账号。凭据只在受限临时文件和安全输入状态中短暂使用，已清除；没有新增线上账号或业务账本写入。已停止本机 Metro/诊断服务，模拟器应用独立使用长期 HTTPS 后端。

## Hera 公开金融信息页面验证 2026-10-19

工作区 `Q-hera`，基础提交 `4af1ed7`，本次改动未提交。三个正常入口显示六家真实机构的公开信息，不再进入虚构分期、保险和理财方案。数据及来源位于 `native/src/prototype/financial-catalog/catalog.ts`。

- PASS：typecheck、lint、test:utils（11项，含目录检索、官方URL边界及金额逻辑）、test:video、test:plugins、test:api-workbench、test:account、test:social、test:chat、export:web、git diff --check。
- PASS：390×844浏览器中分期关键词筛选、两项对比、详情、阅读清单、官方来源确认层；未登录收藏触发统一登录提示；保险目录可显示；理财按000009搜索并展示风险和费用说明。三个页面截图已保留。
- NOT_RUN：本次没有启动身份后端，未实际登录验收收藏；收藏仅会话内存，不声明跨设备持久化。没有访问机构的认证接口，没有申请、核保、开户或支付。
- NOT_RUN：Android新基线在现有Expo Go中遇到ExpoCrypto模块缺失；iOS需要macOS环境。本次浏览器手机尺寸验证不能替代原生设备验收。
- 来源核对：建设银行、平安商城、易方达、华夏已读取公开页面；招商银行及人保服务大厅正文提取为空，按官方搜索索引核对并在UI明确标注。页面记录日期不是动态行情更新时间，不保证条目在售或个人可申请。

## Hera H01 账号与资料增量验收（2026-10-21）

基线为本地 hera / 4af1ed7，保留既有未提交金融页面。已 fetch：origin/main 为 8d37a03；本次未合并远端新功能，避免覆盖当前工作区。远端已增加聊天历史、注销等功能，后续同步后仍需重验，不能复用本报告直接宣称新基线通过。

修复：账号恢复和资料更新收到 401 时，先清空账号并使共享会话逻辑失效，再尝试删除安全存储。物理删除失败时，其他模块不能再读取旧令牌。两个新增回归测试均先复现失败再通过。资料页面使用账号场景的超时、无效响应与存储失败提示。

PASS：typecheck、lint、test:utils、test:video、test:plugins、test:api-workbench、test:account（18项）、test:social、test:chat、export:web。真实 PostgreSQL 独立 xiaoq_h01_test 数据库中 postgres 3项、social 14项通过；未改 Rust 业务代码或数据库迁移。

Android / KAI_Pixel_7_API_35 / Expo Go 实测：
- 恢复 Hera 已存登录；修改昵称、简介、头像、主题和语言，API读取确认已保存。
- 强制结束 Expo Go 再打开，恢复 Hera 登录及英文、暖纸、修改后的资料。
- 退出后显示未登录；第二个独立 QA 账号登录后显示自身昵称、空简介及中文，不继承 Hera 资料。
- 仅将新 QA 账号会话时间调整为已过期，回到前台后清除身份，显示登录入口。
- 键盘打开时可上滑表单露出登录按钮并成功提交。
- 恢复 Hera 原昵称、空简介、星环头像、暖纸及中文，重新登录；保留模拟器在设置页。

未覆盖：iOS 原生验收、完整字体/无障碍矩阵、真实系统 SecureStore 物理故障（由回归测试注入验证）、跨设备登录。聊天模型未配置，不声称真实对话已通过。未提交、推送、合并或部署。本轮仅完成 H01 增量，不代表 H02 钱包或其余模块完成。

## Hera 上传前整合验证（2026-10-22）

将此前金融目录、会话预览、H01 账号修复及保险全景面板整合到 `origin/main` 的 `de9a6bf` 基线上，目标为长期开发分支 `hera`。保留主线银行插件、账号生命周期及聊天历史功能；理财保持原版三家公司。冲突涉及服务入口、资料页导入、接口合同及验收记录，生成类型从合并后的 OpenAPI 重新生成。

- PASS：typecheck、lint、export:web；移动端七组测试共 287 项（utils 31、video 10、plugins 64、api-workbench 16、account 44、social 33、chat 89）。
- 修复主线原生构建保护测试在 Windows 上硬编码 `/bin/bash` 的执行失败：支持 `Q_TEST_BASH` 指定 Git Bash，传入正斜杠路径；真实保护脚本及全部断言保持执行，未跳过测试。本机使用 `D:\Git\bin\bash.exe`。
- PASS：Rust fmt --check、clippy --all-targets --all-features -- -D warnings、cargo test --all-features；67 项单元、3 项中间件测试通过。
- PASS：独立 `xiaoq_h01_test` PostgreSQL 测试库中 postgres 9 项、social 15 项。其他 ignored 集成测试交由 GitLab 完整流水线执行，不能把本地普通 cargo test 解释为已运行全部 ignored 测试。
- 保险面板 Android 实测与截图对应合并前版本，详见 [保险全景说明](insurance-dashboard.md)。同步主线后的启动预览命令被自动审批检查拦截（仅返回 blocked by policy），没有把合并后模拟器复验记为通过；iOS 未验收。
- 该记录是本地上传前验证，不代表 GitLab 流水线、人工合并或服务器部署已经完成。
