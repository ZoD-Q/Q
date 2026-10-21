# 小Q部署状态与域名验收

后端发布验收日期：2026-10-19（北京时间）；公测准备记录更新于 2026-10-20。当前为已接入公网 HTTPS 的联调环境，不是完整生产或真实金融业务验收。

## 当前部署

**业务源码仍为 `4af1ed7fb9d3a815948cac3a1b2037fb41a51a9a`。** 17:15 完成社交后端部署，`/opt/q/current` 指向 `/opt/q/releases/4af1ed7-20261019-social`。API、PostgreSQL 18.6 和回环 Nginx 均 healthy。社交、现有数据保留、备份恢复及回退演练见 [社交部署记录](SOCIAL-2026-10-19.md)。域名接入只修改入口和受保护运行配置，没有替换该发布源码或数据库。

| 项目 | 当前验收结果 |
| --- | --- |
| 公开 API | `https://q.kaicloudpay.com`，服务器 DNS 解析为 `8.166.119.204` |
| 回源 | 公网 HTTPS 在阿里云负载均衡终止，通过其私网地址进入 `8.163.108.216` 的专属 Nginx，再转发 `http://127.0.0.1:18787` |
| 入口配置 | `/etc/nginx/conf.d/q-api-domain.conf`，仓库对应 [nginx-q-domain.conf](nginx-q-domain.conf) |
| 业务端口 | API、数据库无宿主映射端口；18787 仍只监听服务器回环 |
| AI | 已配置服务端 DeepSeek；公网真实 Flash SSE 收到 `status / delta / done` |
| MCP | `available: true / oauth_configured: true`，公开 origin 与 CIMD 元数据已配置；第三方授权与实际业务仍需单独验收 |
| iOS | `0.1.0 (1)` 于 2026-10-20 12:17 上传成功，12:29 确认 `VALID / READY_FOR_BETA_TESTING`；外部 Beta 审核、测试者分配和真机安装未进行 |

2026-10-20 公测准备：构建 `0.1.0 (2)` 已签名归档，但 Mac 锁定导致上传未完成；100 人外部组及审核资料已准备，公开链接仍关闭。账号生命周期、可信代理限流、维护工具及隐私网页仍是待审核部署的源码。本地自动化和原生验收范围、最新 CI 与人工合并门禁见[公测发布记录](PUBLIC-BETA.md)。

## 公网入口验收

18:54 左右完成配置；非敏感记录保存于 `backend/.local/domain-q/verification.json`，记录时间为 19:01:18。

- Nginx 配置检查通过；Q 专属域名入口保留其他虚拟主机。服务器解析公网域名后，本机以该 IP 保留 Host/SNI 验证 HTTPS CA、健康接口、现有验收账号登录、资料、模拟钱包、视频/插件列表和注销。源站 HTTPS 的既有通配证书也通过校验。
- 实际观察的负载均衡回源地址为 `100.127.192.20`、`100.127.192.64`。80 端口只允许阿里云保留网段 `100.64.0.0/10` 与回环 TCP 来源进入业务上游，直接源站 HTTP 即使伪造 XFF/XFP 仍返回 308；公网前置入口的 HTTP GET、POST 均返回 302 至 HTTPS。
- 入口使用原始 TCP 来源判断访问，重新生成上游 XFF、固定 Host/HTTPS scheme 并清空 `Forwarded`。伪造 XFF 未改变实际客户端识别。该入口校验不等于 Rust 已实现按可信代理客户端地址限流；Rust 共享来源限额仍待改进。
- 公网真实 DeepSeek Flash 调用消耗 47 tokens，147 ms 收到首个状态、1,220 ms 收到首个文字增量，最终收到 `done`，确认响应没有等完整结果才返回。代理关闭缓冲、缓存与上游自动重试，读取超时为 300 秒。
- 持有 `/run/lock/q-ci-deploy.lock` 时更新 `Q_MCP_PUBLIC_BASE_URL=https://q.kaicloudpay.com`，只重建 API，保留其他运行配置和所有持久密钥。`oauth_configured: true`、CIMD `client_id=https://q.kaicloudpay.com/oauth/client-metadata.json`、`redirect_uri=https://q.kaicloudpay.com/v1/plugins/oauth/callback` 与精确 HTTPS CORS 来源通过检查。回环 MCP 目标仍被 `MCP_UNSAFE_URL` 拒绝。

