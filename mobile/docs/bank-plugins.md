# 银行插件、首页对话与钱包

2026-10-21。源码实现；所有资金均为模拟，未连接真实银行系统。没有独立“银行演示”页面或本机资金账本。

## 使用路径

1. 登录 Q，进入“钱包 → 添加银行卡”，选择银行或明确添加全部 20 家；也可在“插件 → 银行插件”逐家添加。
2. 钱包查看自己的银行卡、模拟港币余额、转账记录和资金流水。每个新账户初始 HK$100,000；重复添加/重连不会补发。初始额度有真实 PostgreSQL 模拟分录。
3. 从卡片选择“在对话中转账”，或从插件选择“在聊天中用”。仍进入小Q首页对话。
4. 发送“从汇丰转500港币到陈小明的中银账户”，或点“填写转账”选择收款人、收款银行、金额与备注。表单只填入输入框，发送后才准备提案。
5. 核对银行、收款对象和金额，右滑或点击无障碍确认按钮；服务器原子记账后展示回执。钱包刷新后看到同一交易及收支分录。

本人跨行账户自转与虚构陈小明均支持；陈小明是每个 Q 用户各自隔离的模拟账户。不能转给真实手机号、银行卡或其他任意 Q 用户。即时模拟转账可用，预约/定期转账不支持；缺字段和歧义只提示补全。

## 视频映射

参考视频长约 30.5 秒，展示众安 App 中进入转账、选择已存收款人、切换收款银行、金额/即时/预约/定期入口及滑动确认。视频中的金额一直为 0，末尾提示该手机号未登记转数快，没有实际成功转账。实现保留“选择收款对象 → 银行切换 → 金额/备注 → 显式确认”的交互意图，使用 Q 原生组件和现有对话，不复制视频里任何私人手机号、姓名或通知内容。

## 插件与数据库边界

20 个受信服务端内置 `bank_demo` 插件复用现有提案/确认/结果恢复；普通远程插件继续使用 MCP。内置身份为 URN，不是伪造的 HTTPS Card 或 OAuth。三项能力为查询余额、模拟转账、查询转账记录。后端合同见 [banking.md](../../backend/contracts/banking.md)。

每个 Q 用户的本人/虚构收款人账户都保存在 PostgreSQL，和 QDC 分表。新模块不修改现有 QDC 账户、交易或用户资料。客户端只校验/展示结果，不决定最终余额。网络不确定时查询原请求；确认结果和账本同事务持久化。重新登录可恢复钱包及已保存对话/提案。

## 卡面来源

图片为银行官方公开产品参考，不是用户真实绑定的卡，也不是合作授权。图片上的样例号码属于公开产品素材；Q 账户标识另以 `DEMO …` 展示。画面仅用于内部演示，正式对外发布前需要另行确认素材使用条件。原始图片保存在 `mobile/native/assets/bank-cards/`；横幅通过原生视口展示其中卡面，未改写银行图案。

