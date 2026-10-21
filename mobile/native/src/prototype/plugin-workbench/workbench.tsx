import { useEffect, useState, type ReactNode } from "react";
import { KeyboardAvoidingView, Linking, Pressable, ScrollView, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import {
  ArrowLeft, ArrowRight, Check, ChevronDown, ChevronRight, Code2, Copy,
  FileJson2, Globe2, Link2, ListChecks, Server, ShieldCheck,
  type LucideIcon,
} from "lucide-react-native";
import { Action, Choice, Divider, Input, Page, Sheet, Tabs, Tag, Type, useDesign } from "../design";
import { usePluginWorkbench } from "./state";
import { inspectEntry, type EntryKind, type Issue, type PluginDraft, type PluginEntryIntent } from "./materials";

const entryChoices: { id: EntryKind; zh: string; en: string; placeholder: string; hintZh: string; hintEn: string }[] = [
  { id: "auto", zh: "自动识别", en: "Automatic", placeholder: "https://example.com/plugin", hintZh: "填写完整 HTTPS 链接或纯域名。实际类型将在「我的连接」中按服务响应识别。", hintEn: "Use a complete HTTPS link or a domain. My connections identifies the entry from the service response." },
  { id: "card", zh: "Server Card", en: "Server Card", placeholder: "https://your-domain.com/server-card.json", hintZh: "推荐。一个插件对应一个稳定地址，返回描述身份与连接方式的 JSON。", hintEn: "Recommended. One stable URL per plugin, returning identity and connection metadata as JSON." },
  { id: "domain", zh: "域名", en: "Domain", placeholder: "your-domain.com", hintZh: "只填域名。服务器需在 /.well-known/ai-catalog.json 提供目录。", hintEn: "Enter a domain only. Host a catalog at /.well-known/ai-catalog.json." },
  { id: "page", zh: "介绍页", en: "Intro page", placeholder: "https://your-domain.com/plugins/calendar", hintZh: "页面需用静态 rel=ai-catalog 或 HTTP Link 声明目录；普通网页链接还不够。", hintEn: "Declare a catalog with a static rel=ai-catalog link or HTTP Link header. A regular web page alone is not enough." },
  { id: "catalog", zh: "Catalog", en: "Catalog", placeholder: "https://your-domain.com/catalog.json", hintZh: "目录链接到独立 Server Card。多个服务由用户选择，不会自动全部添加。", hintEn: "A catalog links to individual Server Cards. Users choose among multiple services; they are not all added at once." },
];
const DOC_URL = "https://gitlab.kai.com/KAI/oD/ZoD/Q/-/blob/main/backend/docs/plugin-integration.md";
const noErrors = (issues: Issue[]) => !issues.some(issue => issue.level === "error");

function SectionHeading({ title, detail, icon: Icon }: { title: string; detail?: string; icon?: LucideIcon }) {
  const { colors } = useDesign();
  return <View style={{ gap: 7 }}>
    <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
      {Icon ? <Icon size={20} color={colors.accent} strokeWidth={1.7} /> : null}
      <Type size={18} weight="600" header style={{ flexShrink: 1 }}>{title}</Type>
    </View>
    {detail ? <Type size={14} muted>{detail}</Type> : null}
  </View>;
}

function Issues({ issues, includeScope = false, showFields = false }: { issues: Issue[]; includeScope?: boolean; showFields?: boolean }) {
  const { colors, text } = useDesign();
  const visible = issues.filter(issue => includeScope || issue.field !== "scope");
  if (!visible.length) return null;
  return <View accessibilityLiveRegion="polite" style={{ gap: 8 }}>
    {visible.map((issue, index) => <Type key={`${issue.field}-${index}`} size={13} selectable color={issue.level === "error" ? colors.danger : colors.muted}>
      {showFields && issue.field !== "scope" ? `${issue.field}: ` : ""}{text(issue.zh, issue.en)}
    </Type>)}
  </View>;
}

function Disclosure({ title, children, open, onToggle }: { title: string; children: ReactNode; open: boolean; onToggle: () => void }) {
  const { colors } = useDesign();
  return <View>
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded: open }} onPress={onToggle}
      style={({ pressed }) => ({ minHeight: 48, flexDirection: "row", gap: 12, alignItems: "center", paddingVertical: 10, opacity: pressed ? 0.65 : 1 })}>
      <Type size={14} weight="500" style={{ flex: 1 }}>{title}</Type>
      {open ? <ChevronDown size={17} color={colors.muted} /> : <ChevronRight size={17} color={colors.muted} />}
    </Pressable>
    {open ? <View style={{ gap: 16, paddingTop: 8, paddingBottom: 14 }}>{children}</View> : null}
  </View>;
}

