# GitLab 手动部署到内部联调环境

这套流程面向现有 `8.163.108.216` 内部联调服务器，环境名为 `staging/api` 与 `staging/admin`，不是生产就绪声明。开发者推送 `Mandow` / `hera`，检查通过后人工审核并合并 MR；main 自动检查、打包，再人工点击需要更新的组件。Agent 不合并 MR，不启用自动合并。

## 发布与结果

1. main 上 `source-check`、`web-check`、`mobile-check`、`backend-check`（PostgreSQL 17/18）及 `deploy-check` 必须通过。
2. `package-release` 构建当前流水线的确切提交。API 包含程序、`SOURCE_COMMIT`、`MIGRATIONS` 与 `SHA256SUMS`；管理网页来自同流水线的 `web-check` 制品。
3. 在 Pipeline 点击 `deploy-staging-api` 或 `deploy-staging-admin`。两个任务共享资源锁，不能并发。main 前进后旧流水线会被拒绝；必须重新验证新 main。未点击的任务显示 blocked/waiting，不是测试失败。
4. 成功前必须核验服务健康与实际版本。API 同时核对运行容器 image ID 和 `/proc/1/exe` 摘要；管理网页核对 release 目标、文件摘要及 HTTPS smoke。GitLab Environments 显示对应提交、作业和部署结果，作业保留不含凭据的 receipt 制品 30 天。

管理网页地址为 `https://8.163.108.216/q-admin/`。API 暂无可信公网域名，仍走内部入口；不把 localhost 填成 GitLab 外部入口。

## GitLab 配置

- main 必须受保护；`staging/api`、`staging/admin` 受保护且只允许 Maintainer 发布。
- 新增专用 `Q_STAGING_SSH_KEY_B64`（Variable 类型，Masked，Protected，Environment scope `staging/*`，关闭 Expand variable reference）。它是专用 qdeploy 私钥的 base64 单行值，不是个人 SSH 密钥。不能提交、打印到日志或放进制品。
- 禁止 MR 流水线访问 protected variables/runners；普通测试无需这些资源。流水线变量最低角色设为 Maintainer，避免覆盖预定义变量。
- 保留既有共享 Runner；无业务数据库凭据进入检查任务。服务器使用当前作业的短期 `CI_JOB_TOKEN` 向固定 GitLab API 核验 project 197、作业名称、running 状态、pipeline、SHA、main 及当前受保护分支；不创建长期 GitLab API token。
- 关闭 Auto DevOps，保留 Pipelines must succeed；不启用自动回退或自动合并。旧 GitLab 版本若不支持所需 API 或环境权限，先停止启用并升级/调整经过审核的实现。

## 安装与更新服务器入口

运维从已检查的源码目录执行 `backend/deploy/install-ci-receiver.sh`，传入该目录和专用公钥文件；先读脚本并核对目标。安装不会启动应用发布。它安装 root 拥有的固定接收器与可信运行/网页辅助脚本，创建独立 qdeploy 身份及严格 sudo 白名单，SSH 公钥仅允许强制命令，禁止交互、转发与任意命令。主机公钥固定在 `ci_known_hosts`，需通过既有可信 SSH 记录核验后更新，不能自动接受新 key。

接收器不执行上传的 shell、Python、Dockerfile 或 compose；API 使用服务器已存在且 root 拥有的部署配置，网页辅助程序也来自固定可信目录。部署入口和 helper 更新是单独的运维动作，仓库合入不会自动替换这些 root 程序。

当前发布目录的 `backup-policy.sh` 必须与安装版本一致，保留社交临时正文、举报原因与证据的备份排除规则。服务器 `/etc/q/deploy.env` 保持 root 0600，个人供应商密钥与现有配置保留。业务数据库不重建；发布前必须生成并校验新的本地数据库/密钥备份，仍不代表异地备份。

## 失败与恢复

客户端与作业不自动重试。接收器在副作用之前记录持久 pending receipt；结果未知、失败或重复制品不一致都会停止后续发布，避免重复执行业务。记录位于 `/var/lib/q/ci-deploy/`，仅 root 可读。

没有新增迁移、SQLx 历史未变且当前配置与链接仍归本次发布所有时，API 启动失败可以恢复原应用版本。存在待执行迁移、迁移历史无法确认或运维同时修改配置时不自动回退，不恢复数据库备份。运维先核对容器、健康、配置、`_sqlx_migrations` 和 receipt，再决定修复前进或经独立确认的恢复；保留失败记录至受限审计目录后才能解除部署阻塞，不能直接反复点击 Retry。

手工运维修改 `/etc/q/deploy.env`、`/opt/q/current` 或发布目录时也须持有 `/run/lock/q-ci-deploy.lock`。接收器额外检测配置/链接是否变化，发现并发修改就停止。

## 验证与未覆盖事项

本地执行 `python3 -m unittest discover -s backend/deploy -p 'test_*.py'`、网页发布工具测试与 shell 语法检查。它们不代替真实 GitLab token、Runner、服务器和手动发布验收。

启用后的首次真实验收必须记录：配置合入的 main SHA、流水线/作业 ID、两个环境的实际成功记录、健康及版本回执。未完成这些步骤前只能报告代码/安装/配置已完成，不能报告端到端部署通过。iOS/Android 真机、真实支付和供应商实账均不在此部署流程验收范围。


2026-10-19 接线验收：本地 48 项部署测试与 20 项网页发布测试通过；服务器入口已安装，API/admin readiness 通过；专用 SSH 强制命令拒绝任意命令与无效作业 token，非白名单 sudo 被拒绝，当前业务发布版本未改变。GitLab 目前仅建立 `staging/api` 环境记录；环境保护、专用 CI 变量和首次真实作业验收仍待完成，不能据此声明 CD 已启用。
