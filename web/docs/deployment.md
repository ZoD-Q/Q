# 小Q正式后台静态制品发布

本文件描述发布条件；已执行结果见[2026-11-08发布记录](../../backend/deploy/RESEARCH-2026-11-08.md)。正式入口为`https://q.kaicloudpay.com/q-admin/`，页面复用同域Q身份和操作员API。裸IP或非官方来源只显示官方安全入口。业务后端继续独立运行，前端不连接数据库。

## 版本与兼容

Vite路径前缀为`/q-admin/`。新`version.json`写入实际源码SHA、`mode: admin`、`sourceDirty`、构建时间与流水线ID；GitHub/GitLab构建断言同步要求admin。脏工作区制品只用于本地验证，不能发布。`release.json`和`version.json`的模式、SHA、流水线必须一致。

发布工具接受已验证的旧`demo`制品用于受控历史回退，但不会把demo与admin清单混用。旧发布目录和备份不覆盖；回退仍检查实际current目标、配置摘要、事务身份和制品文件。不能用允许旧模式绕过人工审核与最新提交检查。

## 受信helper版本门禁

部署前核对固定受信`web/deploy/deploy_tools.py`的实际摘要及能力；只有版本不支持admin或根登录同源CSP时，才由有权限的运维先更新审核过的helper。旧helper只允许demo，也只在wallet路径允许连接。仓库合并不会自动更新它，安装与制品发布须分别记录。2026-11-08现场helper与已审核main完全一致，无需重复安装；管理网页作业62233成功。旧helper/配置备份和旧静态事务保留。

## Nginx文档与静态资源边界

- 根入口、真实深链、历史未接入地址与实际HTML均使用`connect-src 'self'`及`Cache-Control: no-store`；脚本、样式、图片与字体只来自本站，无任意外部连接。API继续强制身份与角色；同源CSP不替代授权。
- `assets`中带内容哈希的成功资源长期缓存；版本信息不缓存。静态后缀请求不存在时返回404，不回退成HTML；包含旧`mascot/*.png`和钱包子路径下缺失JS。独立`/privacy`源仍保留在仓库，后台关闭public目录复制，`/q-admin/privacy.html`不打包；canonical隐私入口的独立安装与脚本CSP不受本轮影响。
- 正式HTTPS由负载均衡终止，受信HTTP回源复用相同snippet。`location = /q-admin`设置`absolute_redirect off`，只生成`/q-admin/?…`相对Location，避免从HTTPS降级到HTTP。独立旧IP的HTTP入口仍明确升级HTTPS并保留路径/查询。
- Web构建不启动Vite线上服务，不改其他虚拟主机、端口、证书、业务目录或数据库。线上目录仍沿用`/var/www/q-admin-demo`作为运维兼容路径名，不代表新制品包含演示数据。

## 验证与发布流程

先完成Web typecheck/lint/test/build/test:e2e、Shell语法和Python发布检查。设置`Q_NGINX_BIN`后运行真实隔离Nginx路由验收，核对官方域名/旧IP、根/深链/刷新、no-store、同源CSP、重定向及静态404；未运行项目不能记为通过。本地HTTP路由测试不代表公网TLS握手验证。

按[GitLab部署流程](../../backend/deploy/gitlab-cd.md)和根分支规则：开发分支提交/推送→对应最新提交自动检查→人工审核合入main→受保护main人工发布。新CI配置须看两端实际结果。默认发布使用同一GitLab流水线Web制品与受限接收器，并核对成功receipt及公网实际版本；某次部署成功不替代后续提交的检查。

个人SSH脚本只保留为另行明确的运维备用接口，不能作为直接发布开发分支或跳过CI的授权。任何失败/未知先核对目标、receipt和静态事务，再按既定流程恢复；不盲目重试、不删除失败记录、不覆盖不同制品。操作前保持共享发布锁，参见主部署说明。

仅本地制品检查可使用`bash web/deploy/deploy.sh --sha <完整SHA> --pipeline-id <已通过流水线ID> --dist web/dist --validate-only`；它不连接服务器，也不证明已经部署。
