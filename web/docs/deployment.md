# 小Q后台静态演示发布

这是一次显式执行的静态原型发布，不是生产业务后台部署。访问入口为 `https://8.163.108.216/q-admin/`。页面持续标明演示，所有操作仅改变浏览器内存；没有真实登录、用户数据、供应商请求、付款、Rust API 或 PostgreSQL。

## 发布边界与前提

- 使用现有 `ecs-user@8.163.108.216` SSH 连接及 `sudo -n`；私钥路径仅通过 `--identity` 参数传入，不写入仓库、制品或服务器配置。脚本要求主机密钥已在本机可信记录中，不关闭 SSH 主机检查或 HTTPS 证书检查。
- 复用 Ubuntu 上已有的 Nginx。脚本只为 IP 对应的 HTTP/HTTPS server 增加 Q 专用 include，不更换默认站点、不启动应用进程、不打开新端口。
- 修改文件仅为 `/etc/nginx/conf.d/kai-c02-ip-https.conf`、`/etc/nginx/conf.d/kai-cloud-web-ip-preview.conf` 及 `/etc/nginx/snippets/q-admin-demo/{http,https}.conf`。第二个配置含多个 server，工具按 `server_name 8.163.108.216` 和监听端口精确匹配；无法唯一识别或发现已有冲突时停止。
- 本地需要 Git、Python 3、Bash、OpenSSH；服务器需要已有的 Python 3、Nginx、curl、flock、systemd。脚本不自动安装软件。
- 本任务只部署可公开浏览的虚构演示资料。公网路径和 `noindex` 不提供身份隔离；Mandow、hera 是同等演示视角，不能当作已实现管理员鉴权。

## 制品格式与版本

Vite 的 `base` 为 `/q-admin/`，`assetsInlineLimit` 为 `0`。直接使用普通 `web/dist/`：

```text
dist/
  index.html
  version.json
  assets/...
```

`version.json` 必须至少包含：

```json
{
  "sha": "完整的40位小写Git提交SHA",
  "mode": "demo",
  "sourceDirty": false,
  "builtAt": "2026-10-19T12:00:00Z",
  "pipelineId": "对应的GitLab流水线ID"
}
```

`sha` 与 `sourceDirty` 必须在构建时从 Git 得出，不能为通过发布校验而事后修改。提交前构建通常为 `sourceDirty: true`，只用于开发验证；发布前从已提交、干净的对应版本重新构建，或使用该提交的 CI 制品。本地构建的 `pipelineId` 可为 `null`、空字符串或 `local`；发布命令仍须指定实际通过检查的流水线 ID。CI 制品内的 ID 必须与发布参数一致。

打包器将 `dist` 转换为 `public/q-admin/...`，另生成逐文件 SHA-256 清单。服务器目录为：

```text
/var/www/q-admin-demo/
  releases/<40hexsha>/
    public/q-admin/index.html
    public/q-admin/version.json
    public/q-admin/assets/...
    release.json
  current -> /var/www/q-admin-demo/releases/<40hexsha>
  backups/<UTC时间>-<sha>-<进程号>/
    state.json
    原配置和拟应用配置的受限备份
```

Nginx 使用 `root /var/www/q-admin-demo/current/public`，URI 与文件路径直接对应，不使用 `alias` 加 `try_files`。正常子路由回退到 Q 的 `index.html`；缺失的静态文件返回 404。HTTP 下的 `/q-admin` 和 `/q-admin/…` 跳至对应 HTTPS 地址；HTTPS 的 `/q-admin` 规范化为带斜杠入口。

页面使用重新验证缓存，版本信息不缓存，带 hash 的 `assets` 成功响应使用长期缓存。首版不使用路由懒加载或 service worker；发布前验证旧标签页继续浏览和刷新，避免旧入口请求已切换版本的懒加载文件。所有图片、字体和媒体必须是本站文件，不能依赖外部 CDN 或 `data:` URL。

专用路径提供完整安全头并隔离原业务 CSP：`connect-src 'none'`、脚本/图片/字体/媒体仅本站、禁止表单提交与嵌入、`nosniff`、`noindex`。CSS 允许组件所需内联样式。工具不修改其他站点的 CSP、证书或应用资源。

## 验证、推送与手工发布

