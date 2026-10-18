import { useLocalSearchParams } from "expo-router";
import { PrototypeApp } from "@/prototype/app-shell";
export default function Index() {
  const { view } = useLocalSearchParams<{ view?: string }>();
  const page = view === "video" ? "video" : view === "creators" ? "creators" : "chat";
  return <PrototypeApp key={page} initialPage={page} />;
}
