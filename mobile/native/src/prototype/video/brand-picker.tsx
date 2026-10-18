import { memo, useMemo, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check, Search, X } from "lucide-react-native";
import { Action, IconAction, Type, useDesign } from "../design";
import { brands, popularBrandIds, type Brand } from "./data/brands";
import { MAX_ADS } from "./pricing";

const BrandRow = memo(function BrandRow({
  brand,
  selected,
  limit,
  onPress,
}: {
  brand: Brand;
  selected: boolean;
  limit: boolean;
  onPress: () => void;
}) {
  const { colors } = useDesign();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={brand.name}
      accessibilityState={{ checked: selected, disabled: limit && !selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 65,
        paddingVertical: 12,
        paddingHorizontal: 22,
        flexDirection: "row",
        alignItems: "center",
        gap: 13,
        backgroundColor: pressed ? colors.soft : "transparent",
        opacity: limit && !selected ? 0.55 : 1,
      })}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          backgroundColor: colors.soft,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Type size={15} weight="500" muted>
          {Array.from(brand.name)[0]}
        </Type>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Type size={15} weight="500" numberOfLines={1}>
          {brand.name}
        </Type>
        {brand.aliases?.[0] ? (
          <Type size={12} muted numberOfLines={1}>
            {brand.aliases[0]}
          </Type>
        ) : null}
      </View>
      <View
        style={{
          width: 23,
          height: 23,
          borderRadius: 12,
          borderWidth: selected ? 0 : 1,
          borderColor: colors.line,
          backgroundColor: selected ? colors.accent : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {selected ? <Check size={14} color={colors.onAccent} /> : null}
      </View>
    </Pressable>
  );
});
export function BrandPicker({
  visible,
  selected,
  onChange,
  onClose,
}: {
  visible: boolean;
  selected: string[];
  onChange: (ids: string[]) => void;
  onClose: () => void;
}) {
  const { colors, text, phone } = useDesign();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"all" | "popular" | "selected">("all");
  const [notice, setNotice] = useState(false);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const filtered = useMemo(
    () =>
      brands.filter(
        (brand) =>
          (tab !== "popular" || popularBrandIds.includes(brand.id)) &&
          (tab !== "selected" || selectedSet.has(brand.id)) &&
          [brand.name, ...(brand.aliases ?? [])]
            .join(" ")
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ),
    [query, tab, selectedSet],
  );
  const toggle = (brand: Brand) => {
    if (selectedSet.has(brand.id)) {
      onChange(selected.filter((id) => id !== brand.id));
      setNotice(false);
    } else if (selected.length < MAX_ADS) {
      onChange([...selected, brand.id]);
      setNotice(false);
    } else setNotice(true);
  };
  return (
    <Modal
      transparent
      visible={visible}
      animationType={process.env.EXPO_OS === "web" ? "none" : "slide"}
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={process.env.EXPO_OS === "ios" ? "padding" : undefined}
        style={{
          flex: 1,
          backgroundColor: "#172B3A30",
          justifyContent: phone ? "flex-end" : "center",
          alignItems: "center",
          paddingTop: insets.top + 12,
          paddingHorizontal: phone ? 0 : 30,
          paddingBottom: phone ? 0 : 24,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={text("关闭品牌选择", "Close brands")}
          onPress={onClose}
          style={{ position: "absolute", inset: 0 }}
        />
        <View
          accessibilityViewIsModal
          style={{
            height: phone ? "94%" : "88%",
            width: "100%",
            maxWidth: 600,
            backgroundColor: colors.bg,
            borderRadius: 25,
            paddingBottom: insets.bottom,
            overflow: "hidden",
          }}
        >
          <View style={{ padding: 22, paddingBottom: 12, gap: 15 }}>
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <View style={{ gap: 3 }}>
                <Type size={22} weight="600">
                  {text("选择品牌", "Choose brands")}
                </Type>
                <Type size={13} muted>
                  {text(
                    "每个省 5%，最多选 10 个",
                    "Save 5% each. Choose up to 10.",
                  )}
                </Type>
              </View>
              <IconAction
                label={text("关闭", "Close")}
                icon={X}
                onPress={onClose}
              />
            </View>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                backgroundColor: colors.soft,
                borderRadius: 12,
                paddingHorizontal: 13,
              }}
            >
              <Search size={17} color={colors.muted} />
              <TextInput
                accessibilityLabel={text(
                  "搜索1000个品牌",
                  "Search 1,000 brands",
                )}
                placeholder={text("搜索品牌名称", "Search brands")}
                value={query}
                onChangeText={setQuery}
                placeholderTextColor={colors.faint}
                style={{
                  flex: 1,
                  minHeight: 46,
                  fontSize: 15,
                  color: colors.ink,
                  paddingVertical: 10,
                }}
              />
              {query ? (
                <IconAction
                  icon={X}
                  label={text("清除搜索", "Clear search")}
                  onPress={() => setQuery("")}
                />
              ) : null}
            </View>
            <View style={{ flexDirection: "row", gap: 20 }}>
              {(
                [
                  { id: "all", label: text("全部 1,000", "All 1,000") },
                  { id: "popular", label: text("常见品牌", "Popular") },
                  {
                    id: "selected",
                    label: text(
                      `已选 ${selected.length}`,
                      `Selected ${selected.length}`,
                    ),
                  },
                ] as const
              ).map((item) => (
                <Pressable
                  key={item.id}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: tab === item.id }}
                  onPress={() => setTab(item.id)}
                  style={{
                    minHeight: 42,
                    paddingVertical: 10,
                    borderBottomWidth: 2,
                    borderColor:
                      tab === item.id ? colors.accent : "transparent",
                  }}
                >
                  <Type
                    size={14}
                    color={tab === item.id ? colors.accent : colors.muted}
                    weight={tab === item.id ? "600" : "400"}
                  >
                    {item.label}
                  </Type>
                </Pressable>
              ))}
            </View>
          </View>
          <FlatList
            data={filtered}
            keyExtractor={(item) => item.id}
            extraData={selected}
            keyboardShouldPersistTaps="handled"
            initialNumToRender={16}
            maxToRenderPerBatch={16}
            windowSize={5}
            renderItem={({ item }) => (
              <BrandRow
                brand={item}
                selected={selectedSet.has(item.id)}
                limit={selected.length >= MAX_ADS}
                onPress={() => toggle(item)}
              />
            )}
            ListEmptyComponent={
              <View style={{ padding: 35, alignItems: "center", gap: 10 }}>
                <Type muted>
                  {tab === "selected" && selected.length === 0
                    ? text("还没选品牌", "No brands selected")
                    : text("没有找到这个品牌", "No brand found")}
                </Type>
                {query ? (
                  <Action
                    kind="ghost"
                    label={text("清空搜索", "Clear search")}
                    onPress={() => setQuery("")}
                  />
                ) : null}
              </View>
            }
          />
          <View
            style={{
              paddingHorizontal: 22,
              paddingTop: 14,
              paddingBottom: 16,
              borderTopWidth: 1,
              borderColor: colors.line,
              gap: 11,
            }}
          >
            {notice ? (
              <Type size={13} color={colors.danger}>
                {text(
                  "已达到10个上限，取消一个后可更换。",
                  "Limit reached. Remove a brand to select another.",
                )}
              </Type>
            ) : null}
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <Type size={14}>
                {text(
                  `已选 ${selected.length}/10`,
                  `${selected.length}/10 selected`,
                )}{" "}
                <Type color={colors.accent} weight="600">
                  {text(
                    `省 ${selected.length * 5}%`,
                    `Save ${selected.length * 5}%`,
                  )}
                </Type>
              </Type>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={text("清空选择", "Clear selection")}
                onPress={() => {
                  onChange([]);
                  setNotice(false);
                }}
                style={{
                  minHeight: 44,
                  justifyContent: "center",
                  paddingHorizontal: 7,
                }}
              >
                <Type size={13} muted>
                  {text("清空", "Clear")}
                </Type>
              </Pressable>
            </View>
            <Action label={text("完成选择", "Done")} onPress={onClose} />
            <Type size={11} muted style={{ textAlign: "center" }}>
              {text(
                "品牌目录示例，尚无广告合作或真实优惠。",
                "Brand catalog preview. No ad partnerships or real discounts.",
              )}
            </Type>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
