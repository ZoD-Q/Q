# GitLab 手动部署到内部联调环境

这套流程面向现有 `8.163.108.216` 内部联调服务器，环境名为 `staging/api` 与 `staging/admin`，不是生产就绪声明。开发者推送 `Mandow` / `hera`，检查通过后人工审核并合并 MR；main 自动检查、打包，再人工点击需要更新的组件。Agent 不合并 MR，不启用自动合并。

## 发布与结果

1. main 上 `source-check`、`web-check`、`mobile-check`、`backend-check`（PostgreSQL 17/18）及 `deploy-check` 必须通过。
2. `package-release` 构建当前流水线的确切提交。构建容器可运行于 Linux ARM64 或 x86_64，程序目标固定为 `x86_64-unknown-linux-gnu.2.36`，打包前验证实际 ELF 架构和加载器。API 包含程序、`SOURCE_COMMIT`、`MIGRATIONS` 与 `SHA256SUMS`；管理网页来自同流水线的 `web-check` 制品。
3. 在 Pipeline 点击 `deploy-staging-api` 或 `deploy-staging-admin`。两个任务共享资源锁，不能并发。main 前进后旧流水线会被拒绝；必须重新验证新 main。未点击的任务显示 blocked/waiting，不是测试失败。
4. 成功前必须核验服务健康与实际版本。API 同时核对运行容器 image ID 和 `/proc/1/exe` 摘要；管理网页核对 release 目标、文件摘要及 HTTPS smoke。GitLab Environments 显示对应提交、作业和部署结果，作业保留不含凭据的 receipt 制品 30 天。

管理网页地址为 `https://8.163.108.216/q-admin/`。API 公网入口为 `https://q.kaicloudpay.com`，经 HTTPS 负载均衡与专属 Nginx 转发至内部网关；`127.0.0.1:18787` 仅供服务器内部运维，不作为 GitLab 外部入口。当前实际发布版本与公测准备状态见 [部署状态](STATUS.md)。

