# 构建 5、安卓测试包与 TestFlight 公测状态

记录日期：2026-11-04，北京时间。两端应用身份均为 `com.kaicloud.xiaoq`，版本名 `0.1.0`，构建序号为 `5`，连接正式 HTTPS API `https://q.kaicloudpay.com`。

## TestFlight：已上传，公测尚未完成

iOS 业务源码冻结于已人工合并的 GitHub main `05f2b02fe102b9bd90f1c10fb54dc1d0e0c7daa5`；当时 GitLab main `c4770de` 与其代码树相同。归档时仅将 iOS 构建序号从 4 覆盖为 5，记录原字节、配置差异与输入摘要，导出完成后恢复原文件。随后提交的 Android 修复不能回标为此 IPA 的来源。

本机现有 Apple Distribution 身份、团队和 App Store 描述文件完成签名。IPA 内原生 Info.plist 与 EXConstants 均为 `0.1.0 (5)`；包身份、正式 API、非调试权限、签名及秘密文件/已知私密标记扫描通过。

| 项目 | 已取得的证据 |
| --- | --- |
| IPA SHA-256 | `55b468dc4281199d286fc74aebfc72bfb1e33d25c9550083fd231bb173d9e18f` |
| IPA 大小 | 25,103,363 字节 |
| Apple 接收 | 原有 Xcode 账号完成一次上传，退出码 0，日志 `Upload succeeded` |
| 外部测试选项 | 原生分发日志明确 `testFlightInternalTestingOnly=false` |
| 公测状态 | **尚未完成核验及分发操作**；未确认处理 VALID、原公测组构建、Beta 审核及公开下载可用状态 |

用户要求更新现有外部公测。当前 Safari、Chrome 与保存的 App Store Connect 网页会话均需重新验证；用户暂时无法登录，本机未配置可用的 App Store Connect API Key。Xcode 上传成功不提供网页公测组管理会话。已准备公测更新说明，并确认原私密 App Review 测试账号仍能登录 Q。

恢复 App Store Connect 验证后，应先读取构建 5 的处理及外部测试状态，再沿用原公测组和公开链接，添加构建并完成实际需要的 Beta App Review，确认 Testing 和真实公测下载结果。上述步骤未完成前，不能宣称公测已更新。真机 TestFlight 安装未验收。

## Android：供用户本人安装审核的测试制品

本次 Android 包来自 `Mandow` 的修复候选，运行源码提交为 `194b8320303fb8dd37d0fb1afe56d7aca025fde2`，完整源码树为 `a6b380b922891af518ad0cde68a5468d63a2402f`。先按该树构建和完成原生回归，再提交完全相同的源码树。后续发布记录和截图属于非运行文档。

该 APK 用于用户本人安装和审核；源码通过 MR/PR 人工合并。此交付不表示已合入 main、已上传 Google Play 或已进行 Android 公众分发。

| 项目 | 验证结果 |
| --- | --- |
| APK SHA-256 | `f8203d455a1cf22ff5ae1ac254f335d6187b72fcd840cb33501ab5ecb620efaf` |
| APK 大小 | 42,167,802 字节 |
| 身份与版本 | `com.kaicloud.xiaoq`、`0.1.0 (5)`、arm64；不可调试 |
| 原签名证书 SHA-256 | `91ad148b0eb6cec55e4ace5214eb8650c41aa7dfefbc13d755d6f7d8aabba486`，与之前 APK 一致 |
| 运行配置 | EXConstants 与原生版本均为 5；正式 HTTPS API |
| 权限与对齐 | 最终清单无 `SYSTEM_ALERT_WINDOW`；ZIP 及包内 ELF 的 16KB 对齐检查通过 |
| 秘密检查 | 无签名私钥文件、凭据文件或 PEM 私钥标记；实际商户、审核/测试账号及签名密码的已知标记未嵌入 APK |

## 复现与修复

