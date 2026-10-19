import { createContext, use, useState, type ReactNode } from "react";
import {
  createMaterials,
  inspectCardJson,
  inspectDraft,
  inspectEntry,
  type CheckReport,
  type EntryKind,
  type Issue,
  type PluginDraft,
} from "./materials";

const blankDraft: PluginDraft = {
  title: "", description: "", name: "", version: "1.0.0", cardUrl: "", endpointUrl: "",
  needsAuth: false, hasUi: false, domainDiscovery: false, publicListing: false,
};
const exampleDraft: PluginDraft = {
  title: "日程助手", description: "查询日程、规划时间并创建日历事件。",
  name: "example.calendar/schedule", version: "1.0.0",
  cardUrl: "https://calendar.example/plugins/schedule/server-card.json",
  endpointUrl: "https://calendar.example/mcp/schedule",
  needsAuth: true, hasUi: false, domainDiscovery: false, publicListing: false,
};

function useWorkbenchState() {
  const [tab, setTab] = useState("connect");
  const [entryKind, setKind] = useState<EntryKind>("card");
  const [entry, setEntryValue] = useState("");
  const [entryReport, setEntryReport] = useState<CheckReport | null>(null);
  const [cardInput, setCardValue] = useState("");
  const [cardReport, setCardReport] = useState<CheckReport | null>(null);
  const [draft, setDraft] = useState<PluginDraft>({ ...blankDraft });
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [materials, setMaterials] = useState<ReturnType<typeof createMaterials> | null>(null);
  const [step, setStep] = useState(0);
  return {
    tab, setTab, entryKind, entry, entryReport, cardInput, cardReport, draft, issues, materials, step,
    setStep(value: number) { setStep(value); setIssues(null); },
    setEntry(value: string) { setEntryValue(value); setEntryReport(null); },
    setEntryKind(value: EntryKind) { setKind(value); setEntryReport(null); },
    checkEntry() { setEntryReport(inspectEntry(entry, entryKind)); },
    setCardInput(value: string) { setCardValue(value); setCardReport(null); },
    checkCard() { setCardReport(inspectCardJson(cardInput)); },
    updateDraft<K extends keyof PluginDraft>(key: K, value: PluginDraft[K]) {
      setDraft(current => ({ ...current, [key]: value }));
      setIssues(null);
      setMaterials(null);
    },
    validateDraft() {
      const next = inspectDraft(draft);
      setIssues(next);
      return next;
    },
    generate() {
      const next = inspectDraft(draft);
      setIssues(next);
      if (next.some(issue => issue.level === "error")) return false;
      setMaterials(createMaterials(draft));
      return true;
    },
    useExample() {
      setDraft({ ...exampleDraft }); setIssues(null); setMaterials(null); setStep(0);
    },
    useGeneratedCard() {
      if (!materials) return;
      setKind("card"); setEntryValue(draft.cardUrl); setEntryReport(null);
      setCardValue(materials.card); setCardReport(null); setTab("connect");
    },
  };
}
const Context = createContext<ReturnType<typeof useWorkbenchState> | null>(null);
export function PluginWorkbenchProvider({ children }: { children: ReactNode }) {
  const value = useWorkbenchState();
  return <Context value={value}>{children}</Context>;
}
export function usePluginWorkbench() {
  const state = use(Context);
  if (!state) throw new Error("PluginWorkbenchProvider missing");
  return state;
}
