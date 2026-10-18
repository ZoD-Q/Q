import { useState } from "react";
import { Pressable, View } from "react-native";
import {
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  CreditCard,
  Eye,
  EyeOff,
  Landmark,
  WalletCards,
} from "lucide-react-native";
import {
  Action,
  Divider,
  IconAction,
  Input,
  Page,
  Row,
  Sheet,
  Tabs,
  Tag,
  Type,
  useDesign,
} from "../design";

const ledger = [
  {
    id: "1",
    name: ["小林", "Lin"],
    note: ["周末的咖啡", "Weekend coffee"],
    date: "10.17 · 14:32",
    amount: -32,
  },
  {
    id: "2",
    name: ["Kai", "Kai"],
    note: ["午餐的一半", "Half of lunch"],
    date: "10.16 · 12:18",
    amount: 68,
  },
  {
    id: "3",
    name: ["小Q", "Little Q"],
    note: ["欢迎演示额度", "Welcome demo credit"],
    date: "10.15 · 09:00",
    amount: 1244,
  },
];
type Flow = "send" | "receive" | "deposit" | "channels" | null;
export function WalletPage() {
  const { colors, text, phone, notify } = useDesign();
  const [hidden, setHidden] = useState(false);
  const [filter, setFilter] = useState("all");
  const [flow, setFlow] = useState<Flow>(null);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [review, setReview] = useState(false);
  const [channel, setChannel] = useState("Apple Pay");
  const [detail, setDetail] = useState<(typeof ledger)[number] | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [receiveHelp, setReceiveHelp] = useState(false);
  const open = (next: Flow) => {
    setReview(false);
    setInvalid(false);
    setReceiveHelp(false);
    setFlow(next);
  };
  const validate = () => {
    if (
      !recipient.trim() ||
      !/^\d{1,7}(\.\d{1,2})?$/.test(amount) ||
      Number(amount) <= 0
    )
      return setInvalid(true);
    setInvalid(false);
    setReview(true);
  };
  const finish = () => {
    notify(
      text(
        "转账界面预览已完成。未发送资金，演示余额不变。",
        "Transfer preview complete. No funds were sent; the demo balance is unchanged.",
      ),
    );
    setFlow(null);
  };
  const filtered = ledger.filter(
    (item) =>
      filter === "all" || (filter === "in" ? item.amount > 0 : item.amount < 0),
  );
  return (
    <Page
      title={text("钱包", "Wallet")}
      description={text(
        "金额与流水为演示数据，不涉及真实资金。",
        "Amounts and activity are demonstrations, with no real funds.",
      )}
    >
      <View
        style={{
          paddingBottom: 24,
          gap: 12,
          borderBottomWidth: 1,
          borderColor: colors.line,
        }}
      >
        <View style={{ flexDirection: "row", gap: 4, alignItems: "center" }}>
          <Type size={14} muted>
            {text("演示余额", "Demo balance")}
          </Type>
          <IconAction
            label={text(
              hidden ? "显示余额" : "隐藏余额",
              hidden ? "Show balance" : "Hide balance",
            )}
            icon={hidden ? EyeOff : Eye}
            onPress={() => setHidden((value) => !value)}
          />
        </View>
        <View style={{ flexDirection: "row", gap: 9, alignItems: "baseline" }}>
          <Type mono size={34} style={{ letterSpacing: -1 }}>
            {hidden ? "••••••" : "1,280.00"}
          </Type>
          <Type size={16} muted>
            Q
          </Type>
        </View>
        <View style={{ flexDirection: "row", gap: 10, marginTop: 5 }}>
          <Action
            icon={ArrowUpRight}
            label={text("转账", "Send")}
            onPress={() => open("send")}
          />
          <Action
            kind="secondary"
            icon={ArrowDownLeft}
            label={text("收款", "Receive")}
            onPress={() => open("receive")}
          />
        </View>
      </View>
      <View style={{ gap: 6 }}>
        <Type size={16} weight="500">
          {text("流水", "Activity")}
        </Type>
        <Tabs
          value={filter}
          onChange={setFilter}
          items={[
            { id: "all", label: text("全部", "All") },
            { id: "in", label: text("收入", "Incoming") },
            { id: "out", label: text("支出", "Outgoing") },
          ]}
        />
        {filtered.map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            accessibilityLabel={`${text(item.name[0], item.name[1])} ${item.amount}`}
            onPress={() => setDetail(item)}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 15,
              borderBottomWidth: 1,
              borderColor: colors.line,
              paddingVertical: 22,
              opacity: pressed ? 0.65 : 1,
            })}
          >
            {item.amount > 0 ? (
              <ArrowDownLeft size={19} color={colors.muted} />
            ) : (
              <ArrowUpRight size={19} color={colors.muted} />
            )}
            <View style={{ flex: 1, gap: 4 }}>
              <Type size={phone ? 16 : 15} weight="500">
                {text(item.name[0], item.name[1])}
              </Type>
              <Type size={13} muted numberOfLines={1}>
                {text(item.note[0], item.note[1])} · {item.date}
              </Type>
            </View>
            <Type mono size={15}>
              {item.amount > 0 ? "+" : "−"}
              {Math.abs(item.amount).toFixed(2)}
            </Type>
          </Pressable>
        ))}
      </View>
      <View>
        <Row
          title={text("充值预览", "Add funds preview")}
          icon={ArrowDownToLine}
          onPress={() => open("deposit")}
        />
        <Row
          title={text("支付方式", "Payment methods")}
          icon={CreditCard}
          onPress={() => open("channels")}
          last
        />
      </View>
      <Sheet
        visible={!!flow}
        title={
          flow === "send"
            ? text(
                review ? "核对转账" : "转给一位朋友",
                review ? "Review transfer" : "Send to a friend",
              )
            : flow === "receive"
              ? text("我的收款信息", "Your receiving details")
              : flow === "deposit"
                ? text("充值方式", "Add funds")
                : text("支付方式", "Payment methods")
        }
        onClose={() => setFlow(null)}
      >
        <Tag>{text("仅界面预览", "INTERFACE PREVIEW")}</Tag>
        {flow === "send" ? (
          review ? (
            <>
              <Type serif size={30}>
                {amount} Q
              </Type>
              <Row
                title={text("收款人", "Recipient")}
                right={<Type>{recipient}</Type>}
              />
              <Row
                title={text("备注", "Note")}
                right={<Type>{memo || "—"}</Type>}
                last
              />
              <Type size={14} muted>
                {text(
                  "此步骤只预览确认体验，不会创建交易或修改余额。",
                  "This previews the confirmation step without creating a transaction or changing a balance.",
                )}
              </Type>
              <Action
                label={text("完成转账预览", "Finish transfer preview")}
                icon={Check}
                onPress={finish}
              />
              <Action
                kind="ghost"
                label={text("返回修改", "Edit details")}
                onPress={() => setReview(false)}
              />
            </>
          ) : (
            <>
              <Input
                label={text("朋友的小Q账号", "Their Q handle")}
                placeholder="@lin"
                value={recipient}
                onChangeText={setRecipient}
                autoCapitalize="none"
              />
              <Input
                label={text("金额 · Q", "Amount · Q")}
                placeholder="0.00"
                value={amount}
                onChangeText={setAmount}
                keyboardType="decimal-pad"
              />
              <Input
                label={text("备注（选填）", "Note (optional)")}
                placeholder={text("一份小小心意", "A little thoughtfulness")}
                value={memo}
                onChangeText={setMemo}
              />
              <View accessibilityLiveRegion="polite">
                {invalid ? (
                  <Type size={14} color={colors.danger}>
                    {text(
                      "请输入收款人和大于零的金额，最多 7 位整数及两位小数。",
                      "Enter a recipient and a positive amount, with up to 7 whole digits and two decimals.",
                    )}
                  </Type>
                ) : null}
              </View>
              <Action
                label={text("核对转账", "Review transfer")}
                icon={ArrowRight}
                onPress={validate}
              />
            </>
          )
        ) : null}
        {flow === "receive" ? (
          <>
            <View
              style={{ alignItems: "center", gap: 17, paddingVertical: 15 }}
            >
              <View
                style={{
                  width: 100,
                  height: 100,
                  borderRadius: 32,
                  backgroundColor: colors.soft,
                  justifyContent: "center",
                  alignItems: "center",
                }}
              >
                <WalletCards
                  size={40}
                  strokeWidth={1.2}
                  color={colors.accent}
                />
              </View>
              <Type serif size={26}>
                Kai
              </Type>
              <Type mono size={17} selectable>
                @kai-preview
              </Type>
            </View>
            <Type size={14} muted>
              {text(
                "此账号仅用于收款页面展示，不能接收真实款项。",
                "This example handle only illustrates receiving details and cannot receive funds.",
              )}
            </Type>
            <Action
              label={text(
                receiveHelp ? "收起收款说明" : "查看收款说明",
                receiveHelp ? "Hide receiving details" : "How receiving works",
              )}
              onPress={() => setReceiveHelp((value) => !value)}
            />
            {receiveHelp ? (
              <View
                accessibilityLiveRegion="polite"
                style={{
                  padding: 16,
                  backgroundColor: colors.soft,
                  borderRadius: 10,
                }}
              >
                <Type size={15}>
                  {text(
                    "正式接入后，可通过小Q账号查找收款人；本轮未连接账户服务。",
                    "A connected version would find recipients by Q handle. Account services are not connected in this preview.",
                  )}
                </Type>
              </View>
            ) : null}
          </>
        ) : null}
        {flow === "deposit" || flow === "channels" ? (
          <>
            <Type size={16}>
              {text(
                "选择一种方式，预览下一步。",
                "Choose a method to preview the next step.",
              )}
            </Type>
            {["Apple Pay", "支付宝", "微信支付", "银行卡"].map((value, i) => (
              <Row
                key={value}
                title={text(
                  value,
                  ["Apple Pay", "Alipay", "WeChat Pay", "Bank card"][i],
                )}
                subtitle={text(
                  "未接入 · 不会请求支付或银行卡信息",
                  "Not connected · no payment or card details requested",
                )}
                icon={i === 3 ? Landmark : CreditCard}
                onPress={() => {
                  setChannel(value);
                  setReview(true);
                }}
                right={
                  channel === value && review ? (
                    <Check size={18} color={colors.accent} />
                  ) : (
                    <ChevronRight size={17} color={colors.faint} />
                  )
                }
              />
            ))}
            {review ? (
              <View style={{ gap: 14 }}>
                <Divider />
                <Type size={14} muted>
                  {text(
                    `已选择 ${channel}。真实渠道接入后将在此展示授权步骤。`,
                    `${channel} selected. Authorization would appear here once a real provider is connected.`,
                  )}
                </Type>
                <Action
                  label={text("完成方式预览", "Finish method preview")}
                  onPress={() => {
                    setFlow(null);
                    notify(
                      text(
                        "支付方式预览完成，未绑定或扣款。",
                        "Method preview complete. Nothing was linked or charged.",
                      ),
                    );
                  }}
                />
              </View>
            ) : null}
          </>
        ) : null}
      </Sheet>
      <Sheet
        visible={!!detail}
        title={text("流水详情", "Activity details")}
        onClose={() => setDetail(null)}
      >
        {detail ? (
          <>
            <Tag>{text("示例记录", "SAMPLE RECORD")}</Tag>
            <Type mono size={31}>
              {detail.amount > 0 ? "+" : "−"}
              {Math.abs(detail.amount).toFixed(2)} Q
            </Type>
            <Row
              title={text("对方", "Counterparty")}
              right={<Type>{text(detail.name[0], detail.name[1])}</Type>}
            />
            <Row
              title={text("时间", "Time")}
              right={
                <Type mono size={14}>
                  {detail.date}
                </Type>
              }
            />
            <Row
              title={text("备注", "Note")}
              right={<Type>{text(detail.note[0], detail.note[1])}</Type>}
              last
            />
            <Type size={13} muted>
              {text(
                "用于展示，不对应真实交易。",
                "For display only; not a real transaction.",
              )}
            </Type>
          </>
        ) : null}
      </Sheet>
    </Page>
  );
}
