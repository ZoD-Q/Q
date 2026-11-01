# GitHub 自动检查

入口为 [checks.yml](workflows/checks.yml)。开发者推送自己的长期分支 `Mandow`、`hera`、`jojo`、`Flechazo` 或更新目标为 `main` 的 PR 时运行；人工合并后的 `main` 也运行。不按路径跳过检查，草稿 PR 也检查。手动触发限于这五条约定分支，其他分支的源码检查会失败。

| 作业 | 验证内容 |
| --- | --- |
| `source-check` | 完整 checkout，检查 PR 合并基线或 push 前后提交的差异格式 |
| `web-check` | Node 24，类型、lint、单元测试、部署脚本、构建、Chromium 桌面/窄屏交互，核对制品版本并保存静态文件与校验和 |
| `mobile-check` | Node 24，类型、lint、全部现有功能测试、OpenAPI 类型再生一致性、Expo Web 导出 |
| `backend-check (PostgreSQL 17/18)` | 两个独立作业，Rust fmt / 各功能 clippy / 单元与示例测试，以及身份、账本、账号生命周期、AI 历史、社交、实际备份恢复、视频、AI、插件和可信只读策略的隔离数据库测试 |
| `deploy-check` | Nginx 配置及发布、备份、监控、接收器和 Web 部署工具测试；不执行部署 |
| `ci-check` | 等待上述全部作业，只有全部成功才通过；失败、跳过或取消不能算通过 |

GitHub 托管 Runner 运行所有检查，不使用个人电脑或业务服务器。PostgreSQL 使用每次作业独立创建、结束即销毁的服务容器，测试账号为公开的一次性配置，并拥有备份恢复测试所需的建库权限；`pg_dump` / `pg_restore` 与矩阵服务主版本一致。作业不读取业务数据库或供应商秘密，不调用真实付款和生产 API。

所有 Actions 固定到已核对的完整提交 SHA，令牌只有 `contents: read`，checkout 不持久保存凭据。只使用 `pull_request`，不使用可读取宿主秘密的 `pull_request_target`。不配置部署、发布、外部监控或自动合并。仓库现有 GitLab 部署流程保持独立。

PR 验证 GitHub 生成的合并提交，push 验证分支提交。`CI_COMMIT_SHA` 映射到实际 checkout 的 `github.sha`，`CI_PIPELINE_ID` 映射到 GitHub run ID，以复用现有制品标记脚本。Web 制品保留 14 天，浏览器失败诊断保留 7 天；它们不是已发布网站。并发组包含事件与分支，同一事件的新提交取消旧运行，push 与 PR 不互相取消。

配置首次提交可以在对应开发分支及 PR 上验证；由人工审核合入 `main` 后，各成员须把最新 `origin/main` 合入自己的长期分支，才能获得该分支的 push 检查。不要自动覆盖其他开发者的分支，也不要直推或自动合并 `main`。

每次检查须核对 Actions 页的具体提交、运行和七个作业（六项验证及一项汇总），不能将本地语法验证当成远端通过。PR 只有最新提交通过后才进入人工合并。具备分支保护能力后，可将稳定名称 `ci-check` 设为必需检查并要求审核；2026-10-30 当前私有仓库相关 API 返回套餐限制 403，尚未设置服务端强制门禁，不能宣称保护已经启用。

语法与容器网络依据：[GitHub workflow 语法](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)、[PostgreSQL 服务容器](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers)。
