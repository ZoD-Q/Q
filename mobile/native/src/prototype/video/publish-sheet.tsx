import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { Check, FileVideo, Upload } from "lucide-react-native";
import { Action, Choice, Input, Sheet, Type, useDesign } from "../design";
import { VideoStage } from "./feed-card";
import type { VideoAspect, VideoAsset } from "./video-state";

const isBrowserBlob = (uri: string) =>
  process.env.EXPO_OS === "web" && uri.startsWith("blob:");
function releaseBrowserBlob(uri: string) {
  if (isBrowserBlob(uri)) URL.revokeObjectURL(uri);
}

export function PublishSheet({
  initialAsset,
  onClose,
  onPublish,
}: {
  initialAsset: VideoAsset | null;
  onClose: () => void;
  onPublish: (asset: VideoAsset) => void;
}) {
  const { colors, text } = useDesign();
  const [asset, setAsset] = useState<VideoAsset | null>(initialAsset);
  const [title, setTitle] = useState(initialAsset?.title || "");
  const [aspect, setAspect] = useState<VideoAspect>(
    initialAsset?.aspect || "9:16",
  );
  const [muted, setMuted] = useState(true);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<
    "pick" | "type" | "title" | "publish" | null
  >(null);
  const pickerBusy = useRef(false);
  const ownedUrls = useRef(new Set<string>());
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const owned = ownedUrls.current;
    return () => {
      mounted.current = false;
      owned.forEach(releaseBrowserBlob);
      owned.clear();
    };
  }, []);
  const pick = async () => {
    if (pickerBusy.current) return;
    pickerBusy.current = true;
    setPicking(true);
    setError(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "video/*",
        multiple: false,
        copyToCacheDirectory: true,
        base64: false,
      });
      if (result.canceled || !result.assets?.length) return;
      if (!mounted.current) {
        result.assets.forEach((file) => releaseBrowserBlob(file.uri));
        return;
      }
      const file = result.assets[0];
      result.assets.slice(1).forEach((extra) => releaseBrowserBlob(extra.uri));
      if (file.mimeType && !file.mimeType.startsWith("video/")) {
        releaseBrowserBlob(file.uri);
        setError("type");
        return;
      }
      if (isBrowserBlob(file.uri)) ownedUrls.current.add(file.uri);
      for (const previous of ownedUrls.current) {
        if (previous !== file.uri) {
          releaseBrowserBlob(previous);
          ownedUrls.current.delete(previous);
        }
      }
      const label = file.name.replace(/\.[^.]+$/, "");
      setAsset({
        id: `local-${Date.now()}`,
        title: label,
        uri: file.uri,
        origin: "local",
        ads: [],
        aspect,
      });
      if (!title.trim() || title === asset?.title) setTitle(label.slice(0, 80));
    } catch {
      if (mounted.current) setError("pick");
    } finally {
      pickerBusy.current = false;
      if (mounted.current) setPicking(false);
    }
  };
  const publish = () => {
    if (!asset) return;
    if (!title.trim()) {
      setError("title");
      return;
    }
    // Successful publish transfers this URL to VideoStudioProvider's session.
    const transferring = ownedUrls.current.delete(asset.uri);
    try {
      onPublish({ ...asset, title: title.trim(), aspect });
    } catch {
      if (transferring) {
        if (mounted.current) ownedUrls.current.add(asset.uri);
        else releaseBrowserBlob(asset.uri);
      }
      if (mounted.current) setError("publish");
    }
  };
  return (
    <Sheet
      visible
      title={text("发布视频", "Publish video")}
      onClose={onClose}
      footer={
        <Action
          label={text("发布到本机广场", "Publish to this device")}
          icon={Check}
          onPress={publish}
          disabled={!asset || picking}
        />
      }
    >
      <Type size={13} muted>
        {text(
          "仅保存在本次会话，不会上传到网络。",
          "Kept for this session only. Nothing is uploaded.",
        )}
      </Type>
      {asset ? (
        <View
          style={{
            height: 220,
            width: aspect === "9:16" ? 124 : aspect === "1:1" ? 220 : "100%",
            alignSelf: "center",
            borderRadius: 15,
            overflow: "hidden",
          }}
        >
          <VideoStage
            key={asset.id}
            uri={asset.uri}
            active={!picking}
            muted={muted}
            onMutedChange={setMuted}
            autoPlay={false}
          />
        </View>
      ) : (
        <View
          style={{
            minHeight: 150,
            gap: 14,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.soft,
            borderRadius: 15,
          }}
        >
          <FileVideo size={28} color={colors.muted} strokeWidth={1.4} />
          <Type size={15} muted>
            {text("选择一段视频", "Choose a video")}
          </Type>
        </View>
      )}
      {asset?.origin === "sample" ? (
        <Type size={13} color={colors.accent}>
          {text(
            "小Q 演示素材 · 非提示词生成",
            "Q demo footage · not prompt-generated",
          )}
        </Type>
      ) : null}
      <Action
        kind="secondary"
        icon={Upload}
        label={
          picking
            ? text("正在选择…", "Choosing…")
            : asset
              ? text("更换本地视频", "Choose another local video")
              : text("选择本地视频", "Choose a local video")
        }
        onPress={() => void pick()}
        disabled={picking}
      />
      <Input
        label={text("标题", "Title")}
        value={title}
        onChangeText={(value) => {
          setTitle(value);
          setError(null);
        }}
        placeholder={text("给作品起个名字", "Give your video a title")}
        maxLength={80}
      />
      <View style={{ gap: 8 }}>
        <Type size={13} muted>
          {text("展示比例", "Display ratio")}
        </Type>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {(["9:16", "16:9", "1:1"] as const).map((value) => (
            <Choice
              key={value}
              label={value}
              selected={aspect === value}
              onPress={() => setAspect(value)}
            />
          ))}
        </View>
      </View>
      {asset?.ads.length ? (
        <Type size={13} muted>
          {text(
            `包含 ${asset.ads.length} 个预览广告标记`,
            `Includes ${asset.ads.length} preview ad labels`,
          )}
        </Type>
      ) : null}
      {error ? (
        <View accessibilityLiveRegion="polite">
          <Type size={14} color={colors.danger}>
            {error === "title"
              ? text("请填写视频标题。", "Enter a video title.")
              : error === "type"
                ? text("请选择视频文件。", "Choose a video file.")
                : error === "publish"
                  ? text(
                      "暂时无法发布，视频仍保留在此处，请重试。",
                      "Could not publish. Your video is still here; please retry.",
                    )
                  : text(
                      "暂时无法打开文件，请重新选择。",
                      "The file could not be opened. Please try again.",
                    )}
          </Type>
        </View>
      ) : null}
    </Sheet>
  );
}
