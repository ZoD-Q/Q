import { useLocalSearchParams } from "expo-router";
import { PrototypeApp } from "@/prototype/app-shell";
export default function Index() {
  const { view } = useLocalSearchParams<{ view?: string }>();
  const page =
    view === "wallet" ? "wallet" :
    view === "video" ? "video" :
    view === "creators" ? "creators" :
    view === "keys" ? "keys" :
    view === "plugins" ? "plugins" :
    view === "plugin-workbench" ? "plugin-workbench" : "chat";
  return <PrototypeApp key={page} initialPage={page} />;
}
