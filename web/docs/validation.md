# 管理原型验证记录

2026-10-19。本轮为静态演示原型，未接真实管理API，未执行任何真实模型、支付、退款或数据修改。

## 本地通过

- `npm --prefix web run typecheck`、`npm --prefix web run lint`、`npm --prefix web run build`。
- `npm --prefix web test`：17项纯逻辑验证；覆盖七条业务流程、账号限制与恢复、待办选择口径、退款渠道确认后的未完成阶段、原因校验及重置隔离。
- `bash -n web/deploy/deploy.sh web/deploy/remote.sh` 与 `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s web/deploy -p 'test_*.py'`：13项发布校验通过，包含首次/后续回退、恶意归档、配置并发变化、脏构建及版本错配。
- Playwright：16项交互验收，逐页访问39页；覆盖七条流程及账号限制恢复、双语/三主题、全局搜索与筛选、详情与关联跳转、取消/重置、错误场景、375px导航与详情布局。
- 浏览器实际使用本机已有的 Chromium 151（Playwright缓存1232）；CI将使用当前锁文件对应的 Chromium。未将尚未完成的CI检查写为通过。
- 所有交互用例检查网络请求，仅允许本站 `/q-admin/` 静态GET，拒绝业务请求、外部域名及WebSocket。
- 目检桌面1440px与手机375px，包含深色、退款详情；首轮发现的顶部溢出和表头可访问文本逃逸已修复。没有宣称iOS/Android原生设备验收。

## 独立审查及修复

UI/状态审查与部署/CI审查分别由独立Agent进行。修复了：首页漏计AI排查、未知任务指标与目标列表不一致、静态快照残留待办、退款未完成提前离开队列、窄屏主题入口、输入校验错误误作完成，以及CI校验清单不兼容发布白名单。

部署脚本已审查命令参数、普通文件归档限制、SHA与pipeline对应、Nginx精确server选择、配置哈希并发保护、CSP与首次/后续回退。真实远端流水线与公网发布结果在交付MR和发布记录中单独注明。
