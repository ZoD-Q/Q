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
    view === "plugin-workbench" ? "plugin-workbench" :
    view === "installments" ? "installments" :
    view === "insurance" ? "insurance" :
    view === "finance" ? "finance" :
    view === "profile" ? "profile" : "chat";
  return <PrototypeApp key={page} initialPage={page} />;
}
