export type AppLocale = 'zh' | 'en';
export type AppCopy = readonly [string, string];
export const MODULE_IDS = ['chat', 'history', 'market-data', 'insurance', 'installments', 'finance', 'wallet', 'plugins', 'plugin-workbench', 'video', 'creators', 'keys', 'social', 'profile'] as const;
export type ModuleId = typeof MODULE_IDS[number];
export type AppModule = {
  id: ModuleId;
  title: AppCopy;
  summary: AppCopy;
  limits: AppCopy;
  access: 'public' | 'sign-in' | 'provider-connection';
  assistantRead: boolean;
};

/** Public product facts, not proof of a user's permissions or a deployed backend. */
export const APP_MODULES: readonly AppModule[] = [
  { id: 'chat', title: ['小Q对话', 'Chat with Q'], access: 'sign-in', assistantRead: false,
    summary: ['提问、解释金融知识、研究公开资料，并继续已有 AI 对话。', 'Ask questions, explain financial concepts and research public material in an AI conversation.'],
    limits: ['AI 需要登录、分享许可及可用模型；不默认读取其他对话或本地财务记录。', 'AI requires sign-in, sharing consent and an available model; other chats and local financial notes are not read automatically.'] },
  { id: 'history', title: ['历史对话', 'Chat history'], access: 'sign-in', assistantRead: false,
    summary: ['查看、打开和继续自己的 AI 历史对话。', 'View, open and continue your AI conversations.'],
    limits: ['本助手只提供入口，不跨对话搜索或读取私密正文。', 'This assistant offers navigation, not cross-chat searches or access to private message bodies.'] },
  { id: 'market-data', title: ['金融数据', 'Financial data'], access: 'public', assistantRead: true,
    summary: ['查询 BTC/ETH/SOL 链上美元参考价、指定美国公司的 SEC 申报和财经新闻样本。', 'Query BTC/ETH/SOL on-chain USD references, selected US company SEC filings and financial news samples.'],
    limits: ['不是交易所实时成交价；SEC 不含股票报价。新闻源可能限流，商用数据源未接通。', 'Not live exchange prices; SEC filings contain no stock quotes. News may be rate limited; commercial feeds are not connected.'] },
  { id: 'insurance', title: ['保险', 'Insurance'], access: 'public', assistantRead: true,
    summary: ['搜索险种，比较最多三类保障方向，查看投保前问题、理赔材料参考及官方信息入口。', 'Search coverage types, compare up to three coverage purposes, and read preparation questions, claim-document guidance and official sources.'],
    limits: ['知识导航不是在售产品清单；不报价、投保、核保、收款或办理理赔，人工客服未接通。', 'An educational guide, not live products. No quotes, applications, underwriting, payments, claims handling or connected live support.'] },
  { id: 'installments', title: ['分期', 'Installments'], access: 'public', assistantRead: false,
    summary: ['浏览机构公开资料、核对费用和申请前阅读事项。', 'Browse public provider information, fees to check and application-reading checklists.'],
    limits: ['未接机构办理接口；不能申请贷款或查询审批。首页旧分期成本计算已移除。', 'No provider application or approval interface. The former home-page installment calculator has been removed.'] },
  { id: 'finance', title: ['理财资料', 'Investment information'], access: 'public', assistantRead: false,
    summary: ['浏览机构与产品公开资料，按页面提供的字段阅读和对比。', 'Browse and compare public provider and product information using the fields shown on the page.'],
    limits: ['非实时产品库存；不开户、下单或保证收益，广告不作为推荐依据。', 'Not live product inventory. No account opening, orders or guaranteed returns; ads are not evidence for recommendations.'] },
  { id: 'wallet', title: ['钱包', 'Wallet'], access: 'sign-in', assistantRead: false,
    summary: ['查看已连接的内置银行模拟账户、余额和流水，并进入已有银行对话流程。', 'View connected built-in demo bank accounts, balances and transactions, and enter the existing bank-chat flow.'],
    limits: ['HKD/QDC 均为模拟资金；主助手入口不直接读取账户或执行转账。', 'HKD/QDC balances are simulated. This assistant entry does not directly read accounts or execute transfers.'] },
  { id: 'plugins', title: ['插件', 'Plugins'], access: 'provider-connection', assistantRead: false,
    summary: ['查看目录参考、添加个人 MCP 连接，并在连接自己的授权范围内使用工具。', 'Browse references, add personal MCP connections and use tools within that connection’s permissions.'],
    limits: ['目录出现不代表已连接；工具能力与权限由实际发现和授权决定。', 'A catalog entry is not a connection; runtime discovery and authorization determine capabilities.'] },
  { id: 'plugin-workbench', title: ['插件工作台', 'Plugin workbench'], access: 'public', assistantRead: false,
    summary: ['整理插件连接信息和标准接入材料，并前往添加个人连接。', 'Prepare standard plugin connection information and integration materials, then open personal connection setup.'],
    limits: ['不代替服务方部署、授权或公开上架，也不是使用插件的注册门槛。', 'Does not deploy, authorize or publicly list a service, and is not a registration gate for plugin use.'] },
  { id: 'video', title: ['视频创作', 'Video studio'], access: 'public', assistantRead: false,
    summary: ['体验本地视频创作演示，或进入 API 工作台配置真实视频生成任务。', 'Explore the local video creation demo, or open the API workbench for provider-backed generation tasks.'],
    limits: ['本地演示不等于已调用供应商；主助手不自动生成付费任务或发布作品。', 'A local demo is not a provider generation. This assistant does not automatically start paid tasks or publish content.'] },
  { id: 'creators', title: ['创作者广场', 'Creator feed'], access: 'public', assistantRead: false,
    summary: ['浏览应用内的视频演示内容。', 'Browse the app’s video demonstration content.'],
    limits: ['当前是本地演示，不是已开放的在线作品发布社区。', 'Currently a local demonstration, not an open online publishing community.'] },
  { id: 'keys', title: ['API 工作台', 'API workbench'], access: 'provider-connection', assistantRead: false,
    summary: ['管理个人可灵连接、填写视频生成任务并查询已提交任务。', 'Manage personal Kling connections, prepare generation tasks and check submitted tasks.'],
    limits: ['需要 Q 登录、供应商权限和提交确认；主助手不能读取密钥或承诺生成成功。', 'Requires Q sign-in, provider access and submission confirmation; the assistant cannot read keys or promise successful generation.'] },
  { id: 'social', title: ['好友与消息', 'Friends and messages'], access: 'sign-in', assistantRead: false,
    summary: ['管理好友申请，进入一对一聊天、阅后消息和关系设置。', 'Manage friend requests, one-to-one chats, disappearing messages and relationship settings.'],
    limits: ['主助手不读取私聊、不自动发信；没有系统离线推送或端到端加密承诺。', 'The assistant does not read private chats or send messages automatically; OS offline push and end-to-end encryption are not provided.'] },
  { id: 'profile', title: ['账号与设置', 'Account and settings'], access: 'sign-in', assistantRead: false,
    summary: ['打开个人资料、语言和主题等账号设置。', 'Open profile, language, theme and account settings.'],
    limits: ['主助手只提供入口，不修改密码、身份权限或账号状态。', 'This assistant offers navigation only; it does not change passwords, identity permissions or account status.'] },
];