打包使用固定的 `cargo-zigbuild 0.23.4` 与 `ziglang 0.17.0`，仅安装 [工具清单](release-tools.requirements.txt) 中校验过的官方 Linux ARM64/x86_64 wheels，不增加业务运行依赖。更新工具版本时须同步哈希，并在实际 Runner 重新构建、核对下载的制品。`.2.36` 是构建目标设置，不能替代实际动态依赖与运行兼容性验收。用 [cargo-zigbuild 官方方式](https://github.com/rust-cross/cargo-zigbuild#specify-glibc-version) 显式指定目标，避免把 Runner 标签或宿主 `uname` 当作产物架构证明。

## GitLab 配置

- main 必须受保护；`staging/api`、`staging/admin` 受保护且只允许 Maintainer 发布。
- 新增专用 `Q_STAGING_SSH_KEY_B64`（Variable 类型，Masked and hidden，Protected，Environment scope `staging/*`，关闭 Expand variable reference）。它是专用 qdeploy 私钥的 base64 单行值，不是个人 SSH 密钥。不能提交、打印到日志或放进制品。
- 禁止 MR 流水线访问 protected variables/runners；普通测试无需这些资源。流水线变量最低角色设为 Maintainer，避免覆盖预定义变量。
- 保留既有共享 Runner；无业务数据库凭据进入检查任务。服务器必须使用当前作业的短期 `CI_JOB_TOKEN` 向固定 GitLab `/job` 核验 project 197、作业名称、running 状态、pipeline、SHA 与 main。旧 GitLab 的当前分支查询可使用下节单独授权、短有效期的项目只读凭据；它不能替代作业身份校验。
- 关闭 Auto DevOps，保留 Pipelines must succeed；不启用自动回退或自动合并。旧 GitLab 版本若不支持所需 API 或环境权限，先停止启用并升级/调整经过审核的实现。

## GitLab 18.2.8 的可选只读分支凭据

本实例 Help 页面已核对为 GitLab Enterprise Edition `18.2.8-ee`，项目为私有。GitLab 18.2 系列的分支 API 没有开放 Job Token，18.4 的列表路由才明确允许 `job_token_allowed`；不能将新版文档的权限直接套用旧实例。参见官方 [18.2 分支实现](https://gitlab.com/gitlab-org/gitlab/-/blob/v18.2.0-ee/lib/api/branches.rb) 与 [18.4 分支实现](https://gitlab.com/gitlab-org/gitlab/-/blob/v18.4.0-ee/lib/api/branches.rb)。`/job` 继续支持 Job Token，并保留完整的实时身份绑定。

接收器可读取固定文件 `/etc/q/gitlab-branch-read.token`。文件不存在时保持原有 Job Token 分支查询路径；文件存在但权限、内容、读取或远端认证失败时立即拒绝，不自动回退。文件必须是 root 拥有、权限恰好 `0600` 的普通文件，所有父目录必须由 root 拥有且不能由其他用户写入；拒绝符号链接、特殊文件、空内容、超长内容和换行注入。只允许一个末尾换行，打开后再次校验文件身份和权限。

这份凭据只用于 `GET https://gitlab.kai.com/api/v4/projects/197/repository/branches?search=%5Emain%24` 的 `PRIVATE-TOKEN` 请求头；接收器不会把它发送给 `/job`、其他项目或其他 URL，不跟随重定向，也不传给子进程、Runner、业务容器或回执。调用方协议不增加凭据、文件路径或地址字段。每次先验证 live Job Token，之后才读取该文件；当前 main 必须仍受保护且当前提交与请求一致，这些校验没有例外。

2026-10-26，经用户明确批准，已创建仅限 Q 项目的 Reporter / `read_api` 令牌，有效期至 **2026-11-25**；受限文件已安装为 root:root `0600`，固定分支查询实际返回 HTTP 200，确认 `main` 仍受保护且版本为当时的 `08aaee4`。临时交接副本已清除。**新版接收器尚未安装，真实 CI 发布仍待验收**，这次只读查询不等于 CI 已打通。后续安装或轮换步骤：

1. 在项目 197 创建专用 **Project Access Token**，角色仅 **Reporter**、scope 仅 **read_api**，设置满足维护窗口的短有效期，例如 7 天，并安排到期前轮换；不要使用个人 PAT、管理员令牌、`api` 或写权限。`read_api` 在 GitLab 层覆盖该项目可访问的只读 API，不是只针对分支的 scope；仅请求固定分支地址是本接收器施加的限制，授权时必须说明这一区别。
2. 源码通过开发分支检查和 MR 人工审核后，由运维更新已审核的接收器与客户端。将令牌通过受控输入写入服务器 `/etc/q` 内的临时普通文件，设为 root:root `0600`，在持有 `/run/lock/q-ci-deploy.lock` 时原子替换固定文件。内容不要进入命令行参数、Shell 历史、环境配置、CI 变量、日志、截图、源码或构建制品；不得覆盖 `/etc/q/deploy.env`。
3. 在仍运行的、已授权的 main 作业中执行 `--check`，核对安全诊断、固定项目和当前 main；成功不等于业务部署已完成。已结束作业的 Job Token 已失效，不能拿它验证新凭据。实际部署继续人工触发，并记录最新提交的结果。
4. 轮换时创建新的同等最小权限、短有效期项目令牌，以相同方式原子替换并核对所有权/权限；完成授权的 `--check` 后撤销旧令牌，安全清除受控临时副本。令牌过期或撤销会让发布检查失败；不要因此扩大权限、公开仓库或跳过当前 main/保护检查。

这里不安装新依赖、不升级 GitLab、不修改仓库可见性，也不使用 OIDC 签发时的保护声明替代当前分支状态查询。接收器更新和真实流水线验收须使用人工审核后的源码继续完成。

## 安装与更新服务器入口

运维从已检查的源码目录执行 `backend/deploy/install-ci-receiver.sh`，传入该目录和专用公钥文件；先读脚本并核对目标。安装不会启动应用发布。它安装 root 拥有的固定接收器与可信运行/网页辅助脚本，创建独立 qdeploy 身份及严格 sudo 白名单，SSH 公钥仅允许强制命令，禁止交互、转发与任意命令。主机公钥固定在 `ci_known_hosts`，需通过既有可信 SSH 记录核验后更新，不能自动接受新 key。

接收器不执行上传的 shell、Python、Dockerfile 或 compose；API 使用服务器已存在且 root 拥有的部署配置，网页辅助程序也来自固定可信目录。部署入口和 helper 更新是单独的运维动作，仓库合入不会自动替换这些 root 程序。

当前发布目录的 `backup-policy.sh` 必须与安装版本一致，保留社交临时正文、举报原因与证据的备份排除规则。服务器 `/etc/q/deploy.env` 保持 root 0600，个人供应商密钥与现有配置保留。业务数据库不重建；发布前必须生成并校验新的本地数据库/密钥备份，仍不代表异地备份。

## 失败与恢复

客户端与作业不自动重试。接收器在副作用之前记录持久 pending receipt；结果未知、失败或重复制品不一致都会停止后续发布，避免重复执行业务。记录位于 `/var/lib/q/ci-deploy/`，仅 root 可读。

非零退出时，客户端只从完整、有界、字段精确的错误 JSON 中输出白名单诊断码，例如 `gitlab_job_http_401`、`gitlab_branches_http_403` 或 `branch_read_token_permissions`；不打印原始 stderr、HTTP 正文、请求头或任意异常内容。错误仍标为 `Deployment outcome is unknown`，不生成成功回执，不自动重试，也不因为某个诊断码看似属于检查阶段就推断写操作一定没有执行。`--check` 成功只表示 readiness，服务器本来不会为它生成部署 receipt。

没有新增迁移、SQLx 历史未变且当前配置与链接仍归本次发布所有时，API 启动失败可以恢复原应用版本。存在待执行迁移、迁移历史无法确认或运维同时修改配置时不自动回退，不恢复数据库备份。运维先核对容器、健康、配置、`_sqlx_migrations` 和 receipt，再决定修复前进或经独立确认的恢复；保留失败记录至受限审计目录后才能解除部署阻塞，不能直接反复点击 Retry。

手工运维修改 `/etc/q/deploy.env`、`/opt/q/current` 或发布目录时也须持有 `/run/lock/q-ci-deploy.lock`。接收器额外检测配置/链接是否变化，发现并发修改就停止。

## 验证与未覆盖事项

本地执行 `python3 -m unittest discover -s backend/deploy -p 'test_*.py'`、网页发布工具测试与 shell 语法检查。它们不代替真实 GitLab token、Runner、服务器和手动发布验收。

启用后的首次真实验收必须记录：配置合入的 main SHA、流水线/作业 ID、两个环境的实际成功记录、健康及版本回执。未完成这些步骤前只能报告代码/安装/配置已完成，不能报告端到端部署通过。iOS/Android 真机、真实支付和供应商实账均不在此部署流程验收范围。


2026-10-19 接线验收：本地 48 项部署测试与 20 项网页发布测试通过；服务器入口已安装，API/admin readiness 通过；专用 SSH 强制命令拒绝任意命令与无效作业 token，非白名单 sudo 被拒绝，当前业务发布版本未改变。GitLab 已建立 `staging/api` 和 `staging/admin`，均限制 Maintainer 部署；流水线变量最低角色为 Maintainer，MR 对受保护变量/Runner 的访问已关闭。经用户确认，专用 CI 变量已保存为 Protected、Masked、Hidden，范围 `staging/*`。实例不支持 `artifacts:access:maintainer`，已改用支持的 `developer`（回执不含秘密）。首次 main 真实部署作业验收仍待人工合并后完成，不能据此声明端到端 CD 已通过。
