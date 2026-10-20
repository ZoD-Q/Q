# 美女 MCP 常驻部署

这是与 Q API 独立的只读图库服务。它读取仓库已核验的 300 张照片，不在运行时抓取图片，不连接数据库或供应商，不使用 Q 会话或密钥。源码准备、离线验证、服务器安装与公网验收分别记录；这些文件本身不表示已部署。

| 项目 | 固定约定 |
| --- | --- |
| 介绍页 | `https://q.kaicloudpay.com/plugins/beauty/` |
| Server Card | `https://q.kaicloudpay.com/plugins/beauty/server-card.json` |
| MCP 端点 | `https://q.kaicloudpay.com/plugins/beauty/mcp` |
| 本插件 Catalog | `https://q.kaicloudpay.com/plugins/beauty/catalog.json` |
| 所有者声明 | Card 的 `_meta["com.kaicloudpay.q/owner"].name = "mandow"`；不是认证标识 |
| 进程 | `q-beauty.service`，系统账号和组 `q-beauty` |
| 内部监听 | `127.0.0.1:18796`，不暴露外网监听 |
| 发布目录 | `/opt/q-beauty/releases/<完整源码SHA>` |
| 当前版本 | `/opt/q-beauty/current`，原子切换的符号链接 |
| 配置备份 | `/var/backups/q-beauty/<UTC时间>-<SHA前12位>-<唯一后缀>/` |
| 独立日志 | `journalctl --namespace=q-beauty -u q-beauty.service`；空间策略 `SystemMaxUse=16M`，保留策略 `MaxRetentionSec=7day` |

Nginx 仅在 `/etc/nginx/conf.d/q-api-domain.conf` 的现有 HTTP／HTTPS 两个 Q 域名 server 中加入 `/plugins/beauty/` 转发，去掉该路径前缀后交给图库进程。保留 HTTP 来源判断和 HTTPS 重定向，保留现有 API 路由，不覆盖全站根 Catalog、管理页面或其他域名。未知布局、已有未托管同名路由、端口占用或不匹配的账号均停止安装。

安装与回退按 `/run/lock/q-ci-deploy.lock` → `/var/lock/q-admin-demo.lock` → `/run/lock/q-beauty-deploy.lock` 的顺序协调现有发布工具，并在实际替换或删除配置前再次核对期望内容。手工写配置的操作者也应配合同一锁；即时哈希复核可以检测已观察到的冲突，但不等同于对不持锁写者的原子比较交换。备份与渲染使用同一份已核对的原文，发生冲突时保留他人的修改。

