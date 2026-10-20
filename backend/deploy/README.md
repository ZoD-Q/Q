# Q 内部联调部署

本目录包含 Rust API、独立 PostgreSQL、回环 Nginx 网关，以及 `q.kaicloudpay.com` 的专属域名入口配置。不是生产验收记录，不接入真实金融服务，不运行 Expo 或 CI Runner。发布代码必须来自经过人工审核的 `main` 明确提交；源码版本与部署配置版本分别记录。当前开发分支的新能力不会自动进入发布包。

## 目录与配置

- `/opt/q/releases/<version>/deploy/`：本目录文件；`artifact/xiaoq-backend` 放已校验的 Linux x86_64 发布二进制。
- `/opt/q/current`：指向当前发布目录的符号链接。
- `/etc/q/deploy.env`：`root:root`、0600；按 `deploy.env.example` 配置，禁止打印或提交真实配置。
- `/var/lib/q/postgres`：专用持久化数据目录，初始化前必须确认为新建空目录，禁止清空已有目录。
- `/var/backups/q`：0700；数据库备份与 `secrets/` 中的配置备份独立保存，文件 0600。它们仍在同一台主机，不是异地备份。

管理员密码与业务密码各使用独立的 32 随机字节十六进制值（64 字符），视频加密密钥使用 32 随机字节的 Base64。业务密码仅支持上述十六进制格式以安全构造数据库 URL。加密密钥必须持续保留，不能升级时重生成。`Q_RELEASE` 设置为发布源码提交 SHA。`POSTGRES_IMAGE`、`NGINX_IMAGE`、`RUNTIME_BASE`、`PROBE_BASE` 可指定经核验的官方镜像或其本地缓存标签，实际镜像 ID/摘要需写入部署验收记录；使用缓存标签前核验其镜像身份，不能仅凭标签名判断来源。

`init-db.sh` 只在全新数据库首次启动时执行：创建非超级用户 `q_app` 和其拥有的 `q` 库。API 以 `q_app` 连接，但启动仍会迁移，尚未分离迁移和运行角色。改变 env 不会自动轮换已存在的数据库密码。

服务器初次部署选用 PostgreSQL 18（当前缓存官方镜像 18.6），本地开发工具仍为 17.10；CI 分别验证 17/18。容器数据目录为 `/var/lib/postgresql/18/docker`，宿主绑定其父目录；部署前必须确认宿主目录为空。初始化后不能更换为 17 镜像直接回退，跨大版本需单独制定逻辑迁移方案；备份与恢复使用同版本容器内的 18 工具。

首次创建空目录时，先通过选定镜像的 `id -u postgres` / `id -g postgres` 核实容器数据库用户，再将 `/var/lib/q/postgres` 及本次创建的 `18/docker` 父子目录设为该 UID/GID、0700。不能只调整最深层目录，也不能盲目递归改已有数据库的属主；PG18 入口脚本切换到数据库用户后必须能穿过绑定目录。

若发布版本已包含 AI 模块，可在受保护的 `/etc/q/deploy.env` 中设置 `DEEPSEEK_API_KEY`，重新创建 API 容器后生效。留空时真实对话不可用；不把本地验证通过或 API 健康检查当作已配置供应商凭据。不要复用公开演示值或把密钥写入客户端。

MCP 发布配置使用独立的 `Q_MCP_ENCRYPTION_KEY`（32 随机字节的 Base64），不得复用视频密钥，升级时持续保留并随配置单独备份。`Q_MCP_PUBLIC_BASE_URL` 在最终域名与可信 TLS 验证后设置为 HTTPS origin，不含路径、查询或片段；留空时匿名 MCP 可运行，宿主 OAuth 明确不可用。不能把空字符串作为 MCP 加密密钥传给 API。

## 安装与验收

先检查现有系统服务、端口、磁盘与 Docker 状态；域名配置只修改 Q 的专属虚拟主机，不覆盖其他业务或未知目录。发布包由 `package-release.sh` 在构建环境生成，业务服务器不编译 Rust。解压后核对 `SOURCE_COMMIT`，在包目录执行 `sha256sum -c SHA256SUMS`，然后复制二进制到部署目录的 `artifact/`。

