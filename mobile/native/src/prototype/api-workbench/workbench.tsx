import { useState } from "react";
import { KeyboardAvoidingView, Pressable, View } from "react-native";
import { Check, ChevronRight, KeyRound, Plus, RefreshCw, Video } from "lucide-react-native";
import type { VideoConnection, VideoJobRequest } from "@xiaoq/shared";
import { Divider, Input, Page, Sheet, Tag, Type, useDesign } from "../design";
import { VideoStage } from "../video/feed-card";
import { isUncertainJob, WorkbenchError } from "./core";
import { Button, Notice, Option } from "./components";
import { AuthForm, ConnectionForm } from "./forms";
import { errorMessage, statusLabel } from "./messages";
import { useWorkbench } from "./use-workbench";

export function ApiWorkbenchPage() {
  const work = useWorkbench();
  if (!work.session) return <AuthForm busy={work.busy} error={work.error} authenticate={work.authenticate} restore={work.restore} />;
  return <WorkbenchContent key={work.session.user.id} work={work} />;
}

function WorkbenchContent({ work }: { work: ReturnType<typeof useWorkbench> }) {
  const { colors, text, locale } = useDesign();
  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<VideoConnection | null>(null);
  const [selectedConnection, setSelectedConnection] = useState("");
  const [prompt, setPrompt] = useState("");
  const [duration, setDuration] = useState<VideoJobRequest["duration"]>("5");
  const [ratio, setRatio] = useState<VideoJobRequest["aspect_ratio"]>("16:9");
  const [confirmation, setConfirmation] = useState(false);
  const [newTaskAcknowledged, setNewTaskAcknowledged] = useState(false);
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);
  const [visibleJobs, setVisibleJobs] = useState(20);
  const usable = work.connections.filter((connection) => !connection.revoked);
  const activeConnection = usable.find((connection) => connection.id === selectedConnection) ?? usable[0];
  const unresolved = work.jobs.find(isUncertainJob);
  const detail = work.jobs.find((job) => job.id === selectedJob);
  const canCreate = !!activeConnection && !!prompt.trim() && Array.from(prompt.trim()).length <= 2500 && !work.pending && work.ready;
  const regionName = (value: "cn" | "global") => value === "cn" ? text("中国内地接口", "Mainland China API") : text("国际接口", "International API");
  const dateLabel = (value: string) => new Date(value).toLocaleString(locale === "zh" ? "zh-CN" : "en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  const create = async () => {
    if (!activeConnection || !canCreate || (unresolved && !newTaskAcknowledged)) return;
    setConfirmation(false);
    const succeeded = await work.createJob({ connection_id: activeConnection.id, prompt: prompt.trim(), duration, aspect_ratio: ratio });
    if (succeeded) setPrompt("");
  };

  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={process.env.EXPO_OS === "ios" ? "padding" : undefined}>
    <Page title={text("API 工作台", "API workbench")} description={text("用你自己的可灵 API 创作视频。", "Create videos with your own Kling API.")}
      action={<Button label={text("添加连接", "Add connection")} icon={Plus} kind={usable.length ? "secondary" : "primary"} disabled={!!work.busy} onPress={() => setAdding(true)} />}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 12, justifyContent: "space-between" }}>
        <Type size={14} muted>{text("当前账号", "Signed in as")} <Type size={14} weight="500">@{work.session?.user.handle}</Type></Type>
        <View style={{ flexDirection: "row", gap: 4 }}>
          <Button label={work.busy === "refresh" ? text("刷新中…", "Refreshing…") : text("刷新", "Refresh")} icon={RefreshCw} kind="ghost" disabled={!!work.busy} onPress={() => void work.refresh()} />
          <Button label={text("退出登录", "Sign out")} kind="ghost" disabled={!!work.busy} onPress={() => { setSelectedJob(null); void work.logout(); }} />
        </View>
      </View>
      {work.error ? <Notice error>{errorMessage(work.error, text)}</Notice> : null}
      {work.pending ? <View style={{ gap: 12 }}><Notice>{text("上一条提交还没有确认结果，原请求已保留。先恢复原请求，避免重复生成与计费。", "Your last submission is unconfirmed and its original request is retained. Recover it first to avoid duplicate generation and charges.")}</Notice>
        <Button label={work.busy === "recover" ? text("正在恢复…", "Recovering…") : text("恢复原请求", "Recover original request")} disabled={!!work.busy} onPress={() => void work.recover()} /></View> : null}
      {unresolved && !work.pending ? <View style={{ gap: 12 }}><Notice>{text("有一条任务仍待确认受理。请查询原任务；新建另一条任务可能额外计费。", "One task still has unconfirmed acceptance. Check the original task; a separate new task may incur extra charges.")}</Notice>
        <Button label={text("查询待确认任务", "Check unconfirmed task")} kind="secondary" disabled={!!work.busy} onPress={() => { setSelectedJob(unresolved.id); void work.refreshJob(unresolved.id); }} /></View> : null}
      <View style={{ gap: 16 }}>
        <Type header size={18} weight="600">{text("我的连接", "My connections")}</Type>
        {work.connections.length ? work.connections.map((connection) => <View key={connection.id} style={{ borderBottomWidth: 1, borderColor: colors.line, paddingBottom: 12, gap: 4 }}>
          <Pressable accessibilityRole="radio" accessibilityLabel={`${connection.name} · ${regionName(connection.region)}`} accessibilityState={{ checked: activeConnection?.id === connection.id, disabled: connection.revoked || !!work.busy }} disabled={connection.revoked || !!work.busy} onPress={() => setSelectedConnection(connection.id)}
            style={({ pressed }) => ({ minHeight: 64, borderRadius: 12, padding: 12, gap: 12, alignItems: "center", flexDirection: "row", backgroundColor: activeConnection?.id === connection.id ? colors.accentBg : "transparent", opacity: pressed ? 0.7 : 1 })}>
            <KeyRound size={20} color={connection.revoked ? colors.muted : colors.accent} aria-hidden />
            <View style={{ flex: 1, minWidth: 0, gap: 4 }}><Type size={15} weight="500">{connection.name}</Type><Type size={12} muted>Kling · {regionName(connection.region)} · {connection.revoked ? text("已撤销", "Revoked") : text("已保存 · 权限未验证", "Saved · access unverified")}</Type></View>
            {activeConnection?.id === connection.id ? <Check size={18} color={colors.accent} aria-hidden /> : null}
          </Pressable>
          {!connection.revoked ? <View style={{ alignSelf: "flex-end" }}><Button label={text("撤销连接", "Revoke connection")} kind="ghost" disabled={!!work.busy} onPress={() => setRevoking(connection)} /></View> : null}
        </View>) : <View style={{ gap: 10, paddingVertical: 12 }}><Type size={16}>{text("还没有连接可灵", "No Kling connection yet")}</Type><Type size={14} muted>{text("添加你的 API Key 后，就可以在这里提交视频创作。密钥会加密保存在 Q 服务端。", "Add your API key to submit videos here. Your key is encrypted on the Q server.")}</Type></View>}
      </View>
      <Divider />
      <View style={{ gap: 20 }}>
        <View style={{ gap: 8 }}><Type header size={18} weight="600">{text("创作视频", "Create a video")}</Type><Type size={14} muted>Kling 2.6 · Pro · {text("无声视频", "Silent video")}</Type></View>
        <Input label={text("画面描述", "Video prompt")} placeholder={text("描述主体、动作、环境与镜头，例如：清晨的海边，一只海鸥掠过浪尖，镜头缓缓跟随。", "Describe the subject, action, setting and camera movement.")} value={prompt} onChangeText={setPrompt} multiline maxLength={2500} editable={!work.busy} style={{ minHeight: 144 }} hint={text("最多 2500 字。描述会发送给可灵。", "Up to 2,500 characters. Your prompt is sent to Kling.")} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 24 }}>
          <View style={{ gap: 8 }}><Type size={13} weight="500">{text("时长", "Duration")}</Type><View style={{ flexDirection: "row", gap: 8 }}>{(["5", "10"] as const).map((value) => <Option key={value} label={`${value} ${text("秒", "sec")}`} selected={duration === value} disabled={!!work.busy} onPress={() => setDuration(value)} />)}</View></View>
          <View style={{ gap: 8 }}><Type size={13} weight="500">{text("画面比例", "Aspect ratio")}</Type><View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{(["16:9", "9:16", "1:1"] as const).map((value) => <Option key={value} label={value} selected={ratio === value} disabled={!!work.busy} onPress={() => setRatio(value)} />)}</View></View>
        </View>
        <Type size={13} muted>{activeConnection ? text(`使用「${activeConnection.name}」。费用由可灵账户承担，Q 演示余额不可抵扣。`, `Using “${activeConnection.name}”. Kling bills your account; Q demo credits do not apply.`) : text("请先添加并选择一个有效连接。", "Add and select an active connection first.")}</Type>
        <View style={{ alignSelf: "flex-start" }}><Button label={work.busy === "create" ? text("正在提交…", "Submitting…") : text("确认并生成", "Review and generate")} icon={Video} disabled={!!work.busy || !canCreate} onPress={() => { setNewTaskAcknowledged(false); setConfirmation(true); }} /></View>
      </View>
      <Divider />
      <View style={{ gap: 16 }}><Type header size={18} weight="600">{text("创作记录", "Video history")}</Type>
        <Type size={13} muted>{text("记录保存在 Q 账户中。打开任务可查询最新状态；视频地址由可灵提供，可能过期。", "History is saved to your Q account. Open a task to check its status. Kling video URLs may expire.")}</Type>
        {!work.jobs.length ? <Type muted size={14}>{work.ready ? text("还没有生成任务。", "No generation tasks yet.") : text("正在载入记录；若未显示，请刷新。", "Loading history. Refresh if it does not appear.")}</Type> : work.jobs.slice(0, visibleJobs).map((job) => <Pressable key={job.id} accessibilityRole="button" accessibilityLabel={`${statusLabel(job.status, text)}: ${job.prompt}`} onPress={() => setSelectedJob(job.id)}
          style={({ pressed }) => ({ minHeight: 84, paddingVertical: 16, gap: 12, borderBottomWidth: 1, borderColor: colors.line, flexDirection: "row", alignItems: "center", opacity: pressed ? 0.65 : 1 })}>
          <View style={{ flex: 1, minWidth: 0, gap: 8 }}><Tag accent={job.status === "succeeded"}>{statusLabel(job.status, text)}</Tag><Type size={15} numberOfLines={2}>{job.prompt}</Type><Type size={12} muted>{job.duration}{text(" 秒", " sec")} · {job.aspect_ratio} · {dateLabel(job.created_at)}</Type></View><ChevronRight size={18} color={colors.muted} aria-hidden />
        </Pressable>)}
        {work.jobs.length > visibleJobs ? <Button label={text("显示更多记录", "Show more history")} kind="secondary" onPress={() => setVisibleJobs((count) => count + 20)} /> : null}
      </View>
    </Page>
    {adding ? <ConnectionForm busy={!!work.busy} error={work.error} save={work.addConnection} close={() => setAdding(false)} /> : null}
    <Sheet visible={!!revoking} title={text("撤销连接", "Revoke connection")} onClose={() => setRevoking(null)}>
      <Type>{text(`撤销「${revoking?.name ?? ""}」后，Q 将删除保存的密钥并停止后续调用。`, `Revoking “${revoking?.name ?? ""}” deletes its saved key and stops future calls.`)}</Type>
      <Type size={14} muted>{text("已开始的供应商请求可能继续完成，不会取消生成或退款。任务记录会保留。", "Already-started supplier requests may finish. This does not cancel generation or refund charges. History is retained.")}</Type>
      {work.error ? <Notice error>{errorMessage(work.error, text)}</Notice> : null}
      <Button label={text("确认撤销", "Revoke connection")} kind="danger" disabled={!!work.busy} onPress={() => { if (revoking) void work.revokeConnection(revoking.id).then((ok) => { if (ok) setRevoking(null); }); }} />
      <Button label={text("保留连接", "Keep connection")} kind="secondary" onPress={() => setRevoking(null)} />
    </Sheet>
    <Sheet visible={confirmation} title={text("提交到可灵", "Submit to Kling")} onClose={() => setConfirmation(false)}>
      <Type>{text("这会发起真实的视频生成请求，可能消耗你的可灵额度或产生费用。", "This sends a real generation request and may consume your Kling credits or incur charges.")}</Type>
      <View style={{ gap: 8 }}><Type weight="500">{activeConnection?.name}</Type><Type muted size={14}>Kling 2.6 Pro · {duration}{text(" 秒", " sec")} · {ratio} · {text("无声", "Silent")}</Type><Type size={14} numberOfLines={6}>{prompt.trim()}</Type></View>
      <Type size={13} muted>{text("实际费用以可灵账户的套餐和账单为准。Q 不估价、不扣除演示余额。", "Actual charges follow your Kling plan and bill. Q does not estimate prices or deduct demo credits.")}</Type>
      {unresolved ? <Pressable accessibilityRole="checkbox" accessibilityLabel={text("我知道原任务仍待确认，本次会新建独立任务并可能额外计费。", "I understand the original task is unconfirmed. This creates a separate task and may incur extra charges.")} accessibilityState={{ checked: newTaskAcknowledged }} onPress={() => setNewTaskAcknowledged((value) => !value)} style={{ minHeight: 48, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12 }}>
        <View style={{ width: 24, height: 24, borderWidth: 1, borderColor: colors.accent, borderRadius: 6, alignItems: "center", justifyContent: "center" }}>{newTaskAcknowledged ? <Check size={18} color={colors.accent} aria-hidden /> : null}</View>
        <Type size={14} style={{ flex: 1 }}>{text("我知道原任务仍待确认，本次会新建独立任务并可能额外计费。", "I understand the original task is unconfirmed. This creates a separate task and may incur extra charges.")}</Type>
      </Pressable> : null}
      <Button label={text("同意供应商计费并提交", "Accept supplier charges and submit")} disabled={!!work.busy || !canCreate || (!!unresolved && !newTaskAcknowledged)} onPress={() => void create()} />
      <Button label={text("返回修改", "Back to edit")} kind="secondary" onPress={() => setConfirmation(false)} />
    </Sheet>
    <Sheet visible={!!detail} title={text("视频任务", "Video task")} onClose={() => setSelectedJob(null)} wide>
      {detail ? <>
        <Tag accent={detail.status === "succeeded"}>{statusLabel(detail.status, text)}</Tag>
        <Type selectable>{detail.prompt}</Type>
        <Type size={13} muted>Kling 2.6 Pro · {detail.duration}{text(" 秒", " sec")} · {detail.aspect_ratio} · {dateLabel(detail.created_at)}</Type>
        {detail.video_url && detail.status === "succeeded" ? <View style={{ height: detail.aspect_ratio === "9:16" ? 420 : 280, borderRadius: 16, overflow: "hidden" }}><VideoStage key={detail.id + detail.video_url} uri={detail.video_url} active={!adding && !confirmation && !revoking} muted={muted} onMutedChange={setMuted} autoPlay={false} /></View> : null}
        {detail.error_code ? <Notice error>{errorMessage(new WorkbenchError(detail.error_code), text)}</Notice> : null}
        {work.error ? <Notice error>{errorMessage(work.error, text)}</Notice> : null}
        <Type selectable mono size={12} muted>{text("任务", "Task")} {detail.id}</Type>
        <Type size={13} muted>{text("视频来自可灵，链接可能过期。此处不会发布到创作者广场。", "The video comes from Kling and its URL may expire. It is not published to the creator feed.")}</Type>
        <Button label={work.busy === "job" ? text("正在查询…", "Checking…") : text("查询最新状态", "Check latest status")} icon={RefreshCw} kind="secondary" disabled={!!work.busy} onPress={() => void work.refreshJob(detail.id)} />
      </> : null}
    </Sheet>
  </KeyboardAvoidingView>;
}
