import { useEffect, useState } from "react";
import { ActivityIndicator, AppState, Pressable, View } from "react-native";
import { useEvent } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import { useReducedMotion } from "react-native-reanimated";
import { useIsFocused } from "expo-router/react-navigation";
import {
  Pause,
  Play,
  RotateCcw,
  Volume2,
  VolumeX,
  type LucideIcon,
} from "lucide-react-native";
import { Type, useDesign } from "../design";

function MediaButton({
  icon: Icon,
  label,
  onPress,
  selected = false,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 48,
        height: 48,
        borderRadius: 24,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed ? "#FFFFFF35" : "#111820D9",
      })}
    >
      <Icon size={21} color="#FFFFFF" strokeWidth={1.7} />
    </Pressable>
  );
}

/** One player per visible stage. Hook disposal and active gating stop off-screen audio. */
export function VideoStage({
  uri,
  active,
  muted,
  onMutedChange,
  autoPlay = true,
}: {
  uri: string;
  active: boolean;
  muted: boolean;
  onMutedChange: (value: boolean) => void;
  autoPlay?: boolean;
}) {
  const { text } = useDesign();
  const reduced = useReducedMotion();
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const [paused, setPaused] = useState(!autoPlay || reduced);
  const [retry, setRetry] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const player = useVideoPlayer(uri, (value) => {
    value.loop = true;
    value.muted = true;
    value.staysActiveInBackground = false;
    value.showNowPlayingNotification = false;
  });
  const { isPlaying } = useEvent(player, "playingChange", {
    isPlaying: player.playing,
  });
  const { status } = useEvent(player, "statusChange", {
    status: player.status,
  });
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    // Expo's VideoPlayer is an imperative native handle, not immutable React state.
    // eslint-disable-next-line react-hooks/immutability
    player.muted = muted;
  }, [player, muted]);
  useEffect(() => {
    if (active && focused && foreground && !paused && status === "readyToPlay")
      player.play();
    else player.pause();
    return () => player.pause();
  }, [active, focused, foreground, paused, player, status]);
  const reload = () => {
    setLoadFailed(false);
    setRetry((value) => value + 1);
    void player.replaceAsync(uri).catch(() => setLoadFailed(true));
  };
  const failed = status === "error" || loadFailed;
  return (
    <View
      style={{
        flex: 1,
        minHeight: 160,
        backgroundColor: "#10171D",
        overflow: "hidden",
      }}
    >
      <VideoView
        key={retry}
        player={player}
        style={{ width: "100%", height: "100%" }}
        contentFit="contain"
        nativeControls={false}
        allowsPictureInPicture={false}
        fullscreenOptions={{ enable: false }}
        surfaceType="textureView"
      />
      {status === "loading" && !failed ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            inset: 0,
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
          }}
        >
          <ActivityIndicator color="#FFFFFF" />
          <Type color="#FFFFFF" size={13}>
            {text("正在载入视频", "Loading video")}
          </Type>
        </View>
      ) : null}
      {failed ? (
        <View
          style={{
            position: "absolute",
            inset: 0,
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            gap: 15,
            backgroundColor: "#10171DEB",
          }}
        >
          <Type size={15} color="#FFFFFF" style={{ textAlign: "center" }}>
            {text("视频暂时无法播放", "This video could not be played")}
          </Type>
          <MediaButton
            icon={RotateCcw}
            label={text("重新载入视频", "Reload video")}
            onPress={reload}
          />
          <Type size={13} color="#BCCAD4" style={{ textAlign: "center" }}>
            {text(
              "检查网络，或尝试其他视频。",
              "Check your connection or try another video.",
            )}
          </Type>
        </View>
      ) : null}
      {!failed && !isPlaying && status !== "loading" ? (
        <View
          style={{
            position: "absolute",
            inset: 0,
            alignItems: "center",
            justifyContent: "center",
          }}
          pointerEvents="box-none"
        >
          <MediaButton
            icon={Play}
            label={text("播放视频", "Play video")}
            onPress={() => {
              setPaused(false);
              if (active && foreground) player.play();
            }}
          />
        </View>
      ) : null}
      <View
        style={{
          position: "absolute",
          bottom: 14,
          left: 14,
          right: 14,
          flexDirection: "row",
          justifyContent: "space-between",
        }}
      >
        <MediaButton
          icon={isPlaying ? Pause : Play}
          label={
            isPlaying
              ? text("暂停视频", "Pause video")
              : text("播放视频", "Play video")
          }
          onPress={() => {
            const next = isPlaying;
            setPaused(next);
            if (next) player.pause();
            else if (active && foreground) player.play();
          }}
        />
        <MediaButton
          icon={muted ? VolumeX : Volume2}
          label={
            muted
              ? text("开启声音", "Unmute video")
              : text("静音", "Mute video")
          }
          selected={!muted}
          onPress={() => onMutedChange(!muted)}
        />
      </View>
    </View>
  );
}