`package-release.sh` 使用 `cargo zigbuild` 显式构建 `x86_64-unknown-linux-gnu.2.36`，需要该 Rust target 和 cargo-zigbuild/Zig。CI 在独立 Python 环境安装 [固定版本及 wheel 哈希](release-tools.requirements.txt)，支持 Linux ARM64 与 x86_64 构建宿主；它们只服务于发布构建，不随业务镜像安装。脚本验证输出为 Linux x86_64 ELF 程序，再生成原有源码、迁移与文件摘要。不能通过去掉架构检查来打包宿主 ARM 程序。

确认目录、配置和当前链接准备完成后，以 root 执行：

```sh
docker compose --env-file /etc/q/deploy.env -f /opt/q/current/deploy/compose.yaml -p q config --quiet
docker compose --env-file /etc/q/deploy.env -f /opt/q/current/deploy/compose.yaml -p q build api
docker compose --env-file /etc/q/deploy.env -f /opt/q/current/deploy/compose.yaml -p q up -d --wait --wait-timeout 180
curl --fail --max-time 8 http://127.0.0.1:18787/health
/opt/q/current/deploy/backup.sh
/opt/q/current/deploy/health-check.sh
```

`config` 只使用 `--quiet`，避免输出展开后的凭据。数据库无宿主映射端口，仅连接隔离网络；API 可出站请求供应商，网关只监听宿主 `127.0.0.1:18787`。各容器设置资源上限、日志轮转、健康检查及 `unless-stopped` 恢复。Docker 开机启动状态需现场核对。API 使用 SIGINT、30 秒退出宽限。

运行镜像限定 Linux amd64：Rust 使用 Debian glibc，健康探针复用官方 Nginx Alpine 镜像内的 BusyBox 和对应 musl 加载器，并复制其 CA 证书包。封装阶段不在线安装系统软件、不编译业务源码；两个基础镜像均须记录实际摘要并按运维策略更新。健康探针只访问容器自己的 HTTP `/health`。

将 `systemd/q-*.service`、`systemd/q-*.timer` 安装至 `/etc/systemd/system/` 前核对无同名未知服务，再执行 `systemctl daemon-reload` 和 `systemctl enable --now q-backup.timer q-health.timer`。备份每天 UTC 02:30（北京时间 10:30，最多随机延迟 10 分钟），健康检查每五分钟一次。使用 `journalctl -u q-backup.service -u q-health.service` 检查结果。健康检查失败仅在 journal/systemd 记录，不包含外部告警通知；Docker 健康变差不会自动重启仍运行的进程，需运维处理。

备份脚本带互斥锁，完成 pg_dump 和归档目录验证后才原子发布文件；保留约 14 天的 Q 专属时间戳文件。首次部署及升级前应执行备份。异地备份目的地、传输加密与外部告警尚待运维配置验收。

## 恢复验证与回退

包含社交模块的版本必须一并更新 `backup.sh` 与 `backup-policy.sh`。备份保留 schema、普通聊天与最小幂等/到期墓碑，但排除 `social_ephemeral_payloads`、`social_reports`、`social_report_evidence` 的数据。恢复后缺少正文的封套不可用，旧举报编号不重新创建内容或延长保留期限。不要另行全量备份这些临时表来绕过该约定。`social_backup` 使用同一策略进行实际恢复验收；CI 的 PostgreSQL 17/18 任务均安装匹配主版本的客户端。

社交迁移只添加表，不改已有迁移。回退 API 不会回退数据或备份策略；恢复旧版全量备份前须核验临时内容排除与到期清理。`4af1ed7` 的实际社交部署、恢复与回退演练见 [社交部署记录](SOCIAL-2026-10-19.md)。