1. 完成本地适用检查、七条演示流程和独立代码审查；修复问题后重跑受影响检查。提交内容只包含本任务文件，不带入其他任务尚未提交的 AGENTS 或业务部署改动。
2. 按仓库规则推送 `Mandow`，确认精确提交的 GitLab 全部必要任务实际通过，建立或更新目标 `main` 的 MR。MR 合并由人工执行。此次演示允许部署通过检查的开发分支提交，不自动合并或每次 push 自动发布。
3. 在同一干净提交重新构建发布制品，记录通过的流水线 ID。脚本检查本地 HEAD、工作区状态、构建版本、归档哈希、文件清单及路径边界；它不自行调用 GitLab，因此远端流水线是否通过仍由执行者核对。
4. 先运行本地制品检查，再显式发布。以下命令从仓库根目录执行；将参数替换为实际值：

```sh
bash -n web/deploy/deploy.sh web/deploy/remote.sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s web/deploy -p 'test_*.py' -v

bash web/deploy/deploy.sh \
  --sha <40位提交SHA> --pipeline-id <通过的流水线ID> \
  --dist web/dist --validate-only

bash web/deploy/deploy.sh \
  --sha <同一40位提交SHA> --pipeline-id <同一流水线ID> \
  --dist web/dist --identity <本机SSH私钥绝对路径>
```

`--validate-only` 不建立 SSH 连接、不写服务器。测试只创建本地临时 Git 仓库、归档和配置夹具；不接触业务服务。

发布命令上传归档与工具到随机、仅当前 SSH 用户可读的临时目录，服务器再次校验。新版本内容完整落盘、原配置备份后才修改 include 和原子切换 `current`。新配置必须通过 `nginx -t` 才 reload；不 restart Nginx。工具随后通过回环地址访问同一个 HTTPS IP 虚拟主机，正常验证证书。版本探测在最多20秒的统一预算内等待新worker就绪，只对短暂连接异常、404或有效旧SHA重试静态GET；TLS错误立即失败。目标SHA匹配后严格检查入口、SPA回退、缺失资源和HTTP跳转。

工具输出提交、流水线、归档校验值和回退用 transaction ID。`backups/<transaction>/state.json` 保存版本、制品校验、之前的 `current` 和配置校验值，回环检查通过后记录时间。它不是公网验收结论。归档与上传工具在命令退出时清理，已发布版本和回退备份保留；不自动清理旧版本。

## 公网验收与回退

发布前记录 HTTPS 根页面及代表性现有 KAI 入口的响应；发布后对照确认未受影响，并验证：

- 公网 `/q-admin/` 与实际深层页面均能直接访问、刷新；静态文件正确返回且不存在的资源为 404。
- 页脚版本等于本次提交；浏览七条流程的成功、失败、待确认、取消和重置分支。页面、抽屉、弹窗始终明确演示状态。
- 浏览器没有业务 `/v1`、供应商、远程埋点或 WebSocket 请求。浏览器控制台没有 CSP 违规或资源加载失败。
- 窄屏、键盘导航和主要桌面视口可用；HTTP 同路径到 HTTPS 的地址和查询参数保留正确。
- 核对缓存与安全头仅应用于 Q 路径；服务器原有应用和访问入口保持原状。

公网验收失败时，用发布输出的 transaction ID 回退：

```sh
bash web/deploy/deploy.sh \
  --rollback <发布输出的transaction-id> \
  --identity <本机SSH私钥绝对路径>
```

每次发布失败退出的 trap 都尝试恢复对应备份并检查、reload Nginx。**首次发布**回退恢复原两份配置，移除本次新增 snippets 和 `current`，恢复发布前的路由行为；**后续发布**回退同时恢复前一个 `current` 和前一套配置。已提取版本文件保留用于排查，不删除其他目录、数据或业务。

只允许回退最近仍匹配的发布事务。若其他操作者改过相关配置或另一个版本已激活，工具停止并报告，不覆盖对方改动。断电、`SIGKILL`、磁盘故障无法保证 trap 执行；应依据受限备份和输出的 transaction ID 恢复，不能盲目覆盖整个 Nginx 目录。不可通过修改备份校验值绕过并发保护。

同一 SHA 的发布目录不可覆盖。完全相同的制品可以重试；同一 SHA 的不同文件或不同构建时间戳会被拒绝，避免一个版本号指向不同内容。回退后重新运行公网版本、路由及原业务检查。
