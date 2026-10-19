# 本地运行与验收

默认工作流是独立前端设计预览，原有 **QDC 模拟钱包** 后端与验收数据保留。100 个最小单位 = 1.00 Q；没有真实充值、提现或兑换。

## 前端预览

仅需 Node.js 22+，从仓库进入移动端工作区：

```sh
cd mobile
npm install
npm run dev
```

`npm run dev` 只启动 Expo 浏览器预览；`npm run dev:native` 启动原生 Expo 开发。它们不加载后端 `.env`，不检查 API 健康，也不启动 PostgreSQL。网页预览是移动界面，根目录 `web/` 仍为未来独立 Web 产品的位置。

前端检查从 `mobile/` 执行：

```sh
npm run typecheck
npm run lint
npm run test:utils
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
| `EXPO_PUBLIC_API_URL` | 移动端原有 API 客户端的地址；不是默认前端启动的依赖 |

`Q_SEED_DEMO=true` 首次创建 `kai`、`lin`，密码 `Qdemo12345!`，首次各发一次 1000.00 Q。重复启动不会重置资料、余额或补发欢迎金。当前演示余额以已有账本为准。

iOS 模拟器和浏览器的原有 API 客户端默认连接 `127.0.0.1`，Android 模拟器使用 `10.0.2.2`。使用真机或自定义 API 地址时显式设置 `EXPO_PUBLIC_API_URL`，后台也需要绑定设备可达接口。数据库仍只绑定本机回环地址。

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
