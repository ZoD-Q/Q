# 对话推荐验收记录（2026-11-08）

开发前已获取 GitHub 与 GitLab 的 main/Mandow。两端 main 提交不同但代码树相同；本任务从 GitHub `413009f` 隔离开发，保留桌面旧工作区及已有未提交内容。提交与人工合并入口按仓库长期开发分支规则处理。

## 已运行的检查

| 范围 | 命令/证据 | 结果 |
| --- | --- | --- |
| 移动端 | `typecheck`、`lint`、`test:utils`、`test:video`、`test:plugins`、`test:api-workbench`、`test:account`、`test:social`、`test:chat`、`export:web`（均 `npm --prefix mobile run`） | 全部通过；chat 356、plugins 107；其余纯逻辑分别34/10/16/44/33项 |
| Rust | `cargo fmt --manifest-path backend/Cargo.toml --check`；`cargo clippy --manifest-path backend/Cargo.toml --all-targets -- -D warnings` 及 `--all-features`；`cargo test --manifest-path backend/Cargo.toml` 及 `--all-features` | 通过；库单测115项，另有既存3项迁移单测；默认忽略的数据库用例另行执行 |
| 隔离 PostgreSQL 17.10 | `TEST_DATABASE_URL=… cargo test --manifest-path backend/Cargo.toml --all-features --test <suite> -- --ignored` | postgres 9、account_lifecycle 10、ai_history 2、social 15、plugins 12、ai_plugins 5、recommendations 8、financial_plugins 6、ai_chat 5，全部通过 |
| 合同 | `npm --prefix mobile run api:generate`，生成结果、客户端类型检查 | 通过；未手改生成文件 |
| Web 隐私说明 | `typecheck`、`lint`、`test`、`build`、`test:e2e`（均 `npm --prefix web run`） | 通过；逻辑43项、浏览器77项（含375px） |
| 部署模板 | 8份Shell脚本语法；`python3 -m unittest discover -s backend/deploy -p 'test_*.py'` | 通过81项；未执行部署 |
| Web部署工具回归 | `python3 -m unittest discover -s web/deploy -p 'test_*.py'` | 24项通过，5项因本机无Nginx二进制而跳过；本任务未改Web路由或部署脚本，不把跳过项称为通过 |
| 差异 | `git diff --check`；提交前 `git diff --cached --check` | 检查仅本任务代码、合同、测试与说明；无密钥、数据库或构建产物 |

隔离数据库位于本机回环端口55439，使用专用测试库；未使用55432业务库或服务器业务库。模型与远程响应均为明确的回环替身，未读取或调用实际供应商密钥。新增迁移为加法建表；运行后不编辑已发布迁移，回退功能使用关闭服务端开关。

## 匹配质量与动态接入

`backend/tests/fixtures/recommendations.json` 共166条中英文样例。109条可覆盖需求的离线前三召回命中106条（97.25%）；57条非工具需求误召回1条（1.75%），所有负例均没有确定性推荐。包括精确服务名称、一般任务、多轮补充、闲聊、创作、取消、授权状态与恶意描述。

这些数字只衡量词法召回和确定性规则，**不是实际 Flash 重排准确率**。真实模型端到端前三候选命中率和误推荐率仍需在灰度前独立测量；功能默认关闭。

数据库和目录测试覆盖：未知发布者个人MCP入库后自动召回、其他账号不可见、能力快照指纹与描述更新、授权变化、断开/撤销、模型选择期间状态变化、过期卡、并发点击、目标删除墓碑、幂等键重用、源消息摘要、历史CAS、分页上限及账号注销。没有建设新的全球公共爬取索引，也没有把个人 Card 当成公开发布许可。

## 原生界面与承接

通过显式本地测试模式在 Expo Go 上验证：iPhone 17 Pro / iOS 26.5 专用模拟器，以及 Android API 36 / Pixel 7专用模拟器。两端均连接独立 `q_recommendations_preview` 库与 `recommendation_preview` 回环替身，安装包身份不是正式发行包。

- iOS：中文需求产生推荐，点击未连接的汇丰模拟插件，定位银行列表，添加后返回原问题，继续时创建专属对话，带入原文，显示返回原对话入口。
- Android：英文需求匹配已连接的汇丰模拟插件，展示单张推荐卡，点击后进入专属对话并保存回答。暖色主题下文字、状态、触控区域、窄屏排版可读。
- Android重启前后数据库数量一致：4个会话、2条推荐、2个承接目标、0次业务工具调用；重启没有创建新任务或重放业务。
- 界面使用主题语义色、连续圆角、48点动作和现有字体/动态效果设置。三主题、双语、缩放和减少动态效果的全部组合未逐一做人工设备检查；当前截图和操作不代替TestFlight、Google Play或真机发布验收。

此原生验收证明界面和任务承接，不证明模型完成金融查询。第三方真实OAuth、付费执行、MCP Apps HTML沙箱、真实银行与资金交易均不在本次替身验收的通过范围。

## 独立 review

只读review后修复并复核：推荐抢占最后额度（现预留四次正文调用）、通用模块名称误推荐、多轮澄清的短参数漏召回、失效卡片的错误恢复指引，以及Web标识符存储说明。最新复核无未解决阻断。最终GitHub/GitLab流水线须以实际推送提交为准，人工审核与合并仍由维护者执行；本任务不部署或自动合并。

## 已完成的远端检查

功能提交 `596d0125680977c12bcffe6bc95d9220830e873a` 的 [GitHub push 检查](https://github.com/ZoD-Q/Q/actions/runs/42449513339)、[GitHub PR 检查](https://github.com/ZoD-Q/Q/actions/runs/42450264324)与[GitLab分支流水线 #12268](https://gitlab.kai.com/KAI/oD/ZoD/Q/-/pipelines/12268)已实际通过，包含 PostgreSQL 17/18 矩阵。GitLab的人工打包作业没有运行，不属于本次必要验证，也未执行部署。

GitHub审核入口为 [PR #12](https://github.com/ZoD-Q/Q/pull/12)。后续文档提交的状态以相应审核页最新检查为准，不将上述旧提交结果自动视为后续提交通过。