每次首部署至少在同一 PostgreSQL 实例内新建一个专用恢复验证库（名称必须确认不存在），不能覆盖业务库。通过 `docker compose … exec -T db` 调用 PostgreSQL 工具：管理员创建由 `q_app` 拥有的新库，将指定 `.dump` 送入 `pg_restore --exit-on-error --no-owner --role=q_app --dbname=<验证库>`。检查迁移记录、关键表和约束，再删除本次明确创建的验证库。记录备份时间、恢复结果与检查项。`pg_restore --list` 只能验证归档目录可读，不能代替实际恢复。

真实恢复需停 API 写入，确认恢复点和数据损失范围，在新库中完成恢复校验后切换，保留原库供核对。同时恢复匹配的加密密钥和数据库凭据；数据库转储本身不包含角色密码。不得直接对现有库使用 `--clean` 或删除持久化目录。

应用回退保留旧发布目录与本地镜像，更新 `/opt/q/current` 和 `Q_RELEASE` 到已验证的旧版本后重新 `up -d --wait`。数据库迁移不会自动回退；先核对旧 API 是否兼容现有 schema。若不兼容，必须另行制定数据恢复方案，不能通过更换镜像或删除数据库规避。

从 `2e4e370` 升级到含 `0003_plugins.sql` 的版本时，旧程序的 SQLx 迁移检查不认识第 3 版，不能直接切回旧镜像启动。升级前先在独立恢复库验证备份、新迁移和新程序；正式切换前停止 Q API 写入并再次备份。需要回退时，在新库恢复升级前备份，验证后切换数据库连接并保留原库；恢复点之后的写入须单独评估。不得删除 `_sqlx_migrations` 记录伪装兼容。

## 域名入口与维护

当前 API 为 `https://q.kaicloudpay.com`，服务器 `8.163.108.216`，运维用户 `ecs-user`。公网 HTTPS 在阿里云负载均衡终止，经其私网地址回源至 Q 专属 Nginx，再转发 `http://127.0.0.1:18787`。18787、API 容器和数据库均不直接公开。公网登录与真实 DeepSeek SSE 已验证，版本和未完成项见 [部署状态](STATUS.md)。

[nginx-q-domain.conf](nginx-q-domain.conf) 对应服务器 `/etc/nginx/conf.d/q-api-domain.conf`。80 端口只允许原始 TCP 来源为阿里云负载均衡网段 `100.64.0.0/10` 或回环地址时进入上游，其余请求跳转固定 HTTPS 域名。门禁使用 `$realip_remote_addr`，不能用可由客户端填写的转发头绕过；上游 `Host` 与 scheme 固定，`Forwarded` 清空，XFF 根据已校验来源重建。443 配置复用服务器受限证书路径，不将证书私钥放入仓库。上线前运行 Nginx 配置检查，确认其他虚拟主机保持可用，再重载。

公网代理与回环网关均关闭响应缓冲、缓存和自动重试，流式读取超时至少 300 秒。移动端构建显式设置 `EXPO_PUBLIC_API_URL=https://q.kaicloudpay.com`；`Q_CORS_ORIGINS` 只列实际需要的网页来源，不使用通配符。MCP 的公开 origin 使用同一域名，另行验证 CIMD 和回调；这不代表第三方服务授权已完成。

需要绕过公网入口维护时，从本地建立隧道：

```sh
ssh -L 18787:127.0.0.1:18787 ecs-user@8.163.108.216
```

隧道的本地 API 地址为 `http://127.0.0.1:18787`。更新域名、证书或代理后，分别验收公网 `/health`、登录、流式完成事件以及明文入口跳转；不能仅以内部健康检查代替这些结果。

当前线上 API 登录限流按 TCP 来源识别，代理后用户共享来源限额；转发头不能自动解决这一点。本轮源码已补充逐跳可信来源校验，但尚未部署和完成公网链路验收。新的固定网关地址、只读信任目录、维护工具、隐私页及迁移恢复要求见[公测发布记录](PUBLIC-BETA.md)。TLS、可信代理、CORS、异地备份、恢复演练和真实供应商调用分别验收；内部 `/health` 成功不能代表这些能力完成。
