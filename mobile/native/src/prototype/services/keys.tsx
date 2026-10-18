import { useState } from "react";
import { Pressable, View } from "react-native";
import {
  Check,
  ChevronDown,
  ChevronRight,
  KeyRound,
  Plus,
} from "lucide-react-native";
import {
  Action,
  Choice,
  Divider,
  Input,
  Page,
  Row,
  Sheet,
  Tag,
  Type,
  useDesign,
} from "../design";

type Scope = "read" | "write";
type PreviewKey = {
  id: string;
  name: string;
  nameEn?: string;
  masked: string;
  scopes: Scope[];
  project: string;
  environment: string;
  used: boolean;
};
const initialKeys: PreviewKey[] = [
  {
    id: "sample-reader",
    name: "灵感工作室",
    nameEn: "Inspiration studio",
    masked: "q_preview_••••_8f2a",
    scopes: ["read"],
    project: "personal",
    environment: "sandbox",
    used: true,
  },
  {
    id: "sample-builder",
    name: "我的第一个应用",
    nameEn: "My first app",
    masked: "q_preview_••••_3c91",
    scopes: ["read", "write"],
    project: "personal",
    environment: "sandbox",
    used: false,
  },
];
const snippet =
  'curl https://example.invalid/v1/plugins -H "Authorization: Bearer YOUR_API_KEY"';

