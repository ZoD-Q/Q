# 保险全景面板（2026-10-22）

入口：小Q侧栏 → 保险。当前服务路由使用 `prototype/insurance/page.tsx`；原有保险演示文件保留但不作为新目录入口。理财页面及原有三家公司内容未在本任务修改。

## 内容范围

以中国大陆常见商业保险为范围，提供 8 个导航板块、43 个保障入口。入口包含险种、附加险、产品形态和人群分类，**不是互斥的监管分类，也不是全市场在售产品数据库**。

| 板块 | 数量 | 内容 |
| --- | ---: | --- |
| 健康医疗 | 8 | 百万医疗、门急诊、中高端医疗、重疾、防癌、惠民保、商业长期护理、特药 |
| 意外出行 | 5 | 综合意外、境内旅游、境外旅游/留学、交通意外、少儿/老年意外 |
| 人寿养老 | 5 | 定期寿险、终身寿险、年金、养老年金、分红/万能/投连形态 |
| 车险 | 6 | 交强险、商业三者、车损、车上人员、新能源专属、附加险 |
| 家庭财产 | 3 | 家财、家庭/租客责任、宠物医疗/责任 |
| 企业责任 | 7 | 雇主、团体意外/健康、公众、产品、职业、企业财产/营业中断、网络安全 |
| 工程运输 | 4 | 建筑/安装工程、机器损坏、货运、船舶/航空 |
| 农业信用 | 5 | 种植、养殖、森林、信用、保证 |

目录支持中英文关键词与分类交集检索、空结果恢复、保障详情和最多三项对比（保留最近三项）。每个入口包含保障方向、重点核对、投保前询问清单、理赔材料参考。投保指南包含五步流程及常见疑问。沿用三主题和中英文界面；原生视觉验收为中文 warm 主题，其他主题和 iOS 尚未逐项设备验收。

## 公开来源与编辑边界

- [平安保险目录](https://www.pingan.com/official/insurance/)：已读取，健康、意外、旅游、家庭和企业保障方向。
- [新华保险产品目录](https://www.newchinalife.com/spage/cn/266/index.html)：已读取，人寿、健康、年金及意外方向。
- [中国人保子公司介绍](https://www.picc.com.cn/gyrb/jtjs/zgsjs/)：搜索索引确认财产、责任、运输、农业与信用保证等业务；直接抓取正文为空，不能称正文已完整核验。

分类、简要保障与阅读提示为编辑整理，未逐项关联某家公司的在售保单。未采集实时费率、保额或核保条件，不能理解为上述公司均在销售全部列出类型。外链限固定官方 URL，打开前确认，不自动提交信息。后续维护需核对官方条款和信息日期。

## 后端预留

Rust `insurance` 模块新增公开状态接口及两个要求 Q 登录的预留接口。详见后端 `contracts/api.md` 与 `contracts/openapi.json`；共享类型已通过 `api:generate` 再生。

| 接口 | 当前行为 |
| --- | --- |
| `GET /v1/insurance/status` | 对话、咨询和个人数据接收能力均为 false |
| `POST /v1/insurance/conversations` | 验证身份与消息，返回 503 `INSURANCE_SUPPORT_UNAVAILABLE` |
| `POST /v1/insurance/inquiries` | 验证身份、主题与问题，返回 503 `INSURANCE_INQUIRY_UNAVAILABLE` |

主题为 coverage/eligibility/claims；消息和问题 trim 后 1–1000 Unicode 字符。拒绝未知字段、非法主题和 NUL。无数据库迁移，不保存咨询，不向外部发送信息，不创建会话或工单。前端显示服务未接通，不开放输入提交表单，不调用预留 POST。以后启用真实服务时还需对接供应商、按能力状态启用表单、实现归属隔离与数据处理规则。

## 验证

- 移动端 typecheck、lint、export:web 均通过。
- test:utils 13、test:video 10、test:plugins 29、test:api-workbench 11、test:account 18、test:social 19，共 100 项通过。
- 新增目录测试覆盖唯一 ID、分类与内容完整性、中英文检索、空白输入、无结果和分类交集。
- Rust fmt --check、clippy --all-targets -- -D warnings、cargo test、cargo build --locked 通过；53 项单元测试通过，包括 4 项保险测试。已有需独立 PostgreSQL 的 18 项 ignored 测试本次未运行；未修改数据库、身份或账本实现。
- 本地 Rust 服务实际请求：状态三项 false；合法咨询和对话各返回约定 503；无身份返回 401；非法主题、空消息、1001 字符消息、额外 user_id 各返回 400。7 个请求断言通过，验证使用临时登录会话并已撤销该会话。
- Android `emulator-5554` / Expo Go：目录加载、车险筛选 6 项、交强险详情、两项保障对比、咨询不可用提示已实测。截图在仓库父目录 `insurance-dashboard-android.png`、`insurance-detail-android.png`、`insurance-support-android.png`。
- 无提交、推送或部署。未对接真实客服、核保、报价、出单、付款；iOS 未验收。