export function isModuleId(value: unknown): value is ModuleId { return typeof value === 'string' && MODULE_IDS.some(id => id === value); }
export function appCopy(copy: AppCopy, locale: AppLocale): string { return copy[locale === 'zh' ? 0 : 1]; }
export function moduleDefinition(id: ModuleId): AppModule { return APP_MODULES.find(item => item.id === id)!; }

/** Concise context is safe to supply even when application-tool negotiation is unavailable. */
export function describeAppCapabilities(locale: AppLocale = 'en'): string {
  const intro = locale === 'zh'
    ? '小Q应用能力目录：以下是当前客户端的功能说明，不是账号权限或服务在线状态。先区分模块咨询、知识问题与执行请求；不要把“分期模块有什么用”解释为旧计算器任务。只有实际完成的工具结果能证明查询成功。只读应用工具限保险目录及公开市场资料，其余模块提供打开入口；打开页面不等于办理成功。不得读取其他私聊、本地财务记录、密钥或自动转账、发信、付费生成。广告不作证据。未部署的新协议或未知连接状态须明确说明。'
    : 'Q capability catalog: these are client feature facts, not account permissions or service health. Distinguish module questions, knowledge questions and action requests; asking about Installments is not a retired calculator task. Only completed tool results establish a successful query. App read tools cover insurance metadata and public markets; other modules provide navigation only. Opening a page is not completed business. Never read other private chats, local financial notes or keys, or automatically transfer, send messages or start paid generation. Ads are not evidence. State when tool negotiation or connection status is unavailable.';
  const entries = APP_MODULES.map(item => `${item.id}: ${appCopy(item.title, locale)}. ${appCopy(item.summary, locale)} ${appCopy(item.limits, locale)}`);
  return [intro, ...entries].join('\n');
}
export const CAPABILITY_GUIDANCE = describeAppCapabilities('en');
