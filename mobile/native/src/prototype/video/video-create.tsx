import { useState } from "react";
import {
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Film,
  KeyRound,
  Plus,
  RotateCcw,
  Sparkles,
  Tag as TagIcon,
  X,
} from "lucide-react-native";
import {
  Action,
  Choice,
  Divider,
  Input,
  Sheet,
  Type,
  useDesign,
} from "../design";
import { BrandPicker } from "./brand-picker";
import { VideoStage } from "./feed-card";
import { brands } from "./data/brands";
import { quoteVideo } from "./pricing";
import {
  useVideoStudio,
  videoModels,
  type VideoAspect,
  type VideoAsset,
} from "./video-state";
import { selectionFeedback } from "../motion";

const money = (value: number) => (value / 100).toFixed(2);
function ResultPlayer({
  asset,
  active,
}: {
  asset: VideoAsset;
  active: boolean;
}) {
  const { colors, text } = useDesign();
  const [muted, setMuted] = useState(true);
  return (
    <View style={{ gap: 10 }}>
      <View style={{ height: 250, borderRadius: 18, overflow: "hidden" }}>
        <VideoStage
          uri={asset.uri}
          active={active}
          muted={muted}
          onMutedChange={setMuted}
          autoPlay={false}
        />
      </View>
      <Type size={11} color={colors.muted}>
        {text(
          "小Q原创演示素材，非提示词生成，广告未实际植入。",
          "Original Q demo footage. Not prompt-generated; no real ad insertion.",
        )}
      </Type>
    </View>
  );
}
export function VideoCreate({ onOpenFeed, onOpenApi }: { onOpenFeed: () => void; onOpenApi: () => void }) {
  const { colors, text, phone } = useDesign();
  const studio = useVideoStudio();
  const { draft, updateDraft, job } = studio;
  const [brandsOpen, setBrandsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [demoKey, setDemoKey] = useState("");
  const [continueAfterKey, setContinueAfterKey] = useState(false);
  const [fieldError, setFieldError] = useState(false);
  const quote = quoteVideo(draft.duration * 400, draft.ads);
  const connected = !!studio.connections[draft.model];
  const model = videoModels.find((item) => item.id === draft.model)!;
  const busy = job?.status === "generating";
  const selectedBrands = draft.ads
    .map((id) => brands.find((item) => item.id === id))
    .filter((item) => !!item);
  const generate = () => {
    if (!draft.prompt.trim()) {
      setFieldError(true);
      return;
    }
    setFieldError(false);
    if (!connected) {
      setContinueAfterKey(true);
      setKeyOpen(true);
      return;
    }
    selectionFeedback();
    studio.startPreview();
  };
  const connect = () => {
    if (!demoKey.trim()) return;
    studio.connectPreview(draft.model);
    setDemoKey("");
    setKeyOpen(false);
    if (continueAfterKey) {
      studio.startPreview();
      setContinueAfterKey(false);
    }
  };
  const demoConnect = () => {
    studio.connectPreview(draft.model);
    setDemoKey("");
    setKeyOpen(false);
    if (continueAfterKey) {
      studio.startPreview();
      setContinueAfterKey(false);
    }
  };
  const closeKey = () => {
    setDemoKey("");
    setKeyOpen(false);
    setContinueAfterKey(false);
  };
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={process.env.EXPO_OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: phone ? 22 : 44,
          paddingTop: phone ? 14 : 28,
          paddingBottom: 32,
          maxWidth: 900,
          width: "100%",
          alignSelf: "center",
          gap: 28,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
          }}
        >
          <Type size={phone ? 25 : 29} weight="600" header>
            {text("视频创作", "Video studio")}
          </Type>
          <Action
            kind="ghost"
            label={text("创作者广场", "Creators")}
            icon={Film}
            onPress={onOpenFeed}
          />
        </View>
        <View style={{ gap: 10, padding: 16, backgroundColor: colors.accentBg, borderRadius: 16 }}>
          <Type size={15} weight="500">{text("用自己的可灵 API 创作", "Create with your Kling API")}</Type>
          <Type size={13} muted>{text("在 API 工作台连接账户，提交真实生成。下方保留本地演示。", "Connect your account in the API workbench for real generation. The local demo remains below.")}</Type>
          <Action label={text("打开 API 工作台", "Open API workbench")} icon={KeyRound} onPress={onOpenApi} />
        </View>
        <View style={{ gap: 17 }}>
          <Type size={15} muted>
            {text(
              "你描述画面，小Q帮你开始。",
              "Describe a scene. Start creating.",
            )}
          </Type>
          <View
            style={{
              borderWidth: 1,
              borderColor: fieldError ? colors.danger : colors.line,
              borderRadius: 20,
              padding: 18,
              gap: 12,
              backgroundColor: colors.surface,
            }}
          >
            <TextInput
              accessibilityLabel={text("视频画面描述", "Video prompt")}
              placeholder={text(
                "一辆白色跑车驶过海边公路，日落的光掠过车身，镜头缓慢跟随…",
                "A white sports car along a coastal road at sunset, with a slow tracking shot…",
              )}
              placeholderTextColor={colors.faint}
              value={draft.prompt}
              maxLength={2000}
              onChangeText={(value) => {
                updateDraft({ prompt: value });
                setFieldError(false);
              }}
              multiline
              editable={!busy}
              style={{
                minHeight: phone ? 128 : 148,
                maxHeight: 220,
                textAlignVertical: "top",
                fontSize: 16,
                lineHeight: 27,
                color: colors.ink,
                padding: 0,
              }}
            />
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={text(
                  "模型与画面设置",
                  "Model and format settings",
                )}
                disabled={busy}
                onPress={() => setSettingsOpen(true)}
                style={{
                  minHeight: 44,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 7,
                }}
              >
                <Type size={13} weight="500">
                  {model.name}
                </Type>
                <ChevronDown size={12} color={colors.muted} />
                <Type size={12} muted>
                  {draft.duration}s · {draft.aspect}
                </Type>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={text(
                  "配置视频模型API Key",
                  "Configure video model API key",
                )}
                disabled={busy}
                onPress={() => {
                  setContinueAfterKey(false);
                  setKeyOpen(true);
                }}
                style={{
                  minHeight: 44,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                {connected ? (
                  <Check size={14} color={colors.green} />
                ) : (
                  <KeyRound size={14} color={colors.muted} />
                )}
                <Type size={12} color={connected ? colors.green : colors.muted}>
                  {connected ? text("演示已配置", "Demo connected") : "API Key"}
                </Type>
              </Pressable>
            </View>
          </View>
          {fieldError ? (
            <Type size={13} color={colors.danger}>
              {text(
                "先写下想生成的画面。",
                "Describe the video you want to create.",
              )}
            </Type>
          ) : null}
          {!draft.prompt ? (
            <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
              {[
                {
                  zh: "电影感风景",
                  en: "Cinematic scenery",
                  prompt: "清晨的山谷，薄雾在树林间流动，镜头缓缓升高。",
                },
                {
                  zh: "产品短片",
                  en: "Product shot",
                  prompt: "一双运动鞋在极简白色空间中旋转，柔光强调材质细节。",
                },
              ].map((item) => (
                <Pressable
                  key={item.en}
                  accessibilityRole="button"
                  accessibilityLabel={text(item.zh, item.en)}
                  onPress={() =>
                    updateDraft({
                      prompt: text(
                        item.prompt,
                        item.en === "Product shot"
                          ? "Sneakers rotate in a white studio, soft lighting highlighting material details."
                          : "Morning mist flows through a forest valley as the camera slowly rises.",
                      ),
                    })
                  }
                  style={{
                    minHeight: 44,
                    paddingHorizontal: 12,
                    justifyContent: "center",
                    borderRadius: 11,
                    backgroundColor: colors.soft,
                  }}
                >
                  <Type size={13} muted>
                    {text(item.zh, item.en)}
                  </Type>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
        <View style={{ gap: 12 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={text(
              "选择植入广告品牌",
              "Select advertising brands",
            )}
            disabled={busy}
            onPress={() => setBrandsOpen(true)}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 13,
              minHeight: 62,
              paddingVertical: 10,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <View
              style={{
                height: 38,
                width: 38,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: colors.accentBg,
                borderRadius: 12,
              }}
            >
              <TagIcon size={18} color={colors.accent} />
            </View>
            <View style={{ flex: 1, gap: 3 }}>
              <Type size={15} weight="500">
                {draft.ads.length
                  ? text(
                      `已选择 ${draft.ads.length} 个品牌`,
                      `Selected ${draft.ads.length} brands`,
                    )
                  : text("植入广告，降低费用", "Add brands, lower the price")}
              </Type>
              <Type size={12} muted>
                {text("每个省5%，最多10个", "Save 5% per brand, up to 10")}
              </Type>
            </View>
            {draft.ads.length ? (
              <Type color={colors.accent} size={15} weight="600">
                −{quote.discountPercent}%
              </Type>
            ) : (
              <Plus size={18} color={colors.muted} />
            )}
          </Pressable>
          {selectedBrands.length ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8 }}
            >
              {selectedBrands.map((brand) => (
                <Pressable
                  key={brand!.id}
                  accessibilityRole="button"
                  accessibilityLabel={text(
                    `移除${brand!.name}`,
                    `Remove ${brand!.name}`,
                  )}
                  disabled={busy}
                  onPress={() =>
                    updateDraft({
                      ads: draft.ads.filter((id) => id !== brand!.id),
                    })
                  }
                  style={{
                    minHeight: 38,
                    paddingHorizontal: 11,
                    backgroundColor: colors.soft,
                    borderRadius: 10,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <Type size={12}>{brand!.name}</Type>
                  <X size={12} color={colors.muted} />
                </Pressable>
              ))}
            </ScrollView>
          ) : null}
        </View>
        <Divider />
        <View style={{ gap: 12 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <Type size={13} muted>
              {text("预览价格", "Preview price")}
            </Type>
            <View
              style={{ flexDirection: "row", alignItems: "baseline", gap: 9 }}
            >
              {quote.savingsMinor > 0 ? (
                <Type
                  size={13}
                  muted
                  style={{ textDecorationLine: "line-through" }}
                >
                  {money(quote.baseMinor)} Q
                </Type>
              ) : null}
              <Type size={24} weight="600">
                {money(quote.totalMinor)}{" "}
                <Type size={13} muted>
                  Q
                </Type>
              </Type>
            </View>
          </View>
          <Action
            label={
              busy
                ? text(
                    `正在生成预览 ${job.progress}%`,
                    `Preparing preview ${job.progress}%`,
                  )
                : text("生成视频预览", "Generate video preview")
            }
            icon={Sparkles}
            onPress={generate}
            disabled={busy || !draft.prompt.trim()}
          />
          {busy ? (
            <>
              <View
                style={{
                  height: 3,
                  borderRadius: 3,
                  backgroundColor: colors.soft,
                }}
              >
                <View
                  style={{
                    height: 3,
                    width: `${job.progress}%`,
                    borderRadius: 3,
                    backgroundColor: colors.accent,
                  }}
                />
              </View>
              <Action
                kind="ghost"
                label={text("取消生成", "Cancel")}
                onPress={studio.cancelPreview}
              />
            </>
          ) : null}
          <Type size={11} muted style={{ textAlign: "center" }}>
            {text(
              "前端原型，不调用模型、不扣款。广告未真实植入。",
              "Frontend preview. No model calls, charges, or real ad placements.",
            )}
          </Type>
        </View>
        {job?.status === "cancelled" ? (
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <Type size={14} muted>
              {text(
                "已取消，描述和品牌选择都保留了。",
                "Cancelled. Your prompt and brands are kept.",
              )}
            </Type>
            <Action
              kind="ghost"
              label={text("重试", "Retry")}
              icon={RotateCcw}
              onPress={generate}
            />
          </View>
        ) : null}
        {job?.status === "ready" && job.asset ? (
          <View style={{ gap: 18, paddingTop: 10 }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <Type size={19} weight="600">
                {text("预览已就绪", "Preview ready")}
              </Type>
              <Type size={12} muted>
                {job.draft.duration}s · {job.draft.aspect}
              </Type>
            </View>
            <ResultPlayer
              key={job.id}
              asset={job.asset}
              active={!brandsOpen && !settingsOpen && !keyOpen}
            />
            <Type size={14} numberOfLines={3}>
              {job.draft.prompt}
            </Type>
            <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
              <Action
                label={text("发布到广场", "Post to creators")}
                icon={ArrowUpRight}
                onPress={() => {
                  studio.queuePublish(job.asset!);
                  onOpenFeed();
                }}
              />
              <Action
                label={text("再试一次", "Try again")}
                kind="secondary"
                icon={RotateCcw}
                onPress={generate}
              />
            </View>
          </View>
        ) : null}
      </ScrollView>
      <BrandPicker
        visible={brandsOpen}
        selected={draft.ads}
        onChange={(ads) => updateDraft({ ads })}
        onClose={() => setBrandsOpen(false)}
      />
      <Sheet
        visible={settingsOpen}
        title={text("生成设置", "Generation settings")}
        onClose={() => setSettingsOpen(false)}
      >
        <Type size={13} muted>
          {text("模型", "Model")}
        </Type>
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          {videoModels.map((item) => (
            <Choice
              key={item.id}
              label={item.name}
              selected={draft.model === item.id}
              onPress={() => updateDraft({ model: item.id })}
            />
          ))}
        </View>
        <Type size={13} muted>
          {text("画面比例", "Aspect ratio")}
        </Type>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {(["9:16", "16:9", "1:1"] as VideoAspect[]).map((aspect) => (
            <Choice
              key={aspect}
              label={aspect}
              selected={draft.aspect === aspect}
              onPress={() => updateDraft({ aspect })}
            />
          ))}
        </View>
        <Type size={13} muted>
          {text("视频时长", "Duration")}
        </Type>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {([5, 10] as const).map((duration) => (
            <Choice
              key={duration}
              label={`${duration}${text("秒", "s")}`}
              selected={draft.duration === duration}
              onPress={() => updateDraft({ duration })}
            />
          ))}
        </View>
        <Action
          label={text("完成", "Done")}
          onPress={() => setSettingsOpen(false)}
        />
      </Sheet>
      <Sheet
        visible={keyOpen}
        title={`${model.name} API Key`}
        onClose={closeKey}
      >
        <Type size={14} muted>
          {text(
            "这里只演示连接流程，请不要填写真实密钥。",
            "This is a connection preview. Do not enter a real API key.",
          )}
        </Type>
        <Input
          label="API Key"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          value={demoKey}
          onChangeText={setDemoKey}
          placeholder="demo_video_key"
        />
        <Action
          label={text("使用演示 Key 继续", "Continue with demo key")}
          onPress={demoConnect}
        />
        <Action
          kind="secondary"
          label={text("保存演示配置", "Save demo configuration")}
          disabled={!demoKey.trim()}
          onPress={connect}
        />
        {connected ? (
          <Action
            kind="ghost"
            label={text("断开演示连接", "Disconnect demo")}
            onPress={() => {
              studio.disconnectPreview(draft.model);
              closeKey();
            }}
          />
        ) : null}
        <Type size={12} muted>
          {text(
            "输入不会被保存或发送给供应商。",
            "The input is not stored or sent to a provider.",
          )}
        </Type>
      </Sheet>
    </KeyboardAvoidingView>
  );
}
