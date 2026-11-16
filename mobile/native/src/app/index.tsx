import { useLocalSearchParams } from "expo-router";
import { PrototypeApp } from "@/prototype/app-shell";
import { isRetiredModuleId } from "@/prototype/app-assistant/catalog";
export default function Index() {
  const { view } = useLocalSearchParams<{ view?: string }>();
  const retired = isRetiredModuleId(view) ? view : undefined;
  const page =
    view === "wallet" ? "wallet" :
    view === "keys" ? "keys" :
    view === "plugins" ? "plugins" :
    view === "plugin-workbench" ? "plugin-workbench" :
    view === "insurance" ? "insurance" :
    view === "finance" ? "finance" :
    view === "profile" ? "profile" : "chat";
  return <PrototypeApp key={retired ?? page} initialPage={page} retiredEntry={retired} />;
}
