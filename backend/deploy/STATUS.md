# 小Q内部联调部署与运维交接

核对日期：2026-10-19。范围为内部联调，不是公网生产或真实金融业务验收。

**当前版本已升级为 `4af1ed7fb9d3a815948cac3a1b2037fb41a51a9a`。** 2026-10-19 17:15（北京时间）完成社交后端部署，当前目录为 `/opt/q/releases/4af1ed7-20261019-social`。社交、现有数据保留、备份恢复及回退演练的结果见 [社交部署记录](SOCIAL-2026-10-19.md)。DeepSeek 已配置，MCP 可用但 OAuth 尚未配置完成；本次没有调用真实供应商。

以下保留首次部署时的版本和验收历史；当前部署状态、备份和回退限制以上述记录为准。

## 首次部署的服务与版本

| 项目 | 当前值 |
| --- | --- |
| 主机 | `ecs-user@8.163.108.216`，Ubuntu 26.04、Linux x86_64 |
| 业务源码 | 已人工合入 `main` 的 `2e4e370deca060ee06401474897e9180dc18ca8e` |
| 发布目录 | `/opt/q/releases/2e4e370-20261019`，`/opt/q/current` 指向此目录 |
| API 镜像 | `q-api:2e4e370deca060ee06401474897e9180dc18ca8e`；非 root、只读文件系统、512 MiB、1 CPU |
| 数据库 | 独立 PostgreSQL 18.6 容器；512 MiB、1 CPU；业务角色 `q_app` 非超级用户 |
| 网关 | 独立 Nginx 1.29.8 容器；64 MiB、0.25 CPU；关闭代理重试与流式缓冲 |
| 内部上游 | `http://127.0.0.1:18787`，仅服务器回环监听 |
| 健康检查 | `GET /health` 返回 `{"status":"ok","mode":"demo"}` |
| 服务配置 | `/opt/q/current/deploy/compose.yaml`、`/etc/q/deploy.env`（root 0600） |
| 持久数据 | `/var/lib/q/postgres`；容器 PGDATA 为 `/var/lib/postgresql/18/docker` |

PostgreSQL 使用已有官方镜像 `public.ecr.aws/docker/library/postgres@sha256:885953109528ad3dfc90362b1a6f50a78620b5315be19f187753d267e484dc5b`，Nginx 使用 `nginx@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de`。仅复用镜像，小Q数据、网络、配置和容器均独立。现有公网 Nginx 路由未修改。

Debian 运行基础镜像为 `public.ecr.aws/docker/library/debian:bookworm-slim`，实际 ID/摘要 `sha256:97049525bbb2470c8694cd9cab09d92d5784c937a9de8d2dbe1aa28baed2074d`；探针来自上述 Nginx 镜像。最终 API 镜像 ID 为 `sha256:f492baabc002f7c962f8bc14fb18b3db1953a9fd813475c6fbd242700c2fb73d`。

本次共享 Runner 排队，采用本机交叉构建发布程序：rustc 1.99.1、cargo-zigbuild 0.23.4、Zig 0.17.0，Linux x86_64/glibc 2.36，锁文件与默认功能。原始发布包 SHA256 为 `1a385dfb0bc34f47df53614776d50edad2582ce223c29763da48798297905b78`，来源及逐文件校验和保存在 `/opt/q/current/q-release/`。不将此构建称为 CI 成功；CI 另配置 PostgreSQL 17/18 矩阵与可选手动发布打包。

## 已完成验收

- 隔离 PostgreSQL 18 验证：身份/账本 3 项、视频 5 项、AI 2 项，共 10 项通过；供应商均为回环替身，临时验证容器、网络及测试程序已清理。
- 三个常驻容器均 healthy，健康接口、注册、登录、资料、模拟钱包、注销、未授权 401 和允许来源 CORS 均通过。
- Docker 已启用开机启动，三个容器使用 `unless-stopped`；实际重启全部小Q容器后再次通过登录及账本持久化检查。未进行宿主重启验收。
- 数据库没有宿主映射端口，API 没有宿主映射端口，网关仅绑定 `127.0.0.1:18787`；开发机经 SSH 隧道访问健康接口通过。
- 禁用公开演示账号初始化，库中没有 `kai` / `lin`；保留一个部署验收账户及模拟欢迎金，凭据只在服务器 root 可读文件中，未创建真实交易。
- 备份已在独立恢复库实际还原，身份、账户、交易、分录、视频任务、迁移记录及启用触发器数量与原库一致；恢复验证库已清理。

## 备份与监控

- `q-backup.timer`：每日 UTC 02:30（北京时间 10:30，最多随机延迟 10 分钟），本机保留约 14 天。
- 备份位于 `/var/backups/q`，目录 0700；数据库转储和单独的配置/加密密钥副本均为 0600。
- 首次已生成一份服务器外的 age 加密快照，在开发机 `/Users/kai/Desktop/Q/backend/.local/server-backups/q-20261019-initial.tar.age`，已验证解密。它使用当前部署 SSH 公钥加密，需要对应私钥恢复；私钥不随文档或备份传输。
- `q-health.timer`：每五分钟检查容器、健康接口和磁盘占用（85% 阈值），结果记录在 systemd/journal。
- 定时异地复制与外部告警接收渠道尚待运维配置。一次本机外快照不能代替持续异地备份。

## 首次部署时的运维事项

1. 分配 API 域名并配置可信 HTTPS；在现有公网入口将该域名转发到 `http://127.0.0.1:18787`。数据库和 18787 不直接公开。
2. 外层代理关闭响应缓冲和自动重试，流式读取超时至少 300 秒；客户端以 HTTPS 域名配置 `EXPO_PUBLIC_API_URL`，网页来源加入精确 `Q_CORS_ORIGINS` 后重建 API 容器。
3. 公网多人使用前完善可信代理与登录限流。当前 API 按 TCP 来源限流，代理后共享来源限额；仅增加转发头不能解决。
4. 首次部署时 `/v1/ai/status` 返回 `configured: false`；后续 MCP 部署已配置 DeepSeek，社交升级前后均为 `configured: true`，不代表本次调用了供应商。个人可灵连接仍由用户在工作台提供，未进行供应商实账调用。
5. 指定异地备份目的地、保留策略和外部告警渠道，完成域名、TLS、真实供应商及客户端的单独验收。

维护、恢复与升级命令见 [README](README.md)。这是小Q首次部署，无上一发布版本可回退；需要暂时停用时仅停止小Q API/网关并保留数据库及备份。PostgreSQL 18 数据不能通过更换 17 镜像直接降级。