尚未完成真实第三方 OAuth 授权、可灵实账视频生成、TestFlight 测试者分配及真机安装验收；iOS 归档与上传记录见 [移动端验收](../../mobile/docs/testing.md#原生归档与-apple-上传2026-10-20)。持续异地备份、外部告警、可信代理限流和完整公网生产验收仍需单独完成。最新仓库 CI 配置或新合入代码不自动成为服务器已运行版本。

## 历史快照：64ff5b5 内部升级

以下为 16:43 的内部验收记录，对应当前社交版本的前一版本；其中的服务配置、数据计数和 OAuth 状态只代表当时。现行社交备份排除规则及回退限制见 [社交部署记录](SOCIAL-2026-10-19.md)，不能用旧快照覆盖当前数据或恢复旧全量备份策略。

| 项目 | 本轮验收值 |
| --- | --- |
| 主机 | `ecs-user@8.163.108.216`，Ubuntu 26.04、Linux x86_64 |
| 业务源码 | 本轮构建时已人工合入 `main` 的 `64ff5b5e6f489bbe661c9d55721479c775e1a3bd` |
| 发布目录 | `/opt/q/releases/64ff5b5-20261019`，当时 `/opt/q/current` 指向此目录；旧 `2e4e370-20261019` 保留 |
| API 镜像 | `q-api:64ff5b5e6f489bbe661c9d55721479c775e1a3bd`；非 root、只读文件系统、512 MiB、1 CPU |
| 数据库 | 独立 PostgreSQL 18.6 容器；512 MiB、1 CPU；业务角色 `q_app` 非超级用户 |
| 网关 | 独立 Nginx 1.29.8 容器；64 MiB、0.25 CPU；关闭代理重试与流式缓冲 |
| 内部上游 | `http://127.0.0.1:18787`，仅服务器回环监听 |
| 健康检查 | `GET /health` 返回 `{"status":"ok","mode":"demo"}` |
| 服务配置 | `/opt/q/current/deploy/compose.yaml`、`/etc/q/deploy.env`（root 0600） |
| 持久数据 | `/var/lib/q/postgres`；容器 PGDATA 为 `/var/lib/postgresql/18/docker` |
| AI 对话 | 已配置服务端 DeepSeek 密钥；真实 Flash 流式调用通过 |
| MCP | 宿主接口与协议 `2026-07-28` 可用；独立加密密钥已持久保存，公共域名未配置，OAuth 为 false |

PostgreSQL 使用已有官方镜像 `public.ecr.aws/docker/library/postgres@sha256:885953109528ad3dfc90362b1a6f50a78620b5315be19f187753d267e484dc5b`，Nginx 使用 `nginx@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de`。仅复用镜像，小Q数据、网络、配置和容器均独立。现有公网 Nginx 路由未修改。

Debian 运行基础镜像为 `public.ecr.aws/docker/library/debian:bookworm-slim`，实际 ID/摘要 `sha256:97049525bbb2470c8694cd9cab09d92d5784c937a9de8d2dbe1aa28baed2074d`；探针来自上述 Nginx 镜像。当时运行 API 镜像 ID 为 `sha256:5a811e7d50341f2dd1d751796eea771c59f25909c36527823ef320ca7c169e87`。

本次从固定提交 `git archive` 获取干净源码，采用本机交叉构建：rustc 1.99.1、cargo-zigbuild 0.23.4、Zig 0.17.0，Linux x86_64/glibc 2.36，锁文件与默认功能。发布包 SHA256 为 `5d6bfe077495bd76a10192d1d08765e3cff03762c9c4d8a61112b68fc9e6d80d`；服务器实际二进制 SHA256 为 `5840fa1275bb06d944ff0836272f5341bdefc00956c552fa559c086d6f4f7642`。来源及逐文件校验和保存在 `/opt/q/releases/64ff5b5-20261019/q-release/`；部署配置另以 `DEPLOY_CONFIG_MANIFEST.json` 记录，补充了 MCP 环境变量传入。不是 CI 发布产物或新流水线通过的声明；构建冻结后新合入的功能也不自动算作已部署。

### 当时已完成验收

- 默认和全功能 clippy、格式检查、46 项 Rust 单元测试通过；发布程序默认功能与带替身的验证程序分开构建和校验。
- 独立 PostgreSQL 18.6 验证：身份/账本 3 项、视频 5 项、AI 2 项、插件 7 项、AI 工具 1 项，共 18 项实际执行并通过，0 跳过。验证程序在隔离内部网络中运行，未访问业务数据库或供应商实账。
- 升级前备份在独立恢复库实际还原，再由新程序执行迁移 3；原有数据计数一致后才切换业务 API。正式切换前停写并再次备份，数据库容器 ID、数据库密码和视频密钥保持不变。
- 三个常驻容器均 healthy；原部署验收账号登录、资料、模拟钱包、注销、未授权 401、视频与插件列表接口通过。回环插件目标被 `400 MCP_UNSAFE_URL` 拒绝。首次部署的注册/CORS 验收记录保留，本轮未在业务库新增账户或转账。
- 恢复演练与正式网关分别完成一次真实 DeepSeek Flash 流式调用，均收到 `status / delta / done`，每次 47 tokens；供应商密钥不进入客户端。此检查不代表可灵或真实第三方 MCP OAuth 验收。
- Docker 已启用开机启动，三个容器使用 `unless-stopped`；本轮重启 API 后再次通过登录、插件状态及原业务数据计数检查。首次部署曾重启全部小Q容器；未进行宿主重启验收。
- 数据库没有宿主映射端口，API 没有宿主映射端口，网关仅绑定 `127.0.0.1:18787`；开发机经 SSH 隧道访问健康接口通过。
- 禁用公开演示账号初始化，库中没有 `kai` / `lin`；保留一个部署验收账户及模拟欢迎金，凭据只在服务器 root 可读文件中，未创建真实交易。
- 原业务计数保持：身份 1、资料 1、账户 2、模拟交易 1、分录 2、视频连接/任务均 0；业务库迁移 1、2、3 成功。服务器证据在 `64ff5b5-20261019` 发布目录的 `UPGRADE.json`、`PG18_VALIDATION.log`、`SMOKE.json` 与 `SMOKE_AFTER_RESTART.json`。

### 当时的备份与监控

- `q-backup.timer`：每日 UTC 02:30（北京时间 10:30，最多随机延迟 10 分钟），本机保留约 14 天。
- 备份位于 `/var/backups/q`，目录 0700；数据库转储和单独的配置/加密密钥副本均为 0600。
- 首次已生成一份服务器外的 age 加密快照，在开发机 `/Users/kai/Desktop/Q/backend/.local/server-backups/q-20261019-initial.tar.age`，已验证解密。它使用当前部署 SSH 公钥加密，需要对应私钥恢复；私钥不随文档或备份传输。
- 本轮停写后的备份为 `q-db-20261019T084013Z.dump`，升级后为 `q-db-20261019T084051Z.dump`，各有对应校验和及受限配置副本。二者另存于开发机加密包 `backend/.local/server-backups/q-upgrade-64ff5b5-20261019.tar.age`，已验证解密和完整文件清单；SHA256 为 `889b012a7cc8e057b7ad7b1236597f3473634c50d2fb706437d15ce65fa27705`。
- `q-health.timer`：每五分钟检查容器、健康接口和磁盘占用（85% 阈值），结果记录在 systemd/journal。
- 定时异地复制与外部告警接收渠道尚待运维配置。一次本机外快照不能代替持续异地备份。

### 当时的运维事项

1. 分配 API 域名并配置可信 HTTPS；在现有公网入口将该域名转发到 `http://127.0.0.1:18787`。数据库和 18787 不直接公开。
2. 外层代理关闭响应缓冲和自动重试，流式读取超时至少 300 秒；客户端以 HTTPS 域名配置 `EXPO_PUBLIC_API_URL`，网页来源加入精确 `Q_CORS_ORIGINS` 后重建 API 容器。
3. 公网多人使用前完善可信代理与登录限流。当前 API 按 TCP 来源限流，代理后共享来源限额；仅增加转发头不能解决。
4. 首次 `2e4e370` 部署时 `/v1/ai/status` 为 `configured: false`；本次 `64ff5b5` 升级已配置 DeepSeek 并实际调用通过。后来社交升级保留配置但未调用供应商；本次域名验收的真实调用记录见本文上方。个人可灵及第三方插件仍需独立实账/授权验收。
5. 指定异地备份目的地、保留策略和外部告警渠道，完成域名、TLS、真实供应商及客户端的单独验收。

维护、恢复与升级命令见 [README](README.md)。旧 `2e4e370` 镜像和发布目录保留，但其 SQLx 不认识迁移 3，不能直接切回旧二进制连接当前库。回退需将升级前备份恢复到新库，验证并配置连接后再启动旧 API，保留当前库并评估恢复点之后的数据；不得删除迁移记录或降级 PostgreSQL 镜像。

## 2026-10-21 对话连接故障复核

本次未部署或修改线上配置。只读核对仍为 `4af1ed7-20261019-social`，API/数据库/网关 healthy，健康与备份计时器 active。公网与回环 `/health`、`/v1/ai/status` 均正常，AI `configured: true`。使用已有验收账号经公网完成登录、身份、视频/插件连接列表读取与注销；公网 Flash 短对话收到 `status / delta / done`，47 tokens、约 860 ms，回环复核另一次 47 tokens、约 1302 ms。凭据和回答正文不写入记录。浏览器 `http://localhost:8081` 的 CORS 响应正确。

用户截图来自 Q Public Beta QA 模拟器的旧本机验收包：实际请求 `http://127.0.0.1:57637/v1/ai/status`，对应临时服务已停止。问题不代表线上 DeepSeek 密钥失效。已在本机重装使用公网地址的修复版模拟器应用；不会自动更新 TestFlight/真机安装，后续正式发行仍按人工审核流程执行。网络、供应商余额与服务故障仍须分别处理，配置状态和本次短对话通过不是永久可用性承诺。
