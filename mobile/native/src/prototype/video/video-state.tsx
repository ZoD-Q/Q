import { Asset } from "expo-asset";
import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useDesign } from "../design";
import { quoteVideo } from "./pricing";

export type VideoAspect = "9:16" | "16:9" | "1:1";
export interface VideoAsset {
  id: string;
  title: string;
  uri: string;
  origin: "sample" | "local";
  ads: string[];
  aspect: VideoAspect;
}
export interface VideoPost extends VideoAsset {
  author: string;
  likes: number;
}
export type VideoModelId = "kling" | "runway" | "veo";
export const videoModels = [
  { id: "kling" as const, name: "Kling", zh: "可灵" },
  { id: "runway" as const, name: "Runway", zh: "Runway" },
  { id: "veo" as const, name: "Veo", zh: "Veo" },
];
export interface VideoDraft {
  prompt: string;
  model: VideoModelId;
  duration: 5 | 10;
  aspect: VideoAspect;
  ads: string[];
}
export interface GenerationJob {
  id: string;
  status: "generating" | "ready" | "cancelled";
  progress: number;
  draft: VideoDraft;
  quote: ReturnType<typeof quoteVideo>;
  asset: VideoAsset | null;
}
export const sampleVideos = [
  {
    id: "sample-coast",
    title: "海边日光",
    uri: Asset.fromModule(require("../../../assets/video/coastal-light.mp4"))
      .uri,
    author: "小Q Demo",
  },
  {
    id: "sample-flow",
    title: "蓝色流动",
    uri: Asset.fromModule(require("../../../assets/video/blue-flow.mp4")).uri,
    author: "小Q Demo",
  },
  {
    id: "sample-hills",
    title: "纸间山丘",
    uri: Asset.fromModule(require("../../../assets/video/paper-hills.mp4")).uri,
    author: "小Q Demo",
  },
];
interface StudioState {
  draft: VideoDraft;
  updateDraft: (patch: Partial<VideoDraft>) => void;
  connections: Partial<Record<VideoModelId, boolean>>;
  connectPreview: (model: VideoModelId) => void;
  disconnectPreview: (model: VideoModelId) => void;
  job: GenerationJob | null;
  startPreview: () => void;
  cancelPreview: () => void;
  clearJob: () => void;
  posts: VideoPost[];
  publishPost: (asset: VideoAsset) => string;
  pendingPublish: VideoAsset | null;
  queuePublish: (asset: VideoAsset) => void;
  clearPendingPublish: () => void;
}
const Context = createContext<StudioState | null>(null);
export function VideoStudioProvider({ children }: { children: ReactNode }) {
  const { name } = useDesign();
  const [draft, setDraft] = useState<VideoDraft>({
    prompt: "",
    model: "kling",
    duration: 5,
    aspect: "9:16",
    ads: [],
  });
  const [connections, setConnections] = useState<
    Partial<Record<VideoModelId, boolean>>
  >({});
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [posts, setPosts] = useState<VideoPost[]>(
    sampleVideos.map((item) => ({
      ...item,
      origin: "sample",
      ads: [],
      aspect: "9:16",
      likes: 0,
    })),
  );
  const [pendingPublish, setPendingPublish] = useState<VideoAsset | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const active = useRef<string | null>(null);
  const ownedBlobUrls = useRef(new Set<string>());
  const clearTimer = () => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  };
  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
      active.current = null;
      if (process.env.EXPO_OS === "web") {
        for (const uri of ownedBlobUrls.current) URL.revokeObjectURL(uri);
        ownedBlobUrls.current.clear();
      }
    },
    [],
  );
  const updateDraft = (patch: Partial<VideoDraft>) =>
    setDraft((current) => ({
      ...current,
      ...patch,
      ads: patch.ads ? [...new Set(patch.ads)] : current.ads,
    }));
  const startPreview = () => {
    if (!draft.prompt.trim() || active.current) return;
    const snapshot = {
      ...draft,
      prompt: draft.prompt.trim(),
      ads: [...new Set(draft.ads)],
    };
    const quote = quoteVideo(snapshot.duration * 400, snapshot.ads);
    const id = `preview-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    clearTimer();
    active.current = id;
    setJob({
      id,
      status: "generating",
      progress: 0,
      draft: snapshot,
      quote,
      asset: null,
    });
    let progress = 0;
    timer.current = setInterval(() => {
      if (active.current !== id) return;
      progress = Math.min(100, progress + 10);
      if (progress === 100) {
        clearTimer();
        active.current = null;
        const asset: VideoAsset = {
          id,
          title: snapshot.prompt.slice(0, 80),
          uri: sampleVideos[0].uri,
          origin: "sample",
          ads: snapshot.ads,
          aspect: snapshot.aspect,
        };
        setJob((current) =>
          current?.id === id
            ? { ...current, status: "ready", progress: 100, asset }
            : current,
        );
      } else
        setJob((current) =>
          current?.id === id ? { ...current, progress } : current,
        );
    }, 350);
  };
  const cancelPreview = () => {
    clearTimer();
    active.current = null;
    setJob((current) =>
      current?.status === "generating"
        ? { ...current, status: "cancelled" }
        : current,
    );
  };
  const publishPost = (asset: VideoAsset) => {
    if (!asset.title.trim() || !asset.uri) throw new Error("INVALID_POST");
    if (
      asset.origin === "sample" &&
      !sampleVideos.some((item) => item.uri === asset.uri)
    )
      throw new Error("INVALID_SAMPLE");
    const id = `post-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    if (asset.origin === "local" && asset.uri.startsWith("blob:"))
      ownedBlobUrls.current.add(asset.uri);
    setPosts((current) => [
      { ...asset, id, title: asset.title.trim(), author: name, likes: 0 },
      ...current,
    ]);
    setPendingPublish(null);
    return id;
  };
  return (
    <Context
      value={{
        draft,
        updateDraft,
        connections,
        connectPreview: (model) =>
          setConnections((current) => ({ ...current, [model]: true })),
        disconnectPreview: (model) =>
          setConnections((current) => ({ ...current, [model]: false })),
        job,
        startPreview,
        cancelPreview,
        clearJob: () => {
          clearTimer();
          active.current = null;
          setJob(null);
        },
        posts,
        publishPost,
        pendingPublish,
        queuePublish: (asset) => setPendingPublish(asset),
        clearPendingPublish: () => setPendingPublish(null),
      }}
    >
      {children}
    </Context>
  );
}
export function useVideoStudio() {
  const value = use(Context);
  if (!value) throw new Error("VideoStudioProvider missing");
  return value;
}