export function KeysPage() {
  const { colors, phone, text } = useDesign();
  const [project, setProject] = useState("personal");
  const [environment, setEnvironment] = useState("sandbox");
  const [keys, setKeys] = useState(initialKeys);
  const [selected, setSelected] = useState<PreviewKey | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(["read"]);
  const [generated, setGenerated] = useState("");
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const visibleKeys = keys.filter(
    (key) => key.project === project && key.environment === environment,
  );
  const scopeName = (scope: Scope) =>
    scope === "read" ? text("读取", "Read") : text("写入", "Write");
  const keyName = (key: PreviewKey) =>
    key.nameEn ? text(key.name, key.nameEn) : key.name;
  const projectName = (value: string) =>
    value === "personal"
      ? text("个人项目", "Personal project")
      : text("新应用", "New application");
  const environmentName = (value: string) =>
    value === "sandbox"
      ? text("开发环境", "Development")
      : text("生产环境预览", "Production preview");
  const openCreate = () => {
    setName("");
    setScopes(["read"]);
    setGenerated("");
    setCreating(true);
  };
  const toggleScope = (scope: Scope) =>
    setScopes((current) =>
      current.includes(scope)
        ? current.filter((value) => value !== scope)
        : [...current, scope],
    );
  const generate = () => {
    if (!name.trim() || scopes.length === 0) return;
    const suffix = Date.now().toString(36);
    setGenerated(`q_preview_not_a_real_key_${suffix}`);
    setKeys((current) => [
      ...current,
      {
        id: suffix,
        name: name.trim(),
        masked: `q_preview_••••_${suffix.slice(-4)}`,
        scopes: [...scopes],
        project,
        environment,
        used: false,
      },
    ]);
  };
  return (
    <>
      <Page
        title={text("API 密钥", "API keys")}
        description={text(
          "示例密钥，无调用权限。",
          "Example keys with no API access.",
        )}
        action={
          <Action
            label={text("创建密钥", "Create key")}
            icon={Plus}
            onPress={openCreate}
          />
        }
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={text(
            "选择项目和环境",
            "Choose project and environment",
          )}
          onPress={() => setWorkspaceOpen(true)}
          style={({ pressed }) => ({
            minHeight: 46,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 15,
            borderBottomWidth: 1,
            borderColor: colors.line,
            paddingBottom: 14,
            opacity: pressed ? 0.65 : 1,
          })}
        >
          <Type size={15} style={{ flex: 1 }}>
            {projectName(project)}{" "}
            <Type size={14} muted>
              {" "}
              / {environmentName(environment)}
            </Type>
          </Type>
          <ChevronDown size={16} color={colors.muted} />
        </Pressable>
        <View>
          {visibleKeys.length ? (
            visibleKeys.map((key) => (
              <Pressable
                key={key.id}
                accessibilityRole="button"
                accessibilityLabel={text(
                  `查看 ${keyName(key)}`,
                  `View ${keyName(key)}`,
                )}
                onPress={() => setSelected(key)}
                style={({ pressed }) => ({
                  minHeight: 85,
                  paddingVertical: 20,
                  borderBottomWidth: 1,
                  borderColor: colors.line,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 14,
                  opacity: pressed ? 0.65 : 1,
                })}
              >
                <KeyRound size={19} strokeWidth={1.4} color={colors.muted} />
                <View style={{ flex: 1, gap: 5 }}>
                  <Type size={phone ? 16 : 15} weight="500">
                    {keyName(key)}
                  </Type>
                  <Type size={13} mono muted numberOfLines={1}>
                    {key.masked}
                  </Type>
                </View>
                <ChevronRight size={16} color={colors.faint} />
              </Pressable>
            ))
          ) : (
            <View style={{ paddingVertical: 25, gap: 8 }}>
              <Type size={16}>{text("暂无密钥", "No keys yet")}</Type>
              <Type size={14} muted>
                {text(
                  "可为当前项目创建一枚预览密钥。",
                  "Create a preview key for this project.",
                )}
              </Type>
            </View>
          )}
        </View>
        <View>
          <Row
            title={text("接入说明", "Integration guide")}
            onPress={() => setGuideOpen((value) => !value)}
            right={
              <ChevronDown
                size={16}
                color={colors.muted}
                style={{
                  transform: [{ rotate: guideOpen ? "180deg" : "0deg" }],
                }}
              />
            }
            last
          />
          {guideOpen ? (
            <View style={{ gap: 16, paddingBottom: 15 }}>
              <View>
                <Row
                  title={text("本月实际请求", "Real requests this month")}
                  right={<Type mono>0</Type>}
                />
                <Row
                  title={text("调用服务", "API service")}
                  right={
                    <Type size={14} muted>
                      {text("未接入", "Not connected")}
                    </Type>
                  }
                  last
                />
              </View>
              <Type size={14} muted>
                {text(
                  "以下为请求格式示例，地址为保留的无效域名。",
                  "Request format example using a reserved invalid domain.",
                )}
              </Type>
              <View
                style={{
                  padding: 16,
                  backgroundColor: colors.soft,
                  borderRadius: 9,
                }}
              >
                <Type size={13} mono selectable>
                  {snippet}
                </Type>
              </View>
              <Type size={13} muted>
                {text(
                  "真实密钥应保存在服务端。当前预览数据刷新后不保留。",
                  "Keep real keys on your server. Preview data is not retained after refresh.",
                )}
              </Type>
            </View>
          ) : null}
        </View>
      </Page>
      <Sheet
        visible={workspaceOpen}
        title={text("项目和环境", "Project and environment")}
        onClose={() => setWorkspaceOpen(false)}
      >
        <View style={{ gap: 11 }}>
          <Type size={14} weight="500">
            {text("项目", "Project")}
          </Type>
          {["personal", "new"].map((value) => (
            <Choice
              key={value}
              label={projectName(value)}
              selected={project === value}
              onPress={() => setProject(value)}
            />
          ))}
        </View>
        <Divider />
        <View style={{ gap: 11 }}>
          <Type size={14} weight="500">
            {text("环境", "Environment")}
          </Type>
          {["sandbox", "production"].map((value) => (
            <Choice
              key={value}
              label={environmentName(value)}
              selected={environment === value}
              onPress={() => setEnvironment(value)}
            />
          ))}
        </View>
        <Action
          label={text("完成", "Done")}
          onPress={() => setWorkspaceOpen(false)}
        />
      </Sheet>
      <Sheet
        visible={!!selected}
        title={text("密钥详情", "Key details")}
        onClose={() => setSelected(null)}
      >
        {selected ? (
          <>
            <Tag>
              {text("示例密钥 · 无调用权限", "Example key · no API access")}
            </Tag>
            <Type size={20} weight="500">
              {keyName(selected)}
            </Type>
            <Type mono size={14} selectable>
              {selected.masked}
            </Type>
            <View>
              <Row
                title={text("项目", "Project")}
                right={<Type size={13}>{projectName(selected.project)}</Type>}
              />
              <Row
                title={text("环境", "Environment")}
                right={
                  <Type size={13}>{environmentName(selected.environment)}</Type>
                }
              />
              <Row
                title={text("能力范围", "Scopes")}
                right={
                  <Type size={13}>
                    {selected.scopes.map(scopeName).join(" · ")}
                  </Type>
                }
              />
              <Row
                title={text("最后使用", "Last used")}
                right={
                  <Type size={13}>
                    {selected.used
                      ? text("今天 09:41 · 示例", "Today 09:41 · sample")
                      : text("尚未使用", "Never")}
                  </Type>
                }
                last
              />
            </View>
            <Action
              label={text("关闭详情", "Close details")}
              kind="secondary"
              onPress={() => setSelected(null)}
            />
          </>
        ) : null}
      </Sheet>
      <Sheet
        visible={creating}
        title={
          generated
            ? text("预览密钥已生成", "Preview key generated")
            : text("创建密钥", "Create a key")
        }
        onClose={() => setCreating(false)}
      >
        <Tag>{text("仅界面预览", "UI preview only")}</Tag>
        {generated ? (
          <>
            <Type>
              {text(
                "这是一段示例文本，没有任何调用权限。",
                "This is example text. It grants no API access.",
              )}
            </Type>
            <View
              style={{
                padding: 16,
                borderRadius: 10,
                backgroundColor: colors.soft,
              }}
            >
              <Type mono size={13} selectable>
                {generated}
              </Type>
            </View>
            <Type size={12} muted>
              {text(
                "可长按或选择文本。没有创建真实凭据，也不会收取费用。",
                "Long-press or select the text. No real credential was created and there are no charges.",
              )}
            </Type>
            <Action
              label={text("完成", "Done")}
              onPress={() => setCreating(false)}
            />
          </>
        ) : (
          <>
            <Type size={13} muted>
              {projectName(project)} · {environmentName(environment)}
            </Type>
            <Input
              label={text("密钥名称", "Key name")}
              value={name}
              onChangeText={setName}
              maxLength={48}
              placeholder={text(
                "例如：我的灵感助手",
                "For example: My inspiration assistant",
              )}
            />
            <View style={{ gap: 10 }}>
              <Type size={13} weight="500">
                {text("能力范围", "Access scopes")}
              </Type>
              {(["read", "write"] as const).map((scope) => (
                <Pressable
                  key={scope}
                  accessibilityRole="checkbox"
                  accessibilityLabel={scopeName(scope)}
                  accessibilityState={{ checked: scopes.includes(scope) }}
                  onPress={() => toggleScope(scope)}
                  style={({ pressed }) => ({
                    minHeight: 54,
                    flexDirection: "row",
                    gap: 12,
                    alignItems: "center",
                    borderBottomWidth: 1,
                    borderBottomColor: colors.line,
                    opacity: pressed ? 0.65 : 1,
                  })}
                >
                  <View
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 5,
                      borderWidth: 1,
                      borderColor: scopes.includes(scope)
                        ? colors.ink
                        : colors.line,
                      backgroundColor: scopes.includes(scope)
                        ? colors.ink
                        : colors.surface,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {scopes.includes(scope) ? (
                      <Check size={14} color={colors.bg} />
                    ) : null}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Type size={14}>{scopeName(scope)}</Type>
                    <Type size={12} muted>
                      {scope === "read"
                        ? text(
                            "查看项目和插件信息",
                            "View project and plugin information",
                          )
                        : text("修改项目内容", "Update project content")}
                    </Type>
                  </View>
                </Pressable>
              ))}
            </View>
            <Type size={12} muted>
              {text(
                "所选能力仅用于展示，不会授予真实访问权限。",
                "Selected scopes are for display and grant no real access.",
              )}
            </Type>
            <Action
              label={text("生成预览密钥", "Generate preview key")}
              onPress={generate}
              disabled={!name.trim() || scopes.length === 0}
            />
          </>
        )}
      </Sheet>
    </>
  );
}
