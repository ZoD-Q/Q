import { useState } from "react";
import { View } from "react-native";
import { ArrowUpRight, Bird, Landmark, Waves } from "lucide-react-native";
import { Action, Divider, Page, Row, Sheet, Type, useDesign } from "../design";

const firms = [
  {
    name: "青狮证券",
    en: "Qingshi Securities",
    kind: "证券服务",
    kindEn: "Securities",
    icon: Landmark,
  },
  {
    name: "白鸽宝",
    en: "Baige Bao",
    kind: "服务目录",
    kindEn: "Service directory",
    icon: Bird,
  },
  {
    name: "鲸鱼理财",
    en: "Whale Finance",
    kind: "财富管理",
    kindEn: "Wealth management",
    icon: Waves,
  },
];
export function FinancePage() {
  const { text, colors } = useDesign();
  const [selected, setSelected] = useState<number | null>(null);
  return (
    <Page
      title={text("理财服务", "Financial services")}
      description={text(
        "目录预览，以下服务尚未接入。",
        "Directory preview. These services are not connected.",
      )}
    >
      <View>
        {firms.map((firm, index) => (
          <Row
            key={firm.name}
            title={text(firm.name, firm.en)}
            subtitle={text(firm.kind, firm.kindEn)}
            icon={firm.icon}
            onPress={() => setSelected(index)}
            right={<ArrowUpRight size={17} color={colors.muted} />}
            last={index === firms.length - 1}
          />
        ))}
      </View>
      <Sheet
        visible={selected !== null}
        title={
          selected === null
            ? ""
            : text(firms[selected].name, firms[selected].en)
        }
        onClose={() => setSelected(null)}
      >
        {selected !== null ? (
          <>
            <Type size={16} weight="500">
              {text(firms[selected].kind, firms[selected].kindEn)}
            </Type>
            <Type size={15} muted>
              {text(
                "这是服务详情的界面预览，尚未接入机构或产品，不提供投资建议。",
                "This is a service-detail preview. No provider or product is connected, and no investment advice is provided.",
              )}
            </Type>
            <Divider />
            <Row
              title={text("服务主体与资质", "Provider and credentials")}
              right={
                <Type size={14} muted>
                  {text("待接入", "Not connected")}
                </Type>
              }
            />
            <Row
              title={text("产品、费用与风险信息", "Products, fees and risks")}
              right={
                <Type size={14} muted>
                  {text("暂无", "Not available")}
                </Type>
              }
              last
            />
            <Action
              label={text("返回目录", "Back to directory")}
              kind="secondary"
              onPress={() => setSelected(null)}
            />
          </>
        ) : null}
      </Sheet>
    </Page>
  );
}
