import { useState } from "react";
import { useFinancialPreview } from './preview-state';
import { splitPayments } from './preview-math';
import { Pressable, View } from "react-native";
import {
  ArrowRight,
  BookOpen,
  Check,
  Compass,
  Headphones,
  Info,
  type LucideIcon,
} from "lucide-react-native";
import {
  Action,
  Choice,
  Divider,
  IconAction,
  Page,
  Row,
  Sheet,
  Type,
  useDesign,
} from "../design";

interface Service {
  id: string;
  name: [string, string];
  subtitle: [string, string];
  description: [string, string];
  price: number;
  icon: LucideIcon;
}
const services: Service[] = [
  {
    id: "course",
    name: ["把灵感做成作品", "Turn an idea into something real"],
    subtitle: ["创作课程 · 6 节课", "Creative course · 6 sessions"],
    description: [
      "从找到主题，到完成一件自己的作品。示例课程包含六节学习内容与练习安排。",
      "From finding a theme to finishing your own project. This sample course includes six sessions and practice prompts.",
    ],
    price: 1200,
    icon: BookOpen,
  },
  {
    id: "consultation",
    name: ["下一步，和自己聊聊", "Find your next step"],
    subtitle: ["成长咨询 · 3 次会谈", "Personal growth · 3 sessions"],
    description: [
      "整理想法，梳理近期目标，并为下一步留出清晰的空间。此处为咨询服务的展示示例。",
      "Make room to organize your thoughts and outline your next steps. This is a sample consultation service.",
    ],
    price: 900,
    icon: Compass,
  },
  {
    id: "language",
    name: ["让表达更自然", "Find your voice"],
    subtitle: ["语言练习 · 8 次陪练", "Language practice · 8 sessions"],
    description: [
      "用轻松的日常话题练习表达。示例服务包含八次陪练与课后复习材料。",
      "Practice with everyday topics at your own pace. This sample includes eight sessions and review materials.",
    ],
    price: 1680,
    icon: Headphones,
  },
];
function money(value: number) {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
export function InstallmentsPage() {
  const { colors, phone, text, notify } = useDesign();
  const { installment, setInstallment } = useFinancialPreview();
  const [selectedId, setSelectedId] = useState(installment?.serviceId ?? "course");
  const [periods, setPeriods] = useState(installment?.periods ?? 3);
  const [detail, setDetail] = useState<Service | null>(null);
  const [confirm, setConfirm] = useState(false);
  const selected = services.find((item) => item.id === selectedId)!;
  const payments = splitPayments(selected.price * 100, periods);
  const each = payments[0] / 100;
  return (
    <Page
      title={text("分期", "Installments")}
      description={text(
        "服务和金额均为示例，可预览不同支付计划。",
        "Sample services and amounts. Preview a payment plan.",
      )}
    >
      {installment ? <View style={{ gap: 12 }}>
        <Type weight="500">{text('已保存的分期预览', 'Saved payment preview')}</Type>
        <Row title={text(...services.find(item => item.id === installment.serviceId)!.name)} subtitle={text(`${installment.periods} 期 · 本次会话有效`, `${installment.periods} payments · this session only`)} onPress={() => { setSelectedId(installment.serviceId); setPeriods(installment.periods); setConfirm(true); }} />
        <Action kind="ghost" label={text('移除预览', 'Remove preview')} onPress={() => setInstallment(null)} />
      </View> : null}
      <View>
        {services.map((item) => {
          const active = item.id === selectedId;
          const Icon = item.icon;
          return (
            <View
              key={item.id}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                borderBottomWidth: 1,
                borderColor: colors.line,
              }}
            >
              <Pressable
                accessibilityRole="radio"
                accessibilityLabel={text(item.name[0], item.name[1])}
                accessibilityState={{ checked: active }}
                onPress={() => setSelectedId(item.id)}
                style={({ pressed }) => ({
                  flex: 1,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 13,
                  minHeight: 90,
                  paddingVertical: 18,
                  opacity: pressed ? 0.65 : 1,
                })}
              >
                <Icon size={21} strokeWidth={1.4} color={colors.muted} />
                <View style={{ flex: 1, gap: 4 }}>
                  <Type size={phone ? 16 : 15} weight="500">
                    {text(item.name[0], item.name[1])}
                  </Type>
                  <Type size={13} muted>
                    {text(item.subtitle[0], item.subtitle[1])}
                  </Type>
                </View>
                <View style={{ alignItems: "flex-end", gap: 7 }}>
                  <Type mono size={14}>
                    {money(item.price)} Q
                  </Type>
                  {active ? (
                    <Check size={15} color={colors.accent} />
                  ) : (
                    <View style={{ height: 15 }} />
                  )}
                </View>
              </Pressable>
              <IconAction
                icon={Info}
                label={text("查看服务内容", "View service details")}
                onPress={() => setDetail(item)}
              />
            </View>
          );
        })}
      </View>
      <View style={{ gap: 17, paddingTop: 4 }}>
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            gap: 20,
            alignItems: "center",
          }}
        >
          <View style={{ flex: 1, gap: 5 }}>
            <Type size={15} weight="500">
              {text(selected.name[0], selected.name[1])}
            </Type>
            <Type size={13} muted>
              {text(
                `${periods} 期 · 示例手续费 0.00 Q`,
                `${periods} payments · sample fee 0.00 Q`,
              )}
            </Type>
          </View>
          <View style={{ alignItems: "flex-end", gap: 3 }}>
            <Type mono size={20}>
              {money(each)} Q
            </Type>
            <Type size={13} muted>
              {text("每期", "per payment")}
            </Type>
          </View>
        </View>
        <Action
          label={text("选择支付计划", "Choose payment plan")}
          icon={ArrowRight}
          onPress={() => setConfirm(true)}
          style={{ alignSelf: phone ? "stretch" : "flex-start" }}
        />
      </View>
      <Sheet
        visible={!!detail}
        title={text("服务内容", "Service details")}
        onClose={() => setDetail(null)}
      >
        {detail ? (
          <>
            <Type size={20} weight="500">
              {text(detail.name[0], detail.name[1])}
            </Type>
            <Type size={16}>
              {text(detail.description[0], detail.description[1])}
            </Type>
            <Row
              title={text("服务安排", "Format")}
              subtitle={text(detail.subtitle[0], detail.subtitle[1])}
            />
            <Row
              title={text("示例总额", "Sample total")}
              right={<Type mono>{money(detail.price)} Q</Type>}
              last
            />
            <Action
              label={text("选择这项服务", "Choose this service")}
              onPress={() => {
                setSelectedId(detail.id);
                setDetail(null);
              }}
            />
          </>
        ) : null}
      </Sheet>
      <Sheet
        visible={confirm}
        title={text("支付计划", "Payment plan")}
        onClose={() => setConfirm(false)}
      >
        <Type size={18} weight="500">
          {text(selected.name[0], selected.name[1])}
        </Type>
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          {[1, 3, 6].map((value) => (
            <Choice
              key={value}
              label={
                value === 1
                  ? text("一次付清", "One payment")
                  : text(`${value} 期`, `${value} payments`)
              }
              selected={periods === value}
              onPress={() => setPeriods(value)}
            />
          ))}
        </View>
        <View>
          <Row
            title={text("示例总额", "Sample total")}
            right={<Type mono>{money(selected.price)} Q</Type>}
          />
          <Row
            title={text("示例手续费", "Sample fee")}
            right={<Type mono>0.00 Q</Type>}
            last
          />
        </View>
        <Divider />
        <View>
          {payments.map((amount, i) => (
            <View
              key={i}
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 16,
                paddingVertical: 13,
                borderBottomWidth: i === periods - 1 ? 0 : 1,
                borderColor: colors.line,
              }}
            >
              <Type size={15} style={{ flex: 1 }}>
                {i === 0
                  ? text("首期 · 确认时", "First · on confirmation")
                  : text(
                      `第 ${i + 1} 期 · ${i} 个月后`,
                      `Payment ${i + 1} · after ${i} month${i > 1 ? "s" : ""}`,
                    )}
              </Type>
              <Type mono size={14}>
                {money(amount / 100)} Q
              </Type>
            </View>
          ))}
        </View>
        <Type size={13} muted>
          {text(
            "仅保存预览选择，不会申请授信、下单或扣款。",
            "Saves a preview only. No credit application, order or charge.",
          )}
        </Type>
        <Action
          icon={Check}
          label={text("保存预览", "Save preview")}
          onPress={() => {
            setInstallment({ serviceId: selectedId, periods });
            setConfirm(false);
            notify(
              text(
                "已保存本次方案选择，未创建订单或分期协议。",
                "Preview saved. No order or installment agreement was created.",
              ),
            );
          }}
        />
      </Sheet>
    </Page>
  );
}