日志使用 systemd 的独立 namespace 配置，不调整宿主全局 journald 设置。空间回收按日志轮换执行，活动日志可能暂时超出配置值；它不是文件系统硬配额。参见 [systemd journald 配置说明](https://www.freedesktop.org/software/systemd/man/latest/journald.conf.html)。

## 1. 审核与本地检查

先按仓库流程在 `Mandow`／`hera` 完成适用检查，通过 MR 人工合入 `main`；不自动合并。打包工具会获取 `origin/main` 并拒绝不在其历史中的源码版本，不提供跳过审核的参数。

```sh
python3 -m unittest discover -s backend/deploy/beauty-gallery -p 'test_*.py'
cargo test --manifest-path backend/Cargo.toml --example beauty_mcp
cargo fmt --manifest-path backend/Cargo.toml --check
git diff --check
```

Rust 格式、Clippy、全量单元测试仍按根规范执行。上述测试不访问服务器、业务数据库或第三方服务；事务测试只操作临时目录并替换系统命令，不能代替服务器验收。

## 2. 打包已审核版本

需要 Python 3、Rust stable、`cargo-zigbuild`、Zig，以及已安装的 `x86_64-unknown-linux-gnu` Rust target。从同一份 Git 归档编译 Linux amd64/glibc 2.36 二进制，编译期嵌入源码 SHA，同时打包 300 张原有照片及完整作者、来源、许可证元数据。不包含采集缓存、采集脚本、Q API、数据库或秘密。

```sh
python3 backend/deploy/beauty-gallery/package.py --ref <已审核的完整SHA>
```

工具不在 PATH 时使用 `--tool-bin <包含cargo-zigbuild与Zig的目录>`；将 Cargo 自身目录加入当前会话的 PATH。默认输出位于 `backend/.local/beauty-release/`。包内含 `SOURCE_COMMIT`、`RELEASE.json` 与完整 `SHA256SUMS`；打包工具验证 ELF 架构、图库数量、图片大小与清单校验和。包的 SHA256 必须从可信构建机器记录后传给安装工具，不能从服务器上的未知副本自行取得并当作可信证据。

## 3. 安装前预览与安装

仅在既有用户部署授权、`main` 审核和最终部署审查完成后操作。使用既有运维 SSH 身份将包和本目录已审核的 `install.py` 传到服务器的临时运维目录。不要读取、复制或修改 `/etc/q/deploy.env`，不替换 `/opt/q/current`，不运行迁移或业务测试。

先校验与预览；`plan` 只读服务器配置，展示精确的 Nginx 差异：

```sh
python3 install.py verify <发布包> --expected-commit <完整SHA> --archive-sha256 <可信构建机器记录的包SHA256>
sudo python3 install.py plan <发布包> --expected-commit <完整SHA> --archive-sha256 <包SHA256>
sudo python3 install.py install <发布包> --expected-commit <完整SHA> --archive-sha256 <包SHA256>
```

安装会：

1. 核对固定包 SHA、源码 SHA、精确文件清单、图片校验和及 Linux 架构；拒绝符号链接、重复文件和越界路径。
2. 确认现有 Nginx 配置与 Q API 健康。创建独立受限系统账号、不可由该账号修改的版本目录；保留历史版本与数据。
3. 备份原 Q Nginx 文件、本图库的 systemd／日志配置、旧版本链接、启用及运行状态。备份目录仅 root 可访问。
4. 切换本图库版本，验证 systemd 配置，启动服务并检查内嵌 SHA、300 张资源计数与固定 URL；验证 Nginx 后仅 reload，并验证本机域名路由及原 Q API 健康。
5. 启动每分钟的健康检查。进程异常退出由 systemd 恢复；进程仍 active 但健康检查失败时，检查器只尝试重启 `q-beauty.service`。主动停止的服务不会被健康检查启动。

服务禁用提权与外网连接，系统和发布目录只读，临时文件隔离于专属临时目录；限制为两个 Tokio 工作线程、256 MiB 内存、64 个任务、1024 文件句柄。原有单资源 768 KiB、并发图片读取 8、请求体 128 KiB 限制保留；Nginx 按可信来源 IP 限速每秒 10 个请求，允许 20 个突发请求。429 由客户端延迟重试，只读资源请求不会改写业务状态。照片、授权与许可原文始终随资源保留。

若版本检查、服务启动、配置检查、reload 或本机路由验证失败，安装自动尝试恢复备份中的配置、旧版本链接及图库运行状态；发现并发修改时停止覆盖并要求人工核对。安装记录会打印备份目录。新增账号、不可变发布目录与日志留存以便诊断，回退不删除照片或数据库。

## 4. 服务器与公网验收

安装完成后仍须记录以下实际证据：

- 本机 `/health` 内嵌 SHA 与审核版本相符，服务 enabled／active，健康 timer 正常。
- 公网介绍页、Card 与 Catalog 均返回对应媒体类型和完整固定路径；Card 符合 Server Card v1，所有者显示为发布者声明。
- MCP `2026-07-28` 的 `server/discover`、工具列表、`browse_photos`、300 个资源和至少首尾两张 `resources/read` 成功，许可元数据完整。
- 重启图库进程后固定 Card、资源与同一版本恢复；只在明确授权的维护窗口验证整机重启。未验证整机重启时如实说明。
- 既有 Q API／管理入口状态不变；iOS／Android／Web 的实际发现与照片浏览另行记录，不能由本工具替代。

现有 Q 备份定时器不会自动包含本图库目录。图库无动态业务数据；恢复材料为已审核源码、保留的发行包及专属配置备份。独立异地复制和外部可用性告警仍需运维安排，不能把同机备份称为异地备份。

## 5. 显式回退

```sh
sudo python3 install.py rollback /var/backups/q-beauty/<安装打印的备份目录>
```

回退先比对当前配置和版本是否仍对应该次安装；如其他操作者随后修改了配置，则停止并要求人工核对，避免覆盖新工作。成功时恢复原配置、原图库链接与启停／启用状态，执行 `nginx -t` 后 reload，并再次检查 Q API。全部历史发布和图片保留，不清理任何业务数据。

## 6. 当前验证记录（2026-10-20）

54 项本地 Python 测试与 3 项 Rust 图库示例测试通过，包括路径与文件清单校验、并发修改保护、失败回退、健康检查及真实健康模块加载后的同版本连续安装。300 张照片逐一经本地 MCP `resources/read` 返回，校验和与许可清单一致；Linux amd64/glibc 2.36 目标交叉编译成功。

上述编译使用当时尚未提交的本地工作区，仅验证目标平台能构建，不是通过 `package.py` 生成的正式审核发布包。静态核验为 amd64 ELF，最高所需 GLIBC 符号版本为 2.34，不超过目标 2.36；正式审核版本仍须重新打包并做真实运行验收。

服务器只完成只读环境核对，尚未安装本服务或改动 Nginx。iOS 对独立本地图库的添加、所有者展示、显式调用与图片翻页已通过，见 [工作台验证](../../../mobile/docs/plugin-workbench.md#验证)；公网固定入口、重启恢复和手机连接公网服务仍待实际验收。按仓库流程完成开发分支提交和最新 GitLab 检查，经人工合入 `main` 后继续发布。
