import { useCallback, useEffect, useRef, useState } from "react";
import { fetch as expoFetch } from "expo/fetch";
import { randomUUID } from "expo-crypto";
import type { User, VideoConnection, VideoConnectionRequest, VideoJob, VideoJobRequest } from "@xiaoq/shared";
import { API_URL } from "../../services/api";
import { readToken, removeToken, writeToken } from "../../services/session-store";
import { decodeAuth, decodeConnection, decodeJob, decodeList, decodeUser, isSafeSubmissionRejection, workbenchRequest, WorkbenchError, type PendingVideo } from "./core";
import { pendingStore } from "./pending-store";

type Session = { token: string; user: User };
type Generation = Pick<VideoJobRequest, "connection_id" | "prompt" | "duration" | "aspect_ratio">;

export function useWorkbench() {
  const [session, setSession] = useState<Session | null>(null);
  const current = useRef<Session | null>(null);
  const alive = useRef(true);
  const requests = useRef(new Set<AbortController>());
  const locked = useRef(false);
  const [busy, setBusy] = useState<string | null>("restore");
  const [error, setError] = useState<unknown>(null);
  const [connections, setConnections] = useState<VideoConnection[]>([]);
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [pending, setPending] = useState<PendingVideo | null>(null);
  const [ready, setReady] = useState(false);

  const call = useCallback(async <T,>(path: string, decode: (value: unknown) => T, token: string | null, method: "GET" | "POST" | "DELETE" = "GET", body?: unknown) => {
    if (!alive.current) throw new WorkbenchError("CANCELLED");
    const controller = new AbortController();
    requests.current.add(controller);
    try {
      return await workbenchRequest({ baseUrl: API_URL, path, decode, token, method, body, signal: controller.signal, transport: expoFetch });
    } finally { requests.current.delete(controller); }
  }, []);

  const load = useCallback(async (active: Session) => {
    if (alive.current) setReady(false);
    // Local recovery is read first: a corrupt store must never enable a new request.
    const saved = await pendingStore.read(active.user.id);
    if (alive.current && current.current === active) setPending(saved);
    const [connectionList, jobList] = await Promise.all([
      call("/v1/video/connections", decodeList(decodeConnection), active.token),
      call("/v1/video/jobs", decodeList(decodeJob), active.token),
    ]);
    if (alive.current && current.current === active) {
      setConnections(connectionList);
      setJobs(jobList);
      setReady(true);
    }
  }, [call]);

  const run = useCallback(async (name: string, action: () => Promise<void>) => {
    if (locked.current) return false;
    locked.current = true;
    if (alive.current) { setBusy(name); setError(null); }
    try { await action(); return true; }
    catch (failure) {
      if (alive.current) {
        setError(failure);
        if (failure instanceof WorkbenchError && failure.status === 401 && failure.code !== "INVALID_CREDENTIALS") {
          const expiredToken = current.current?.token;
          current.current = null;
          setSession(null); setConnections([]); setJobs([]); setPending(null); setReady(false);
          if (expiredToken) await removeToken(expiredToken).catch(() => { setError(new WorkbenchError("STORAGE_ERROR")); });
        }
      }
      return false;
    } finally {
      locked.current = false;
      if (alive.current) setBusy(null);
    }
  }, []);

  const restore = useCallback(() => run("restore", async () => {
    const stored = await readToken();
    if (!stored || !alive.current) return;
    const user = await call("/v1/me", decodeUser, stored);
    if (!alive.current) return;
    const active = { token: stored, user };
    current.current = active; setSession(active);
    await load(active);
  }), [call, load, run]);

  useEffect(() => {
    alive.current = true;
    void restore();
    const inflight = requests.current;
    return () => {
      alive.current = false;
      for (const controller of inflight) controller.abort();
    };
  }, [restore]);

  const authenticate = (mode: "login" | "register", fields: { handle: string; password: string; display_name?: string }) => run("auth", async () => {
    const result = await call(`/v1/auth/${mode}`, decodeAuth, null, "POST", fields);
    if (!alive.current) return;
    if (!await writeToken(result.token, () => alive.current)) return;
    if (!alive.current) return;
    current.current = result; setSession(result);
    await load(result);
  });

  const refresh = () => run("refresh", async () => {
    const active = current.current;
    if (active) await load(active);
  });
  const logout = () => run("logout", async () => {
    const active = current.current;
    if (!active) return;
    await call("/v1/auth/logout", () => undefined, active.token, "POST");
    await removeToken(active.token);
    current.current = null;
    if (alive.current) { setSession(null); setConnections([]); setJobs([]); setPending(null); setReady(false); }
  });
  const addConnection = (body: VideoConnectionRequest) => run("connection", async () => {
    const active = current.current;
    if (!active) return;
    const result = await call("/v1/video/connections", decodeConnection, active.token, "POST", body);
    if (alive.current) setConnections((items) => [result, ...items]);
  });
  const revokeConnection = (id: string) => run("revoke", async () => {
    const active = current.current;
    if (!active) return;
    await call(`/v1/video/connections/${encodeURIComponent(id)}`, () => undefined, active.token, "DELETE");
    if (alive.current) setConnections((items) => items.map((item) => item.id === id ? { ...item, revoked: true } : item));
  });
  const recordJob = (job: VideoJob) => { if (alive.current) setJobs((items) => [job, ...items.filter((item) => item.id !== job.id)]); };
  const submitPending = async (active: Session, intent: PendingVideo) => {
    let job: VideoJob;
    try {
      job = await call("/v1/video/jobs", decodeJob, active.token, "POST", intent.request);
    } catch (error) {
      if (isSafeSubmissionRejection(error)) {
        await pendingStore.clear(active.user.id, intent.request.idempotency_key);
        if (alive.current) setPending(null);
      }
      throw error;
    }
    recordJob(job);
    await pendingStore.clear(active.user.id, intent.request.idempotency_key);
    if (alive.current) setPending(null);
  };
  const createJob = (fields: Generation) => run("create", async () => {
    const active = current.current;
    if (!active || !ready) return;
    const intent: PendingVideo = { owner_id: active.user.id, request: { ...fields, model_name: "kling-v2-6", mode: "pro", idempotency_key: randomUUID() } };
    await pendingStore.save(intent);
    if (alive.current) setPending(intent);
    await submitPending(active, intent);
  });
  const recover = () => run("recover", async () => {
    const active = current.current;
    if (!active) return;
    const intent = await pendingStore.read(active.user.id);
    if (intent) await submitPending(active, intent);
    await load(active);
  });
  const refreshJob = (id: string) => run("job", async () => {
    const active = current.current;
    if (!active) return;
    recordJob(await call(`/v1/video/jobs/${encodeURIComponent(id)}`, decodeJob, active.token));
  });

  return { session, busy, error, connections, jobs, pending, ready, restore, authenticate, refresh, logout, addConnection, revokeConnection, createJob, recover, refreshJob };
}