function Requirement({ icon: Icon, title, description, badge }: { icon: LucideIcon; title: string; description: string; badge: string }) {
  const { colors } = useDesign();
  return <View style={{ flexDirection: "row", gap: 12, paddingVertical: 16, borderTopWidth: 1, borderColor: colors.line }}>
    <Icon size={19} color={colors.muted} strokeWidth={1.5} style={{ marginTop: 3 }} />
    <View style={{ flex: 1, gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <Type size={14} weight="500">{title}</Type><Tag>{badge}</Tag>
      </View>
      <Type size={13} muted>{description}</Type>
    </View>
  </View>;
}

function PreparationGuide() {
  const { colors, text } = useDesign();
  const { tab, draft } = usePluginWorkbench();
  return <View style={{ gap: 16, backgroundColor: colors.soft, borderRadius: 18, padding: 22 }}>
    <SectionHeading title={text("接入要准备什么", "What you need")} icon={ListChecks} />
    <View>
      <Requirement icon={Link2} title={text("给 Q：一个入口链接", "For Q: one entry link")} badge={text("必需", "Required")}
        description={text("优先提供独立 Server Card 的 HTTPS 地址。这个通道接收链接，不上传源码或压缩包。", "Prefer the HTTPS URL of a standalone Server Card. This flow takes a link, not source code or a ZIP archive.")} />
      <Requirement icon={Server} title={text("你的服务器：MCP 服务", "Your server: MCP service")} badge={text("必需", "Required")}
        description={text("部署可运行的 MCP 2026-07-28 服务，使用 HTTPS Streamable HTTP，提供实时能力与文本结果。", "Run MCP 2026-07-28 over HTTPS Streamable HTTP, with live discovery and understandable text results.")} />
      <Requirement icon={FileJson2} title={text("你的服务器：Server Card", "Your server: Server Card")} badge={text("必需", "Required")}
        description={text("每个插件一份稳定的身份与连接描述。工具、权限和授权配置不放进 Card。", "One stable identity and connection description per plugin. Keep tools, permissions, and authorization configuration out of the Card.")} />
      <Requirement icon={Globe2} title="AI Catalog" badge={text(tab === "prepare" && (draft.domainDiscovery || draft.publicListing) ? "本次需要" : "按需", tab === "prepare" && (draft.domainDiscovery || draft.publicListing) ? "Needed here" : "When needed")}
        description={text("用域名发现时提供根目录；用介绍页时声明目录。公开收录还需发布者自己的公开 Catalog。", "Use a root catalog for domain discovery, or declare a catalog on an intro page. Public listing requires the publisher’s own public catalog.")} />
      <Requirement icon={ShieldCheck} title={text("账户授权 / 交互界面", "Account access / UI")} badge={text("按需", "When needed")}
        description={text("访问用户账户：MCP 授权 + CIMD。提供对话内界面：MCP Apps。普通文本工具不必提供界面。", "For account access: MCP authorization + CIMD. For in-chat UI: MCP Apps. Text tools do not need a UI.")} />
    </View>
    <Type size={12} muted>{text("无需开发者账号、Registry 注册或人工上架审核。服务自己的登录与订阅条件仍可保留。", "No developer account, Registry registration, or manual listing review is required. Your service may still require user login or a subscription.")}</Type>
  </View>;
}

function ConnectionChecks({ onConnect }: { onConnect: (intent: PluginEntryIntent) => void }) {
  const { colors, text, locale } = useDesign();
  const state = usePluginWorkbench();
  const [showJson, setShowJson] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showChecklist, setShowChecklist] = useState(false);
  const { copy, copyError, copiedValue, resetCopy } = useCopy();
  const selected = entryChoices.find(choice => choice.id === state.entryKind)!;
  const passed = state.entryReport && noErrors(state.entryReport.issues);
  const cardPassed = state.cardReport && noErrors(state.cardReport.issues);
  const continueConnection = () => {
    const report = inspectEntry(state.entry, state.entryKind);
    state.checkEntry();
    if (noErrors(report.issues)) onConnect({ entry: state.entry.trim(), kind: state.entryKind });
  };
  const summary = locale === "zh" ? [
    "Q 插件接入清单（本地准备，尚未提交或接通）",
    `交给 Q 的入口：${state.entryReport?.normalizedUrl ?? ""}`,
    `入口类型：${selected.zh}`,
    "服务端必须提供：稳定的独立 Server Card、HTTPS Streamable HTTP MCP 2026-07-28 服务。",
    "域名入口需根 Catalog；介绍页需静态 Catalog 声明；Catalog 指向独立 Card。",
    "若访问用户账户：MCP 授权、Protected Resource Metadata、双方支持 CIMD；不提供真实密钥。",
    "若提供交互界面：MCP Apps 2026-01-26、ui:// 资源、文本降级。",
    "上线联调：确认添加 → 按需账户授权 → server/discover 与首次工具调用。",
    "未验证：链接返回内容、服务可达性、运行时发现、授权、业务调用、Apps 沙箱。",
    "公开索引另需发布者公开 Catalog 与来源、robots/noindex 校验；不影响个人连接。",
  ].join("\n") : [
    "Q plugin checklist (prepared locally; not submitted or connected)",
    `Entry for Q: ${state.entryReport?.normalizedUrl ?? ""}`, `Entry type: ${selected.en}`,
    "Host a stable standalone Server Card and an HTTPS Streamable HTTP MCP 2026-07-28 service.",
    "Domains need a root Catalog; intro pages need a static Catalog declaration; Catalogs point to separate Cards.",
    "Account access requires MCP authorization, Protected Resource Metadata, and CIMD on both sides. Do not supply real secrets.",
    "In-chat UI requires MCP Apps 2026-01-26, ui:// resources, and text fallback.",
    "Integration: confirm addition → authorize if needed → server/discover and a first tool call.",
    "Not verified: returned content, reachability, discovery, authorization, business calls, and Apps sandboxing.",
    "Public indexing separately needs publisher consent, origin and robots/noindex checks; it is not required for a personal connection.",
  ].join("\n");
  return <View style={{ gap: 22 }}>
    <SectionHeading title={text("添加已有插件", "Add an existing plugin")} detail={text("粘贴服务方给你的链接，下一步查看名称、所有者和来源后确认添加。", "Paste the publisher’s link. Review the name, owner, and source before adding it.")} icon={Link2} />
    <Input label={text("插件链接", "Plugin link")} value={state.entry} onChangeText={state.setEntry} placeholder={selected.placeholder}
      autoCapitalize="none" autoCorrect={false} keyboardType="url" maxLength={4096} hint={text("完整 HTTPS 链接或域名，不含密钥和令牌。", "A complete HTTPS link or domain, without keys or tokens.")} />
    <Issues issues={state.entryReport?.issues.filter(item => item.level === "error") ?? []} />
    <Action label={text("继续添加", "Continue to add")} icon={ArrowRight} disabled={!state.entry.trim()} onPress={continueConnection} style={{ alignSelf: "flex-start" }} />
    <Disclosure title={text("高级格式检查（可选）", "Advanced format checks (optional)")} open={showAdvanced} onToggle={() => setShowAdvanced(value => !value)}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
        {entryChoices.map(choice => <Choice key={choice.id} label={text(choice.zh, choice.en)} selected={choice.id === state.entryKind} onPress={() => state.setEntryKind(choice.id)} />)}
      </View>
      <Type size={13} muted>{text(selected.hintZh, selected.hintEn)}</Type>
      <Action kind="secondary" label={text("只检查链接格式", "Check format only")} icon={Link2} onPress={state.checkEntry} style={{ alignSelf: "flex-start" }} />
      {state.entryReport ? <View accessibilityLiveRegion="polite" style={{ gap: 8 }}>
        <Type size={14} weight="500" color={passed ? colors.accent : colors.danger}>{text(passed ? "格式检查通过" : "请修改链接", passed ? "Format checks passed" : "Update the link")}</Type>
        <Issues issues={state.entryReport.issues.filter(item => item.level !== "error")} />
        <Type size={12} muted>{text("这里只检查格式，尚未访问服务或建立连接。", "These checks do not contact the service or create a connection.")}</Type>
      </View> : null}
    </Disclosure>
    <Disclosure title={text("检查 Server Card 内容（可选）", "Check Server Card content (optional)")} open={showJson} onToggle={() => setShowJson(value => !value)}>
      <Type size={13} muted>{text("粘贴 JSON，检查关键字段、端点与协议版本。不执行内容，也不代替完整 schema 校验。", "Paste JSON to inspect key fields, endpoints, and protocol versions. Content is not executed; this is not complete schema validation.")}</Type>
      <Input label="Server Card JSON" multiline value={state.cardInput} onChangeText={state.setCardInput} autoCapitalize="none" autoCorrect={false}
        maxLength={65537} placeholder={'{\n  "$schema": "…",\n  "name": "com.example/calendar",\n  "remotes": […]\n}'} style={{ minHeight: 190, fontSize: 13, fontFamily: process.env.EXPO_OS === "ios" ? "Menlo" : "monospace" }} />
      <Action kind="secondary" label={text("检查关键字段", "Check key fields")} onPress={state.checkCard} style={{ alignSelf: "flex-start" }} />
      {state.cardReport ? <View accessibilityLiveRegion="polite" style={{ gap: 10 }}>
        <Type weight="500" color={cardPassed ? colors.accent : colors.danger}>{text(cardPassed ? "关键字段检查通过" : "Card 内容需要修改", cardPassed ? "Key-field checks passed" : "Update the Card content")}</Type>
        <Issues issues={state.cardReport.issues} showFields />
        <Type size={12} muted>{text("尚未核对这份 JSON 是否为入口实际返回的内容。", "The pasted JSON has not been matched to the URL’s actual response.")}</Type>
      </View> : null}
    </Disclosure>
    {passed ? <Action kind="ghost" label={text("查看接入清单", "View handoff checklist")} icon={ListChecks} onPress={() => { resetCopy(); setShowChecklist(true); }} style={{ alignSelf: "flex-start" }} /> : null}
    <Sheet visible={showChecklist} title={text("交付给 Q 的接入清单", "Your Q handoff checklist")} onClose={() => setShowChecklist(false)}
      footer={<View accessibilityLiveRegion="polite" style={{ gap: 8 }}><Action icon={copiedValue === summary ? Check : Copy} label={copiedValue === summary ? text("已复制清单", "Checklist copied") : text("复制接入清单", "Copy checklist")} onPress={() => { void copy(summary); }} />{copyError ? <Type size={12} color={colors.danger}>{copyError}</Type> : null}</View>}>
      <Type selectable size={14}>{summary}</Type>
    </Sheet>
  </View>;
}

function useCopy() {
  const { text } = useDesign();
  const [copyError, setCopyError] = useState("");
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const resetCopy = () => { setCopyError(""); setCopiedValue(null); };
  useEffect(() => {
    if (copiedValue === null) return;
    const timer = setTimeout(() => setCopiedValue(null), 3500);
    return () => clearTimeout(timer);
  }, [copiedValue]);
  const copy = async (value: string) => {
    resetCopy();
    try {
      const ok = await Clipboard.setStringAsync(value);
      if (!ok) throw new Error("clipboard-unavailable");
      setCopiedValue(value);
    } catch {
      setCopyError(text("无法访问剪贴板。可以长按或选中文本手动复制。", "Clipboard unavailable. Select the text and copy it manually."));
    }
  };
  return { copy, copyError, copiedValue, resetCopy };
}

function Toggle({ label, detail, checked, onChange }: { label: string; detail: string; checked: boolean; onChange: () => void }) {
  const { colors } = useDesign();
  return <Pressable accessibilityRole="checkbox" accessibilityLabel={label} accessibilityHint={detail} accessibilityState={{ checked }} onPress={onChange}
    style={({ pressed }) => ({ flexDirection: "row", gap: 13, minHeight: 60, paddingVertical: 13, opacity: pressed ? 0.65 : 1 })}>
    <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: checked ? 0 : 1.5, borderColor: colors.faint, backgroundColor: checked ? colors.accent : "transparent", alignItems: "center", justifyContent: "center", marginTop: 2 }}>
      {checked ? <Check size={15} color={colors.onAccent} strokeWidth={2.3} /> : null}
    </View>
    <View style={{ flex: 1, gap: 4 }}><Type size={14} weight="500">{label}</Type><Type size={13} muted>{detail}</Type></View>
  </Pressable>;
}

