# 小Q管理工作台

React、TypeScript、Vite 管理前端，正式入口 `/q-admin/`。所有业务记录来自 Q 服务端；使用 Q 登录后，服务端必须确认 maker/checker 操作权限。普通 Q 账号不获得操作员数据。界面统一黑底、青色正文与操作、红色错误与危险提示，支持中英文、桌面和375px窄屏。

## 已接功能

| 路径 | 数据与行为 |
| --- | --- |
| `/q-admin/`、`/q-admin/wallet-payments` | 正式登录；登录后进入支付队列 |
| `/q-admin/wallet-payments/orders` | 五个支付队列、按订单编号查询、双人审批、退款与凭证历史、原请求恢复 |
| `/q-admin/wallet-payments/settlements` | 结算/储备材料、分页、独立核材、原材料重核和计算历史 |
| `/q-admin/wallet-payments/fx` | 服务端参考汇率、时效/暂停、候选与人工激活、原激活恢复 |
| `/q-admin/wallet-payments/audit` | 支付域审计分页及付款订单筛选，保留服务器事件时间 |

未实现管理接口的历史地址只显示未接入页，不进入正式导航；没有平台总量、全局搜索、演示账号/金额、伪操作员或场景切换。列表只说明当前查询范围、页码和浏览器接收时间，不用当前页条数冒充全量。加载、读取失败、无权限、成功空结果和旧结果分别展示。已删除演示业务组件、目录及彩色形象资产；不提供直接数据库访问。

## 本地开发与验证

使用Node 24，从仓库根执行：

```sh
npm --prefix web ci
npm --prefix web run dev
npm --prefix web run typecheck
npm --prefix web run lint
npm --prefix web test
npm --prefix web run build
npm --prefix web run test:e2e
bash -n web/deploy/deploy.sh web/deploy/remote.sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s web/deploy -p 'test_*.py'
```

普通本地/裸IP页面只显示官方安全入口，不能收集凭据。显式隔离联调需同时提供`VITE_Q_LOCAL_API_TEST=1`、回环`VITE_Q_API_URL`，且页面也必须位于回环地址；服务端CORS仍须预先允许该来源。生产构建脚本强制清除联调变量。不要把浏览器写操作测试指向生产；Playwright使用单独输出与拦截的回环接口。`Q_NGINX_BIN`可指定本地Nginx执行真实路由测试；缺少Nginx时跳过项不是验收通过。CI已提供Nginx。

令牌只存在内存，刷新需重新登录。退出、401、页面离开和BFCache恢复均清除敏感表单。待确认写入仅按API来源+账号保存最小恢复引用；原文件和备注不持久化。不明结果先查原记录，不生成新请求替代。参见[钱包工作区](docs/wallet-payments.md)。

## 发布与证据

新制品`version.json`使用`mode: admin`；须先更新服务器受信Web helper，保留受控旧版回退。正式HTML（根、深链和历史地址）统一`connect-src 'self'`与`no-store`，不会开放第三方连接；缺失静态资源返回404。详情见[发布说明](docs/deployment.md)、[设计记录](docs/design.md)与[本轮验收](docs/formal-admin-2026-11-06.md)。

本轮以GitLab已审核main `e1ecb427`为基线，与GitHub main `e044537`代码树一致。源码完成、隔离验收与正式部署是不同状态；用户已授权提交PR/MR供人工审核；本轮尚未发布，远端检查以对应提交的PR/MR结果为准。`public/privacy.html`为独立`/privacy`部署源，正文和脚本保持原样；后台Vite关闭public目录复制，该文件不进入`/q-admin/`制品。未修改线上隐私页。
