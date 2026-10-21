# 小Q管理工作台（静态演示原型）

React + TypeScript + Vite 独立网页，浏览器路由与资源前缀均为 `/q-admin/`。默认白底青蓝，支持深色、暖色、中英文和窄屏。39个页面、81条明确虚构的样例记录，覆盖8个产品领域。Mandow/hera是同等演示视角，不是实际管理员授权。

## 运行与验证

Node 24，从仓库根执行：

```sh
npm --prefix web ci
npm --prefix web run dev
# http://127.0.0.1:5173/q-admin/
npm --prefix web run typecheck
npm --prefix web run lint
npm --prefix web test
npm --prefix web run build
cd web && npx playwright install chromium && npm run test:e2e
```

Playwright验证生产构建，默认自动启动4173端口的预览服务。设置 `Q_ADMIN_TEST_URL=https://8.163.108.216/q-admin/` 可针对公开演示版本运行相同交互测试；测试只操作虚构数据，不调用业务服务。发布脚本另有20项Python标准库测试：`PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s web/deploy -p 'test_*.py'`。

本地可用 `Q_ADMIN_BROWSER_PATH` 指向已有的 Chromium 可执行文件；需在验收记录中写明实际版本。CI忽略该覆盖，始终使用锁定Playwright对应的浏览器。

## 能力与边界

- 用户与会话、AI问题、视频原任务查询、目录展示、内容举报申诉、分阶段退款、配置版本均有可点击流程；每次变更记录操作者和理由。
- 数据和操作记录只存当前页面内存，刷新/重置恢复初态；不使用业务API、数据库、分析埋点、WebSocket或浏览器持久化，不提供真实登录、凭据输入、支付或资金修改。
- 公共目录撤下不影响个人连接；未知视频/退款沿原引用查询；配置回退不撤销已发生的业务；模拟QDC只读且不能兑换。
- 能力基础标签仅说明对应产品底层，页面中的服务状态、用量与金额始终是虚构演示。
- `domain.ts`管理状态转换，`catalog.ts`管理双语样例，`selectors.ts`统一首页与待办口径；UI复用详情、状态、列表、时间线和确认表单。

## 发布

详细流程见[部署与回退](docs/deployment.md)。仅发布验证通过的同一提交制品，由Nginx提供静态文件，不运行Vite开发服务器。`version.json`记录SHA、构建时间、流水线与构建时工作区是否干净；脏构建只能本地预览，不能发布。

新增依赖用途：React Router用于深层链接与返回；Lucide提供一致图标；Vite提供静态构建；Playwright测试真实浏览器交互；tsx运行类型化纯逻辑测试。没有新增业务后端、UI组件库或状态库。字体为系统字体，原有小Q形象随制品提供。

设计依据见[设计记录](docs/design.md)。开发前阅读[根规范](../AGENTS.md)、[Web补充规范](AGENTS.md)及[插件规范](../backend/docs/plugin-integration.md)。

`public/privacy.html` 为公测隐私与社区说明源文件，计划由 Q API 域名的 `/privacy` 独立提供；它尚未部署，不能把管理网页构建成功视为该地址已可访问。安装位置、CSP 与发布顺序见[公测记录](../backend/deploy/PUBLIC-BETA.md)。