function MaterialGenerator() {
  const { text, colors, phone, locale } = useDesign();
  const state = usePluginWorkbench();
  const [file, setFile] = useState("card");
  const [outputOpen, setOutputOpen] = useState(false);
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const { copy, copyError, copiedValue, resetCopy } = useCopy();
  const fields = ["title", "description", "ownerName", "name", "version"];
  const stepErrors = state.issues?.filter(issue => issue.level === "error" && (state.step === 0 ? fields.includes(issue.field) : state.step === 1 ? ["cardUrl", "endpointUrl"].includes(issue.field) : true)) ?? [];
  const field = (key: keyof Pick<PluginDraft, "title" | "description" | "ownerName" | "name" | "version" | "cardUrl" | "endpointUrl">, label: string, placeholder: string, hint?: string) => <View style={{ gap: 6 }}>
    <Input label={label} value={state.draft[key] ?? ""} onChangeText={value => state.updateDraft(key, value)} placeholder={placeholder}
      autoCapitalize="none" autoCorrect={false} keyboardType={key.endsWith("Url") ? "url" : "default"} maxLength={key === "ownerName" ? 160 : key === "description" || key === "title" ? 100 : key.endsWith("Url") ? 4096 : 255} hint={hint} />
    <Issues issues={stepErrors.filter(issue => issue.field === key)} />
  </View>;
  const advance = () => {
    const issues = state.validateDraft();
    const relevant = state.step === 0 ? fields : ["cardUrl", "endpointUrl"];
    if (issues.some(issue => issue.level === "error" && relevant.includes(issue.field))) {
      if (state.step === 0 && issues.some(issue => issue.level === "error" && ["name", "version"].includes(issue.field))) setTechnicalOpen(true);
      return;
    }
    state.setStep(state.step + 1);
  };
  const generate = () => {
    if (state.generate()) { resetCopy(); setFile("card"); setOutputOpen(true); }
  };
  const generated = state.materials;
  const fileItems = [
    { id: "card", label: "Server Card" },
    { id: "catalog", label: text("Catalog（按需）", "Catalog (optional)") },
    { id: "intro", label: text("介绍页（可选）", "Intro page (optional)") },
    { id: "checklist", label: text("接入清单", "Checklist") },
  ];
  const fileValue = generated ? file === "catalog" ? generated.catalog : file === "intro" ? generated.intro : file === "checklist" ? locale === "zh" ? generated.checklistZh : generated.checklistEn : generated.card : "";
  return <View style={{ gap: 22 }}>
    <SectionHeading title={text("生成接入材料", "Prepare your files")} detail={text("填写你的服务信息，得到可部署的文件示例与清单。MCP 服务仍需由你实现和运行。", "Use your service details to generate files and a checklist. You still need to implement and run the MCP service.")} icon={Code2} />
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {[text("插件信息", "Identity"), text("连接地址", "Addresses"), text("按需能力", "Options")].map((label, index) => <View key={label} style={{ flex: 1, gap: 8 }}>
        <View style={{ height: 3, borderRadius: 3, backgroundColor: index <= state.step ? colors.accent : colors.line }} />
        <Type size={12} weight={index === state.step ? "600" : "400"} muted={index !== state.step}>{index + 1}. {label}</Type>
      </View>)}
    </View>
    {state.step === 0 ? <>
      {field("title", text("插件名称 *", "Plugin name *"), text("例如：日程助手", "e.g. Calendar assistant"))}
      {field("description", text("能帮用户做什么 *", "What does it do? *"), text("查询日程并创建日历事件", "Find availability and create calendar events"), text("100 字符以内，不填写用户数据或密钥。", "Up to 100 characters. No user data or secrets."))}
      {field("ownerName", text("所有者（可选）", "Owner (optional)"), text("个人、团队或品牌名称", "Person, team, or brand"), text("最多 80 个字符。会向用户展示为发布者自声明，不代表小Q认证或账号权限。", "Up to 80 characters. Shown as a publisher declaration, not Q verification or account authorization."))}
      <Disclosure title={text("服务标识与版本", "Server identity and version")} open={technicalOpen} onToggle={() => setTechnicalOpen(value => !value)}>
        {field("name", text("服务标识 *", "Server name *"), "com.example/calendar", text("使用你控制的域名命名空间 / 服务名。它不代替 Card URL 作为连接身份。", "Use your domain namespace / server name. Connection identity still comes from the Card URL."))}
        {field("version", text("服务版本 *", "Service version *"), "1.0.0")}
      </Disclosure>
      <Action kind="ghost" label={text("填入日程插件示例", "Fill calendar example")} onPress={state.useExample} style={{ alignSelf: "flex-start" }} />
    </> : state.step === 1 ? <>
      {field("cardUrl", text("Server Card 发布地址", "Server Card URL"), "https://your-domain.com/server-card.json", text("在该地址发布生成的 Card JSON，每个插件保持独立稳定。", "Publish the generated Card JSON here. Keep this URL stable and unique to the plugin."))}
      {field("endpointUrl", text("MCP 服务地址", "MCP endpoint URL"), "https://your-domain.com/mcp", text("实际运行 MCP 的 HTTPS Streamable HTTP 端点，不是网页地址。", "The running HTTPS Streamable HTTP endpoint, not a regular web page."))}
      <View style={{ gap: 8, padding: 16, backgroundColor: colors.soft, borderRadius: 12 }}>
        <Type size={13} weight="500">{text("两个地址，各有用途", "Two URLs, two purposes")}</Type>
        <Type size={13} muted>{text("Card 告诉 Q 如何连接；MCP 端点才执行能力。生成文件不会替你部署服务器。", "The Card tells Q how to connect; the MCP endpoint provides the capabilities. Generating files does not deploy your server.")}</Type>
      </View>
    </> : <View>
      <Type size={13} muted>{text("只选择你的服务实际需要的能力。", "Choose only what your service actually needs.")}</Type>
      <Toggle label={text("需要访问用户账户", "Needs user account access")} detail={text("准备 MCP 授权、Protected Resource Metadata 与双方 CIMD 支持，不在这里填写密钥。", "Provide MCP authorization, Protected Resource Metadata, and CIMD on both sides. No secrets go here.")} checked={state.draft.needsAuth} onChange={() => state.updateDraft("needsAuth", !state.draft.needsAuth)} />
      <Divider />
      <Toggle label={text("提供对话内交互界面", "Provides an in-chat UI")} detail={text("准备 MCP Apps 资源和文本降级。只有文本结果的工具无需此项。", "Provide MCP Apps resources and text fallback. Text-only tools do not need this.")} checked={state.draft.hasUi} onChange={() => state.updateDraft("hasUi", !state.draft.hasUi)} />
      <Divider />
      <Toggle label={text("在 Card 所在域名开启发现", "Enable discovery on the Card’s domain")} detail={text("此示例在 Card 同域发布根 /.well-known/ai-catalog.json。Card 也可由第三方托管，实际 Catalog 可另放你控制的发现域名。", "This example puts /.well-known/ai-catalog.json on the Card’s origin. Third-party Cards are supported; your real catalog may live on a different domain you control.")} checked={state.draft.domainDiscovery} onChange={() => state.updateDraft("domainDiscovery", !state.draft.domainDiscovery)} />
      <Divider />
      <Toggle label={text("希望进入公共插件目录", "Prepare for a public listing")} detail={text("在你自己的公开 Catalog 声明插件，允许匿名抓取；仅准备材料，不会立即公开。", "List the plugin in your own public Catalog and allow anonymous crawling. This only prepares materials; it does not publish a listing.")} checked={state.draft.publicListing} onChange={() => state.updateDraft("publicListing", !state.draft.publicListing)} />
      <Issues issues={state.issues ?? []} />
    </View>}
    {stepErrors.length ? <Type size={13} color={colors.danger}>{text("请修改上方标出的字段后继续。", "Update the highlighted fields to continue.")}</Type> : null}
    <View style={{ flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
      {state.step > 0 ? <Action kind="ghost" icon={ArrowLeft} label={text("上一步", "Back")} onPress={() => state.setStep(state.step - 1)} /> : <View />}
      <Action icon={state.step === 2 ? FileJson2 : ArrowRight} label={state.step === 2 ? text("生成文件与清单", "Generate files & checklist") : text("下一步", "Continue")} onPress={state.step === 2 ? generate : advance} />
    </View>
    {generated ? <View style={{ gap: 12 }}><Divider /><Action kind="secondary" label={text("查看已生成材料", "View generated files")} icon={FileJson2} onPress={() => { resetCopy(); setOutputOpen(true); }} /></View> : null}
    <Type size={12} muted>{text("草稿仅在本次会话保留，刷新后清空。生成结果不代表已经部署、授权或接入。", "Drafts last for this session and reset on refresh. Generated files are not proof of deployment, authorization, or connection.")}</Type>
    <Sheet visible={outputOpen && !!generated} title={text("接入材料已生成", "Your files are ready")} onClose={() => setOutputOpen(false)} wide
      footer={<View accessibilityLiveRegion="polite" style={{ gap: 8, flexShrink: 0 }}><View style={{ flexDirection: phone ? "column" : "row", gap: 10, flexShrink: 0, minHeight: phone ? 102 : 46 }}>
        <Action icon={copiedValue === fileValue ? Check : Copy} label={copiedValue === fileValue ? text("已复制内容", "Content copied") : text("复制当前内容", "Copy current file")} onPress={() => { void copy(fileValue); }} style={phone ? { width: "100%", minHeight: 46, flexShrink: 0 } : { flex: 1, minHeight: 46 }} />
        <Action kind="secondary" label={text("用此链接继续", "Continue with this link")} onPress={() => { state.useGeneratedCard(); setOutputOpen(false); }} style={phone ? { width: "100%", minHeight: 46, flexShrink: 0 } : { flex: 1, minHeight: 46 }} />
      </View>{copyError ? <Type size={12} color={colors.danger}>{copyError}</Type> : null}</View>}>
      <Tag>{text("本地生成 · 尚未部署", "Generated locally · not deployed")}</Tag>
      <Tabs items={fileItems} value={file} onChange={value => { resetCopy(); setFile(value); }} />
      {file === "card" ? <View style={{ gap: 8 }}>
        <Type size={13} muted>{text("发布到你的 Card 地址，响应类型：", "Publish at your Card URL with content type:")}</Type>
        <Type selectable size={12} mono>application/mcp-server-card+json</Type>
        <Type selectable size={12} color={colors.accent}>{state.draft.cardUrl}</Type>
      </View> : file === "catalog" ? <Type size={13} muted>{text(state.draft.domainDiscovery ? "发布到域名根目录 /.well-known/ai-catalog.json，响应类型 application/ai-catalog+json。" : "发布到你控制的公开地址，响应类型 application/ai-catalog+json；与介绍页声明保持一致。", state.draft.domainDiscovery ? "Publish at /.well-known/ai-catalog.json with content type application/ai-catalog+json." : "Publish at a public URL you control with content type application/ai-catalog+json; match the intro page declaration.")}</Type> : file === "intro" ? <Type size={13} muted>{text("可选的静态介绍页示例。请同时发布所声明的 Catalog，修改内容后再部署。", "Optional static intro page. Publish the declared Catalog and customize the content before deploying.")}</Type> : null}
      <ScrollView horizontal contentContainerStyle={{ minWidth: "100%" }}>
        <View style={{ padding: 16, borderRadius: 10, backgroundColor: colors.soft }}><Type selectable mono={file !== "checklist"} size={file === "checklist" ? 13 : 12} style={{ maxWidth: file === "checklist" ? 580 : undefined }}>{fileValue}</Type></View>
      </ScrollView>
      <Type size={12} muted>{text("按选定版本完成 schema 校验与真实联调后，再确认服务可用。", "Validate the chosen schema and complete real integration tests before treating the service as usable.")}</Type>
    </Sheet>
  </View>;
}

export function PluginWorkbenchPage({ onBack, onConnect }: { onBack: () => void; onConnect: (intent: PluginEntryIntent) => void }) {
  const { text, width, notify } = useDesign();
  const state = usePluginWorkbench();
  const [publicInfo, setPublicInfo] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const wide = width >= 1240;
  return <KeyboardAvoidingView behavior={process.env.EXPO_OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
    <Page title={text("插件工作台", "Plugin workbench")} description={text("连接已有服务，或为自己的插件准备发布材料。", "Connect an existing service or prepare your own plugin’s publishing materials.")}
      action={<Action kind="ghost" icon={ArrowLeft} label={text("返回插件", "Back to plugins")} onPress={onBack} />}>
      <Tabs items={[{ id: "connect", label: text("连接插件", "Connect a plugin") }, { id: "prepare", label: text("准备发布", "Prepare to publish") }]} value={state.tab} onChange={state.setTab} />
      {state.tab === "prepare" ? <Type size={13} muted>{text("这里生成文件与清单，不会替你部署、认证或公开上架。", "This creates files and a checklist; it does not deploy, verify, or publicly list your plugin.")}</Type> : null}
      <View style={{ flexDirection: wide ? "row" : "column", gap: wide ? 42 : 32, alignItems: "flex-start" }}>
        <View style={{ flex: wide ? 1 : undefined, width: wide ? undefined : "100%", minWidth: 0 }}>
          {state.tab === "connect" ? <ConnectionChecks onConnect={onConnect} /> : <MaterialGenerator />}
        </View>
        <View style={{ width: wide ? 285 : "100%" }}><Disclosure title={text("开发者说明", "Developer guide")} open={guideOpen} onToggle={() => setGuideOpen(value => !value)}><PreparationGuide /></Disclosure></View>
      </View>
      <View>
        <Divider />
        <Disclosure title={text("接入使用和公共收录有什么区别？", "How is connecting different from public listing?")} open={publicInfo} onToggle={() => setPublicInfo(value => !value)}>
          <Type size={14} muted>{text("用户确认添加并完成所需授权后，可以建立自己的连接。是否被公共目录收录，不是连接与调用的前提。", "A user can establish a personal connection after confirming the service and granting any required access. Public listing is not a prerequisite for connection or calls.")}</Type>
          <Type size={14} muted>{text("公共索引需要发布者自己的公开 Catalog 声明、来源验证和匿名抓取，并遵守 robots.txt 与 noindex。私有目录、账户信息、工具结果和 UI 数据不会因此进入公共库。", "Public indexing requires the publisher’s own public Catalog, verified origins, and anonymous crawling that respects robots.txt and noindex. Private catalogs, accounts, results, and UI data do not belong in the public index.")}</Type>
        </Disclosure>
        <Action kind="ghost" label={text("查看完整接入规范", "Read the integration specification")} icon={Code2} onPress={() => { void Linking.openURL(DOC_URL).catch(() => notify(text("暂时无法打开规范链接。", "Unable to open the specification."))); }} style={{ alignSelf: "flex-start" }} />
      </View>
    </Page>
  </KeyboardAvoidingView>;
}
