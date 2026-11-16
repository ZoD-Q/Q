import { useState } from "react";
import { Pressable, View } from "react-native";
import {
  ArrowRight,
  Bookmark,
  Check,
  Code2,
  Puzzle,
  Search,
  SlidersHorizontal,
} from "lucide-react-native";
import {
  Action,
  Choice,
  Divider,
  Input,
  Page,
  Sheet,
  Tabs,
  Tag,
  Type,
  useDesign,
} from "../design";
import { pluginCatalog } from "../data/plugin-catalog";

type Plugin = (typeof pluginCatalog)[number];
export function PluginsPage({ onOpenWorkbench }: { onOpenWorkbench: () => void }) {
  const { colors, text, phone, notify } = useDesign();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("*");
  const [saved, setSaved] = useState<string[]>([]);
  const [onlySaved, setOnlySaved] = useState(false);
  const [selected, setSelected] = useState<Plugin | null>(null);
  const [limit, setLimit] = useState(18);
  const [filterOpen, setFilterOpen] = useState(false);
  const groups = [
    ...new Set(pluginCatalog.map((item) => item.category)),
  ].sort();
  const catalog = pluginCatalog.filter(
    (item) => item.name || item.category || item.description,
  );
  const visible = catalog.filter(
    (item) =>
      (category === "*" || item.category === category) &&
      (!onlySaved || saved.includes(item.id)) &&
      `${item.name} ${item.description}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const name = (item: Plugin) =>
    item.name || text("未命名创意", "Untitled idea");
  const toggle = (item: Plugin) => {
    const has = saved.includes(item.id);
    setSaved((values) =>
      has ? values.filter((id) => id !== item.id) : [...values, item.id],
    );
    notify(
      text(has ? "已移出收藏" : "已收藏", has ? "Removed from saved" : "Saved"),
    );
  };
  return (
    <Page
      title={text("创意目录参考", "Idea catalog reference")}
      description={text(
        "以下是原表中的创意，并非已接通的服务。真实连接请到“我的连接”添加服务方链接。",
        "These source ideas are not connected services. Add a publisher URL under My connections to use a live service.",
      )}
      action={<Action kind="secondary" icon={Code2} label={text("接入我的插件", "Connect my plugin")} onPress={onOpenWorkbench} />}
    >
      <View style={{ gap: 14 }}>
        <Input
          label={text("搜索创意", "Search ideas")}
          placeholder={text("名称或简介", "Name or description")}
          value={query}
          onChangeText={(value) => {
            setQuery(value);
            setLimit(18);
          }}
        />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
          <View style={{ flex: 1 }}>
            <Tabs
              items={[
                { id: "all", label: text("全部", "All") },
                {
                  id: "saved",
                  label: text(`收藏 ${saved.length}`, `Saved ${saved.length}`),
                },
              ]}
              value={onlySaved ? "saved" : "all"}
              onChange={(value) => {
                setOnlySaved(value === "saved");
                setLimit(18);
              }}
            />
          </View>
          <Action
            kind="ghost"
            icon={SlidersHorizontal}
            label={
              category === "*"
                ? text("筛选", "Filter")
                : category || text("未分组", "Ungrouped")
            }
            onPress={() => setFilterOpen(true)}
          />
        </View>
        <Type size={13} muted>
          {text(`${visible.length} 条创意参考`, `${visible.length} reference ideas`)}
        </Type>
        <Type size={12} muted>{text(`原表另有${pluginCatalog.length - catalog.length}条空占位，未作为服务展示；讨论组保留原始含义。`, `The source also has ${pluginCatalog.length - catalog.length} empty placeholders, not services. Discussion groups keep their original meaning.`)}</Type>
      </View>
      <View>
        {visible.slice(0, limit).map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            accessibilityLabel={name(item)}
            onPress={() => setSelected(item)}
            style={({ pressed }) => ({
              minHeight: 76,
              paddingVertical: 17,
              borderTopWidth: 1,
              borderColor: colors.line,
              flexDirection: "row",
              alignItems: "center",
              gap: 14,
              opacity: pressed ? 0.65 : 1,
            })}
          >
            <Puzzle size={20} strokeWidth={1.4} color={colors.muted} />
            <View style={{ flex: 1, gap: 4 }}>
              <View
                style={{ flexDirection: "row", gap: 9, alignItems: "center" }}
              >
                <Type
                  size={phone ? 16 : 15}
                  weight="500"
                  numberOfLines={1}
                  style={{ flexShrink: 1 }}
                >
                  {name(item)}
                </Type>
                {saved.includes(item.id) ? (
                  <Check size={15} color={colors.muted} />
                ) : null}
              </View>
              <Type size={12} muted>{text("创意参考 · 尚未接通", "Reference idea · Not connected")}</Type>
              <Type size={14} muted numberOfLines={1}>
                {item.description ||
                  text("简介待补充", "Description coming soon")}
              </Type>
            </View>
            <ArrowRight size={16} color={colors.faint} />
          </Pressable>
        ))}
      </View>
      {!visible.length ? (
        <View style={{ paddingVertical: 35, gap: 12, alignItems: "center" }}>
          <Search size={27} color={colors.faint} />
          <Type muted>
            {text("暂时没有匹配的创意。", "No matching ideas yet.")}
          </Type>
          <Action
            kind="ghost"
            label={text("清除筛选", "Clear filters")}
            onPress={() => {
              setQuery("");
              setCategory("*");
              setOnlySaved(false);
            }}
          />
        </View>
      ) : visible.length > limit ? (
        <Action
          kind="secondary"
          label={text("查看更多创意", "Show more ideas")}
          onPress={() => setLimit((value) => value + 18)}
          style={{ alignSelf: "center" }}
        />
      ) : null}
      <Sheet
        visible={filterOpen}
        title={text("筛选创意", "Filter ideas")}
        onClose={() => setFilterOpen(false)}
      >
        <Type size={14} muted>
          {text("分组", "Group")}
        </Type>
        <View style={{ gap: 9 }}>
          <Choice
            label={text("全部分组", "All groups")}
            selected={category === "*"}
            onPress={() => {
              setCategory("*");
              setLimit(18);
            }}
          />
          {groups.map((group) => (
            <Choice
              key={group || "ungrouped"}
              label={group || text("未分组", "Ungrouped")}
              selected={category === group}
              onPress={() => {
                setCategory(group);
                setLimit(18);
              }}
            />
          ))}
        </View>
        <Action
          label={text("查看结果", "Show results")}
          onPress={() => setFilterOpen(false)}
        />
      </Sheet>
      <Sheet
        visible={!!selected}
        title={text("创意详情", "Idea details")}
        onClose={() => setSelected(null)}
      >
        {selected ? (
          <>
            <Tag>{selected.category || text("未分组", "Ungrouped")}</Tag>
            <Type size={13} muted>{text("尚未接通：此条仅为原表创意，不代表可调用的插件。", "Not connected: this is a source idea, not an available plugin.")}</Type>
            <Type serif size={29}>
              {name(selected)}
            </Type>
            <Type size={16} selectable>
              {selected.description ||
                text("简介待补充", "Description coming soon")}
            </Type>
            <Divider />
            <Type size={13} muted>
              {text(
                "收藏仅保存在当前预览中。",
                "Saved items are kept only in this preview.",
              )}
            </Type>
            {saved.includes(selected.id) ? (
              <View accessibilityLiveRegion="polite">
                <Type size={14} color={colors.green}>
                  {text("已收藏", "Saved")}
                </Type>
              </View>
            ) : null}
            <Action
              icon={Bookmark}
              label={
                saved.includes(selected.id)
                  ? text("移出收藏", "Remove from saved")
                  : text("加入我的收藏", "Save to my collection")
              }
              onPress={() => toggle(selected)}
            />
          </>
        ) : null}
      </Sheet>
    </Page>
  );
}