1. `scb-reference.png` 实际为 JPEG，真实 SDK 37 AAPT2 编译返回 PNG 签名错误。按实际格式改名为 `.jpg` 并修正引用，同一字节的 AAPT2 编译和完整 APK 构建通过。
2. Expo 默认 Android 主清单模板声明了正式功能不需要的悬浮窗权限。使用标准 `android.blockedPermissions` 生成移除规则，最终 APK 清单已核对。
3. 登录 Sheet 的字段和提交按钮被 IME 遮挡；系统返回还会直接关闭弹窗。Android Sheet 使用高度避让，键盘可见时第一次返回先收键盘，第二次才关闭弹窗。
4. 聊天输入/发送与充值报价按钮也被 IME 遮挡。聊天补充 Android 高度避让和实际页头偏移；充值仅为自身 Page 启用 Android 避让。页头偏移为安全区顶部加实际 60/70pt 工具栏，Sheet 的独立 Modal 保留屏幕坐标处理；Page 默认及 iOS/Web 分支保持既有行为。

## 真实 Android 回归

设备为专属 Android 16 / API 36 arm64 模拟器，1080×2400。用户明确允许本次 ADB 点击、截图与键盘验收；没有操作个人真机。

- 从旧版本 3 覆盖升级到候选 5，首次安装时间保留。后续候选之间的 UID 与会话保留；初始版本 3 的 UID 未被成功解析，不作为全链 UID 直接比对证据。
- 登录字段、密码及提交按钮在键盘上方可见或可滚到；纯测试输入没有提交。第一次返回收键盘并保留表单，第二次关闭；重新打开正常。原私密 QA 账号可正常登录。
- 聊天输入区 y1243–1327、发送按钮 y1349–1475 均高于 IME 顶部 y1517。输入测试草稿后清理，没有发送消息。
- 充值数字 IME 顶部 y1633；正常滚动后金额 y511–637、报价按钮 y1199–1319 可操作。在键盘仍开启时单击一次即成功取得报价，随后键盘自然收起。
- 微信和支付宝均核对到 HKD 10、CNY 8.56、费用 CNY 0.08、ECB 来源日期与倒计时；余额、待处理/历史空订单列表、返回与再进入正常。未点击支付、创建收银台或执行付款。
- 无键盘的模型 Sheet 一次返回可关闭。结束时退出仅本轮创建的 QA 会话，恢复原未登录首页、原硬键盘 IME 设置与测试前草稿状态。

以下原始 PNG 未编辑，仅含纯测试文本或金额。登录修复图为最终候选的纯测试输入与可见提交按钮状态。

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 登录 Sheet | [被键盘遮挡](login-before.png) | [表单可操作](login-after.png) |
| 聊天输入 | [输入区不可见](chat-before.png) | [输入与发送可见](chat-after.png) |
| 充值输入 | [报价按钮被遮挡](funding-before.png) | [可滚到报价按钮](funding-after.png) |

UIAutomator 在动态重渲染时曾无法达到 idle；旧 XML 已标为无效，没有拿旧坐标认定产品失败。最终结果使用实际查看的新鲜截图，以及能够取得的当前 native hierarchy。真机、其他 Android 版本、平板、16KB 系统实机和实际支付审批入账闭环未覆盖。

## 自动验证与证据

最终代码执行移动端 typecheck、lint、八组功能测试共 590 项、正式 HTTPS 下的 Web 导出，11 个命令全部通过，无失败或跳过；差异检查通过。图片原字节、AAPT2、签名、版本、权限、API、16KB 对齐及秘密扫描单独验证。远端检查以 MR/PR 最新提交的实际结果为准。

忽略目录保留 iOS 归档、导出、上传回执和分发日志，Android 各候选与输入哈希，以及完整原生回归记录。凭据、私钥、原始私密界面、实际审核账号和令牌不进入 Git。支付服务器与实账验收边界见[支付部署记录](../../../backend/deploy/PAYMENTS-2026-11-03.md)。
