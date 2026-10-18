import { useCallback, useRef, useState } from "react";
import { FlatList, Pressable, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Heart,
  Info,
  Plus,
} from "lucide-react-native";
import { Action, IconAction, Sheet, Type, useDesign } from "../design";
import { VideoStage } from "./feed-card";
import { PublishSheet } from "./publish-sheet";
import {
  sampleVideos,
  useVideoStudio,
  type VideoAsset,
  type VideoPost,
} from "./video-state";

const viewability = { itemVisiblePercentThreshold: 65, minimumViewTime: 100 };
export function CreatorFeed({ onBack }: { onBack: () => void }) {
  const { colors, text, phone, notify } = useDesign();
  const { posts, publishPost, pendingPublish, clearPendingPublish } =
    useVideoStudio();
  const reduced = useReducedMotion();
  const list = useRef<FlatList<VideoPost>>(null);
  const [activeId, setActiveId] = useState(posts[0]?.id || "");
  const [viewportHeight, setViewportHeight] = useState(600);
  const [muted, setMuted] = useState(true);
  const [likes, setLikes] = useState<string[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [details, setDetails] = useState<VideoPost | null>(null);
  const publishVisible = publishing || !!pendingPublish;
  const activeIndex = Math.max(
    0,
    posts.findIndex((post) => post.id === activeId),
  );
  const onViewable = useCallback(
    ({
      viewableItems,
    }: {
      viewableItems: { item: VideoPost; isViewable: boolean }[];
    }) => {
      const item = viewableItems.find((value) => value.isViewable);
      if (item) setActiveId(item.item.id);
    },
    [],
  );
  const move = (offset: number) => {
    const index = Math.max(0, Math.min(posts.length - 1, activeIndex + offset));
    setActiveId(posts[index].id);
    list.current?.scrollToIndex({ index, animated: !reduced });
  };
  const closePublish = () => {
    setPublishing(false);
    clearPendingPublish();
  };
  const publish = (asset: VideoAsset) => {
    const id = publishPost(asset);
    setActiveId(id);
    setPublishing(false);
    list.current?.scrollToOffset({ offset: 0, animated: false });
    notify(
      text(
        "已发布到本机广场，仅本次会话可见。",
        "Published to this device, visible in this session only.",
      ),
    );
  };
  const toggleLike = (id: string) =>
    setLikes((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id],
    );
  const source = details
    ? sampleVideos.find((item) => item.uri === details.uri)
    : null;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View
        style={{
          minHeight: 70,
          paddingHorizontal: phone ? 16 : 32,
          paddingVertical: 10,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          borderBottomWidth: 1,
          borderColor: colors.line,
        }}
      >
        <IconAction
          icon={ArrowLeft}
          label={text("返回视频工作室", "Back to video studio")}
          onPress={onBack}
        />
        <Type size={phone ? 21 : 24} weight="600" header style={{ flex: 1 }}>
          {text("创作者广场", "Creator feed")}
        </Type>
        <Action
          icon={Plus}
          label={text("发布", "Publish")}
          onPress={() => setPublishing(true)}
        />
      </View>
      <View
        style={{ flex: 1, minHeight: 240 }}
        onLayout={(event) =>
          setViewportHeight(
            Math.max(240, Math.round(event.nativeEvent.layout.height)),
          )
        }
      >
        <FlatList
          ref={list}
          data={posts}
          keyExtractor={(item) => item.id}
          pagingEnabled
          snapToInterval={viewportHeight}
          decelerationRate="fast"
          showsVerticalScrollIndicator={false}
          onViewableItemsChanged={onViewable}
          viewabilityConfig={viewability}
          extraData={{ activeId, muted, likes, publishVisible, details }}
          initialNumToRender={1}
          maxToRenderPerBatch={2}
          windowSize={3}
          getItemLayout={(_, index) => ({
            length: viewportHeight,
            offset: viewportHeight * index,
            index,
          })}
          onScrollToIndexFailed={({ index }) =>
            list.current?.scrollToOffset({
              offset: index * viewportHeight,
              animated: false,
            })
          }
          renderItem={({ item, index }) => (
            <View
              style={{
                height: viewportHeight,
                paddingHorizontal: phone ? 0 : 32,
                paddingVertical: phone ? 0 : 20,
                flexDirection: phone ? "column" : "row",
                alignItems: "stretch",
                gap: phone ? 0 : 24,
                width: "100%",
                maxWidth: 1200,
                alignSelf: "center",
              }}
            >
              <View
                style={{
                  flex: 1,
                  minHeight: 130,
                  borderRadius: phone ? 0 : 18,
                  overflow: "hidden",
                }}
              >
                <VideoStage
                  uri={item.uri}
                  active={activeId === item.id && !publishVisible && !details}
                  muted={muted}
                  onMutedChange={setMuted}
                />
                <View
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    top: 14,
                    left: 14,
                    right: 14,
                    flexDirection: "row",
                    justifyContent: "space-between",
                    gap: 12,
                  }}
                >
                  <View
                    style={{
                      backgroundColor: "#10171DE6",
                      paddingHorizontal: 10,
                      paddingVertical: 5,
                      borderRadius: 7,
                    }}
                  >
                    <Type size={12} color="#FFFFFF">
                      {item.origin === "sample"
                        ? text("示例片源", "Sample footage")
                        : text("本机发布", "On this device")}
                    </Type>
                  </View>
                  <Type
                    size={12}
                    color="#FFFFFF"
                    style={{
                      backgroundColor: "#10171DE6",
                      paddingHorizontal: 8,
                      paddingVertical: 5,
                      borderRadius: 7,
                    }}
                  >
                    {index + 1} / {posts.length}
                  </Type>
                </View>
              </View>
              <View
                style={{
                  width: phone ? "100%" : 255,
                  paddingHorizontal: phone ? 20 : 0,
                  paddingVertical: phone ? 16 : 10,
                  gap: 10,
                  justifyContent: phone ? "flex-start" : "center",
                }}
              >
                <View style={{ gap: 5 }}>
                  <Type size={13} muted>
                    @{item.author}
                  </Type>
                  <Type
                    size={phone ? 16 : 22}
                    weight="500"
                    numberOfLines={phone ? 2 : 5}
                  >
                    {item.title}
                  </Type>
                </View>
                <Type size={12} muted>
                  {item.origin === "sample"
                    ? text(
                        "小Q 演示素材 · 非提示词生成",
                        "Q demo footage · not prompt-generated",
                      )
                    : text("本机视频 · 未上传", "Local video · not uploaded")}
                </Type>
                {item.ads.length ? (
                  <Type size={12} muted>
                    {text(
                      `${item.ads.length} 个广告预览标记 · 未实际植入`,
                      `${item.ads.length} ad preview labels · not inserted`,
                    )}
                  </Type>
                ) : null}
                <View
                  style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      likes.includes(item.id)
                        ? text("取消喜欢", "Unlike")
                        : text("喜欢", "Like")
                    }
                    accessibilityState={{ selected: likes.includes(item.id) }}
                    onPress={() => toggleLike(item.id)}
                    style={({ pressed }) => ({
                      minWidth: 64,
                      minHeight: 48,
                      paddingHorizontal: 10,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 8,
                      borderRadius: 12,
                      backgroundColor: pressed ? colors.soft : "transparent",
                    })}
                  >
                    <Heart
                      size={21}
                      color={
                        likes.includes(item.id) ? colors.accent : colors.muted
                      }
                      fill={
                        likes.includes(item.id) ? colors.accent : "transparent"
                      }
                      strokeWidth={1.6}
                    />
                    <Type size={14}>
                      {item.likes + (likes.includes(item.id) ? 1 : 0)}
                    </Type>
                  </Pressable>
                  <IconAction
                    icon={Info}
                    label={text("作品信息", "Video information")}
                    onPress={() => setDetails(item)}
                  />
                </View>
              </View>
            </View>
          )}
        />
      </View>
      <View
        style={{
          minHeight: 53,
          paddingHorizontal: phone ? 16 : 32,
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          borderTopWidth: 1,
          borderColor: colors.line,
        }}
      >
        <Type size={13} muted>
          {text("上下滑动浏览", "Scroll to explore")}
        </Type>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <IconAction
            icon={ChevronUp}
            label={text("上一条视频", "Previous video")}
            disabled={activeIndex === 0}
            onPress={() => move(-1)}
          />
          <IconAction
            icon={ChevronDown}
            label={text("下一条视频", "Next video")}
            disabled={activeIndex >= posts.length - 1}
            onPress={() => move(1)}
          />
        </View>
      </View>
      {publishVisible ? (
        <PublishSheet
          key={pendingPublish?.id || "local-upload"}
          initialAsset={pendingPublish}
          onClose={closePublish}
          onPublish={publish}
        />
      ) : null}
      <Sheet
        visible={!!details}
        title={text("作品信息", "Video information")}
        onClose={() => setDetails(null)}
      >
        {details ? (
          <>
            <Type size={20} weight="500">
              {details.title}
            </Type>
            <Type size={14} muted>
              {text("发布者", "Publisher")} · {details.author}
            </Type>
            {details.origin === "sample" ? (
              <>
                <Type size={15}>
                  {source?.title || "小Q 演示素材"} · 小Q Demo
                </Type>
                <Type size={14} muted>
                  {text(
                    "这是小Q本地绘制的原创短动画，仅用于交互预览。没有调用视频模型，也未真实植入广告。",
                    "Original animations created locally for this interface preview. No video model was called and no ads were inserted.",
                  )}
                </Type>
              </>
            ) : (
              <Type size={14} muted>
                {text(
                  "你选择的本地视频，仅在本机当前会话显示。",
                  "Your selected local video, shown only on this device for the current session.",
                )}
              </Type>
            )}
            <Action
              kind="secondary"
              label={text("继续浏览", "Continue watching")}
              onPress={() => setDetails(null)}
            />
          </>
        ) : null}
      </Sheet>
    </View>
  );
}
