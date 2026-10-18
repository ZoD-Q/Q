# UI精简与白色青蓝设计

## 用户方向

小Q仍然以AI对话和输入框为首页。默认改为白色，允许少量青/蓝；服务全部留在侧栏。降低同时可见的操作和解释数量，保留可发现性，不以缩小正文代替设计。

## GitHub研究

2026-10-18通过GitHub公开API读取：

| 资源 | 查询时stars | 采用方式 |
| --- | ---: | --- |
| https://github.com/nextlevelbuilder/ui-ux-pro-max-skill | 137067 | 安装ui-ux-pro-max技能，采用渐进展示、触控、对比和原生表单检查。MIT。 |
| https://github.com/anthropics/skills/tree/main/skills/frontend-design | 所在仓库181900 | 安装为anthropic-frontend-design；采用单一焦点、功能文案和去装饰的评审。该skill目录Apache-2.0。 |
| https://github.com/shadcn-ui/ui | 125848 | 只参考信息组织；DOM/Tailwind组件不直接引入React Native。MIT。 |
| https://github.com/DavidHDev/react-bits | 49585 | 评估后未引入装饰背景或文字动效。 |
| https://github.com/software-mansion/react-native-reanimated | 11025 | 实际使用Expo58推荐4.7.1，按压与局部状态淡入；遵循Reduce Motion。MIT。 |
| https://github.com/gorhom/react-native-bottom-sheet | 9107 | 评估成熟底部交互模式，当前不增加第二套sheet依赖。MIT。 |

HeroUI Native官方当前不推荐web；本项目仍需Expo浏览器预览，未整套引入。Expo UI也已评估，但本轮优先改信息架构，不为视觉换皮重写所有原生控件。

UI UX Pro Max的自动design-system初次查询给出营销落地页和紫色默认，不符合本任务，因此未采用或持久化该自动结果。只采纳核实适用的移动触控、键盘避让、信息渐进展示规则。用户明确的白色青蓝优先。

## 实施

- 白底#FFFFFF、轻灰#F4F7F9、正文#202B33、次文字#65737E、青蓝#087FA3、浅青#EAF6FA。白字/青蓝对比4.59:1，次文字/白底4.88:1。
- 首页使用小Q原创Q标记，去掉描边建议卡片。手机输入框靠底，桌面集中到内容中心。工具选项放到点开的面板。
- 窄导航保留每个服务入口，hover/focus显示名称，可展开；短窗口中间可滚动，顶底操作固定。
- 服务页用功能名，删除重复营销标题、大装饰、默认铺满的条款/计划/选项。细节在操作后展示。
- 设置首屏只有资料摘要与外观、语言、账号入口，编辑在弹层内。
- Reanimated按压90/150ms、局部淡入180ms，尊重系统减少动态效果。iOS选择操作增加轻触反馈，其他平台有视觉反馈。
- 模型/思考/搜索状态切页保留。原型保持纯前端，未修改Rust业务或数据库。

## 校验

已做TypeScript、ESLint、Web静态导出。iPhone18Pro/iOS27的竖屏聊天和真实插件搜索可运行；横屏检查发现并补充左右安全区。浏览器自动化仍被Work设置关闭，因此未宣称完成桌面浏览器点击验收。未新增真实支付、模型调用或插件执行。
