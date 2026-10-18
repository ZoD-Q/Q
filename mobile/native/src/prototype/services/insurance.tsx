import { useState } from "react";
import { Pressable, View } from "react-native";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ShieldCheck,
} from "lucide-react-native";
import {
  Action,
  Choice,
  Divider,
  Page,
  Row,
  Sheet,
  Tabs,
  Type,
  useDesign,
} from "../design";

type Scene = "everyday" | "travel" | "home";
const scenes: { id: Scene; label: [string, string] }[] = [
  { id: "everyday", label: ["日常", "Everyday"] },
  { id: "travel", label: ["旅行", "Travel"] },
  { id: "home", label: ["居家", "Home"] },
];
const benefits: Record<Scene, [string, string][]> = {
  everyday: [
    ["意外身故 / 伤残", "Accidental death / disability"],
    ["意外医疗", "Accident medical expenses"],
    ["住院津贴", "Hospital allowance"],
  ],
  travel: [
    ["旅行意外", "Travel accidents"],
    ["紧急医疗", "Emergency medical care"],
    ["行程延误", "Travel delay"],
  ],
  home: [
    ["家庭财产", "Home contents"],
    ["家居责任", "Household liability"],
    ["应急维修", "Emergency repairs"],
  ],
};
const plans = [
  {
    id: "simple",
    label: ["轻享方案", "Essential"],
    subtitle: ["基本保障示例", "Basic coverage example"],
    price: "8",
    values: ["10", "1", "50"],
  },
  {
    id: "plus",
    label: ["安心方案", "Everyday Plus"],
    subtitle: ["扩展保障示例", "Extended coverage example"],
    price: "18",
    values: ["30", "3", "100"],
  },
];
export function InsurancePage() {
  const { colors, text, phone, notify } = useDesign();
  const [scene, setScene] = useState<Scene>("everyday");
  const [selected, setSelected] = useState("simple");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [review, setReview] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const plan = plans.find((item) => item.id === selected)!;
  const unit = (value: string, index: number) =>
    index === 2
      ? text(`${value} Q / 天`, `${value} Q / day`)
      : text(`${value} 万 Q`, `${Number(value) * 10000} Q`);
  return (
    <Page
      title={text("保险", "Insurance")}
      description={text(
        "保障与保费为虚构示例，当前不可投保。",
        "Coverage and premiums are fictional examples, unavailable for purchase.",
      )}
    >
      <Tabs
        items={scenes.map((item) => ({
          id: item.id,
          label: text(item.label[0], item.label[1]),
        }))}
        value={scene}
        onChange={(value) => {
          setScene(value as Scene);
          setExpanded(null);
        }}
      />
      <View>
        {plans.map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="radio"
            accessibilityLabel={text(item.label[0], item.label[1])}
            accessibilityState={{ checked: selected === item.id }}
            onPress={() => setSelected(item.id)}
            style={({ pressed }) => ({
              minHeight: 93,
              flexDirection: "row",
              alignItems: "center",
              gap: 14,
              paddingVertical: 20,
              borderBottomWidth: 1,
              borderColor: colors.line,
              opacity: pressed ? 0.65 : 1,
            })}
          >
            <ShieldCheck size={21} strokeWidth={1.4} color={colors.muted} />
            <View style={{ flex: 1, gap: 5 }}>
              <Type size={phone ? 16 : 15} weight="500">
                {text(item.label[0], item.label[1])}
              </Type>
              <Type size={13} muted>
                {text(item.subtitle[0], item.subtitle[1])}
              </Type>
            </View>
            <View style={{ gap: 5, alignItems: "flex-end" }}>
              <Type mono size={19}>
                {item.price}{" "}
                <Type size={13} muted>
                  {text("Q / 月", "Q / mo")}
                </Type>
              </Type>
              {selected === item.id ? (
                <Check size={15} color={colors.accent} />
              ) : (
                <View style={{ height: 15 }} />
              )}
            </View>
          </Pressable>
        ))}
      </View>
      <Action
        label={text("查看方案", "View plan")}
        icon={ArrowRight}
        onPress={() => {
          setDetails(true);
          setReview(false);
          setAcknowledged(false);
        }}
        style={{ alignSelf: phone ? "stretch" : "flex-start" }}
      />
      <Sheet
        visible={details}
        title={
          review
            ? text("确认预览", "Confirm preview")
            : text(plan.label[0], plan.label[1])
        }
        onClose={() => setDetails(false)}
      >
        <Type size={14} muted>
          {text(
            "以下保额、保费仅为设计示例。",
            "Coverage limits and premiums below are design examples.",
          )}
        </Type>
        <View>
          {benefits[scene].map((feature, index) => (
            <Row
              key={feature[0]}
              title={text(feature[0], feature[1])}
              right={
                <Type mono size={14}>
                  {unit(plan.values[index], index)}
                </Type>
              }
            />
          ))}
          <Row
            title={text("示例保费", "Sample premium")}
            right={
              <Type mono>
                {plan.price} {text("Q / 月", "Q / month")}
              </Type>
            }
            last
          />
        </View>
        {review ? (
          <>
            <Choice
              label={text(
                "我了解这是演示，不会投保或扣款",
                "I understand this preview does not insure or charge me",
              )}
              selected={acknowledged}
              onPress={() => setAcknowledged((value) => !value)}
            />
            <Action
              label={text("完成预览", "Finish preview")}
              disabled={!acknowledged}
              icon={Check}
              onPress={() => {
                setDetails(false);
                notify(
                  text(
                    "预览已完成，未投保或扣款。",
                    "Preview complete. No insurance or charge was created.",
                  ),
                );
              }}
            />
          </>
        ) : (
          <>
            <Divider />
            {[
              {
                id: "scope",
                title: text("保障范围与条款", "Coverage and terms"),
                body: text(
                  "本轮未提供实际保险产品。真实保障范围、责任免除、等待期和理赔条件需以正式条款为准。",
                  "No actual insurance is offered. Real coverage, exclusions, waiting periods and claims conditions would be defined by formal policy terms.",
                ),
              },
              {
                id: "claim",
                title: text("保单与理赔", "Policies and claims"),
                body: text(
                  "正式接入后可查看保单、保障期限与理赔入口。当前仅能预览选择流程。",
                  "Policy documents, dates and claims access would appear after integration. This is a selection preview only.",
                ),
              },
            ].map((item) => (
              <View key={item.id}>
                <Row
                  title={item.title}
                  onPress={() =>
                    setExpanded(expanded === item.id ? null : item.id)
                  }
                  right={
                    <ChevronDown
                      size={16}
                      color={colors.muted}
                      style={{
                        transform: [
                          { rotate: expanded === item.id ? "180deg" : "0deg" },
                        ],
                      }}
                    />
                  }
                />
                {expanded === item.id ? (
                  <Type size={15} muted style={{ paddingBottom: 15 }}>
                    {item.body}
                  </Type>
                ) : null}
              </View>
            ))}
            <Action
              label={text("继续预览", "Continue preview")}
              onPress={() => setReview(true)}
            />
          </>
        )}
      </Sheet>
    </Page>
  );
}
