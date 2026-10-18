# 当前版本

2026-10-18 按用户最新要求改为白色青蓝，并简化首屏与服务层级。当前设计以 [最新设计记录](ui-research-2026-10-18.md) 为准。以下保留上一轮设计依据。

# 小Q前端设计 · 对话为中心

本轮只设计UX/UI，不调用Rust API、模型接口或支付服务。旧账户与演示账本代码及数据保留，新入口使用独立DesignProvider，启动无需数据库。

## 设计依据

实读Anthropic/Claude官方页面及官方样式：暖白底、深墨文字、少量陶土强调，Serif/Sans/Mono各有用途。借鉴其信息层级，不复制品牌标识或专有字体。主页输入框与欢迎语是唯一视觉中心，所有服务留在侧栏。

- https://www.anthropic.com/
- https://claude.com/product/overview
- https://support.claude.com/en/articles/8114491-get-started-with-claude
- https://developer.apple.com/design/human-interface-guidelines/layout
- https://developer.apple.com/design/human-interface-guidelines/typography
- https://developer.apple.com/design/human-interface-guidelines/sidebars
- https://developer.apple.com/design/human-interface-guidelines/buttons

## 页面

- 对话：首页欢迎语、多行输入框、模型选择、思考/搜索选项、工具入口与本地示例对话。不会伪造真实模型调用。
- 历史：本次浏览的对话列表、搜索、回到对话。
- 插件：指定Excel原始名称/讨论分组/简介，搜索、分组、分页增量展示、详情和本地收藏。139条有内容记录可浏览，37空占位保留在数据层，未合并同名记录。详见plugin-catalog-source.md。
- 分期：服务商品、期数、每期金额、总金额、还款计划与确认预览。
- 保险：保障场景、方案选择与比较、明细、确认预览。
- API Key：项目/环境、示例凭证、权限、创建预览、示例调用。无可用密钥生成。
- 钱包：示例余额、流水筛选、转账确认、收款说明、渠道选择。不会访问旧API或改余额。
- 理财：规划中的三个名称目录与服务详情预览，无机构合作宣称。
- 资料：本次浏览保存昵称/头像/简介、三主题、中英文切换、登录界面预览。
- 消息：消息/好友/系统通知、本地示例会话与搜索。

## 实现边界

`native/src/prototype` 为本轮界面。`native/src/app`只接新原型入口。旧screens/providers/services保留以便后续按模块接回；当前不加载其网络请求或会话恢复。

所有交互仅保留本次浏览状态，刷新重置。服务价格、余额、保障、凭证均为界面示例，正式内容待产品确认。

## 目录

项目根目录可见仅web/mobile/backend。mobile拥有前端workspace与文档，backend拥有Rust/API合同/数据库工具。仅隐藏Git元数据留在根。