| 银行 | 公开素材/产品来源 |
| --- | --- |
| 汇丰 | [Mastercard Debit 产品页](https://www.hsbc.com.hk/debit-cards/products/mastercard-debit-card/)，`17578-hsbc-world-debit-mastercard-640x1024.jpg` |
| 中银香港 | [Debit 产品页](https://www.bochk.com/dam/more/bocdebitcard/card/en.html)，`card/images/debit-card/card-2.png` |
| 众安 | [ZA Card 产品页](https://bank.za.group/en/za-card)，官方 CDN `Cardheika_61877.png` |
| 工银亚洲 | [借记卡](https://www.icbcasia.com/hk/sc/personal/banking/others/debit-card/default.html)，`e-age-banking-debit-card.png` |
| 建银亚洲 | [银联双币借记卡](https://www.asia.ccb.com/hongkong/personal/banking_channels/dualcurrencydebitcard_cup.html)，`dc-card-01.jpg` |
| 大新 | [提款卡](https://www.dahsing.com/html/tc/deposit/atm_card/atm_card.html)，`dp_other7a_atm.jpg` |
| 招商永隆 | [电子服务](https://www.cmbwinglungbank.com/wlb_corporate/en/e-services/index.html)，`9.5-atm-card-thumb.jpg` |
| 上海商业 | [上银卡](https://www.shacombank.com.hk/tch/personal/other/atm/card/card.jsp)，`ATM_card_HKD.jpg` |
| 恒生 | [多货币借记卡](https://www.hangseng.com/personal/cards/products/multi-currency-debit-card/)，`HASE_MCYDC_Banner_2_EN.jpg` |
| 渣打 | [多货币借记卡](https://www.sc.com/hk/bank-with-us/multicurrency-debit-card/)，`hk-mcy-banner-oct25-1600-490.png` |
| 花旗 | [Debit Mastercard](https://www.citibank.com.hk/english/personal-banking/debit-mastercard/)，`citibank-debit-mastercard.jpg` |
| 星展 | [Diamond Debit](https://www.dbs.com.hk/personal/deposits/atm-services/dbs-diamond-debit-card)，`UnionPay_debit_card_1404x630.jpg` |
| 东亚 | [借记卡](https://www.hkbea.com/html/en/bea-debit-card-get-and-activate-your-card.html)，`Hero-Promo-EN-2.jpg` |
| 中信国际 | [官方发布资料](https://www.cncbinternational.com/_document/about-us/media-center/2025-10-13/en/p251013.pdf)，第 3 页独立借记卡原图 |
| Mox | [Apple Pay 产品页](https://mox.com/features/apple-pay-with-mox/)，`MOX_Applepay_IMG01_Desktop_EN.jpg` 中数字卡面 |
| livi | [2021 年虚拟借记卡官方资料](https://www.livibank.com/pdf/20210301-livi-partners-with-mastercard.pdf)，第 1 页宣传图；历史产品参考，不宣称当前实体卡 |
| 南洋商业 | [私人银行卡产品页](https://www.ncb.com.hk/nanyang_bank/privatebanking/HK/privilege.html)，`images/card.png` |
| 交通香港 | [香港 ATM 卡产品页](https://www.hk.bankcomm.com/hk/shtml/hk/tw/2005223/2005249/2005250/list.shtml)，`20151218151556591.jpg` |

18 家有可核验官方产品参考实图。富邦、集友未找到可核验的独立官方提款/借记卡面，在当前素材版使用明确“模拟数字账户”的原生卡面；没有用信用卡、台湾银行卡或他行图案替代。20 家银行名称依据 [HKMA 注册册](https://vpr.hkma.gov.hk/eng/regulatory-resources/registers/register-of-ais-and-lros/)，不使用注册编号代替转账银行代码。

## 开发基线与验收

本轮先获取 GitLab 远端并同步到 `main` 的 `8d37a03`。新建隔离开发库 `q_bank_demo`，原有 6 个迁移与源码校验一致后继续；银行新增迁移只进入这个开发库和随机 schema 测试库，线上仍按部署记录版本运行。

独立 PostgreSQL 测试：`bank_plugins` 覆盖 20 行一次发行、QDC 不变、用户隔离、同回执钱包/流水、重连不补发、并发透支、取消、数据库约束、分页与注销；`bank_plugin_runtime` 覆盖共用确认链、第三方不能伪造内置身份、提交故障整体回滚、并发确认/取消/断开。两组也分别被现有 `postgres` / `plugins` 测试目标包含，因此沿用既有 CI 检查入口，无需更改流水线。

客户端测试覆盖中英文/繁体解析、银行身份和金额响应校验、历史先保存再提案、原键重试、不创建账户、不自动确认，以及延迟旧账号结果隔离。具体最终运行记录在本轮交付补充；单元测试不等于设备交互、第三方 OAuth、真实银行或供应商实账验收。

### 本轮实际结果（2026-10-21 至 10-22，北京时间）

- `npm --prefix mobile run typecheck`、`lint`、`export:web` 通过；`test:utils` / `test:video` / `test:plugins` / `test:api-workbench` / `test:account` / `test:social` / `test:chat` 通过，共 260 项（23 / 10 / 59 / 11 / 42 / 33 / 82）。OpenAPI 再生前后摘要一致。
- `cargo fmt --manifest-path backend/Cargo.toml --check`、`cargo clippy --manifest-path backend/Cargo.toml --all-targets --all-features -- -D warnings`、默认 `cargo test --manifest-path backend/Cargo.toml` 通过。默认测试中标为 ignored 的 PG 用例另行执行，不算默认运行通过。
- 在独立 `TEST_DATABASE_URL` 下，以 `--all-features --test postgres --test plugins --test ai_plugins --test social --test account_lifecycle --test ai_history -- --ignored` 实际通过 48 项。另以匹配 PostgreSQL 17.10 客户端执行 `social_backup -- --ignored`，真实转储恢复 1 项通过。新银行专项共 10 项包含在这些目标中。
- 因隐私页文字更新，独立 Web 的 `typecheck`、`lint`、`test`、`build`、`test:e2e` 通过（17 项逻辑、17 项浏览器交互）。本地使用已有 Chromium revision 1232；首次默认路径缺 revision 1248，指定现有浏览器路径后通过，未修改 CI 浏览器版本。
- iPhone 17e / iOS 27 / Expo Go：专用 `bankqa` 账号从空钱包明确添加 20 行，初始总额 HK$2,000,000；从钱包进入首页，发送 500 港币到虚构陈小明，保存待确认提案；点击明确确认后余额 HK$99,500。钱包回执及支出流水和聊天使用同一交易编号，初始额度与支出分别展示。切换卡片可定位对应卡面及筛选流水。
- 重启专用开发 API 和该模拟器 Expo Go 后，Q 登录恢复、历史对话恢复为同一成功回执，银行卡数量、余额与交易数量保持不变。没有重复记账，没有重发初始额度。
- 滑动控件的实际组件事件测试 3 项通过：85% 横向阈值、取消/纵向移出/多指不确认、无障碍按钮共用防重复锁、busy 与 Reduce Motion。电脑控制工具的拖动坐标映射不稳定，本轮不把它写成已完成原生手势验收；原生实际使用的是明确确认按钮。Android、真实设备及外部银行服务未验收。
- 独立只读复审修复并复核：平铺回执解码、分页切卡永久忙碌、业务失败原因隐藏、第三方付款来源被误用本人账户；最终 Accept。卡面参考与模拟标识、连接类型和账号隔离保留。

运行日志与本轮模拟器截图保存在本机忽略目录 `mobile/.local/bank-validation/` 与 `mobile/.local/screenshots/banking/`。本节记录本地验收；提交后的 MR 与远端流水线结果以对应最新提交为准，不把本地通过写成远端通过。线上数据库与 TestFlight 未因本次代码变更自动升级。

### 提交前复核（2026-10-22）

已再次同步 GitLab，当前基线为 `8d37a03`，独立完整 diff 复审 Accept，无遗留 P1/P2。移动端全部检查和导出、Rust 格式/默认及全功能 clippy/单元测试、48 项隔离 PostgreSQL 回归、Web 全套检查重新通过。截图中的 `bankqa` 连接专用 `127.0.0.1:18794` 测试 API，`configured=false` 是该进程未加载 DeepSeek 密钥的明确状态；同轮只读查询公网 API 的 `configured=true`，没有改动公网配置或发起模型付费请求。此 MR 交付模拟银行插件，不包含部署或公测包更新。
