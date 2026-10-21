import type { AiStatus } from '@xiaoq/shared';

export type AiStatusSnapshot = {
  phase: 'checking' | 'ready' | 'unconfigured' | 'error';
  status: AiStatus | null;
  error: string;
};

export const initialAiStatus: AiStatusSnapshot = { phase: 'checking', status: null, error: '' };

type Schedule = (callback: () => void, delayMs: number) => () => void;
const scheduleTimeout: Schedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};
const retryDelays = [1000, 3000] as const;

function classifyFailure(error: unknown) {
  const value = error !== null && typeof error === 'object' ? error : {};
  const status = 'status' in value && typeof value.status === 'number' ? value.status : 0;
  const code = 'code' in value && typeof value.code === 'string' && [
    'NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INSECURE_API_URL', 'INVALID_RESPONSE',
    'UNAUTHORIZED', 'CANCELLED',
  ].includes(value.code) ? value.code : 'REQUEST_FAILED';
  return {
    code,
    retry: !['INSECURE_API_URL', 'INVALID_RESPONSE', 'UNAUTHORIZED', 'CANCELLED'].includes(code)
      && !(status >= 400 && status <= 499)
      && (code === 'NETWORK_ERROR' || code === 'REQUEST_TIMEOUT' || (status >= 500 && status <= 599)),
  };
}

/** Public configuration checks have their own lifetime; they never authorize or retry a chat. */
export function createAiStatusMonitor(options: {
  load: (signal: AbortSignal) => Promise<AiStatus>;
  onChange: (snapshot: AiStatusSnapshot) => void;
  schedule?: Schedule;
}) {
  let snapshot = initialAiStatus;
  let generation = 0;
  let controller: AbortController | null = null;
  let cancelTimer: (() => void) | null = null;
  const publish = (next: AiStatusSnapshot) => { snapshot = next; options.onChange(next); };
  const pause = () => {
    generation++;
    controller?.abort();
    controller = null;
    cancelTimer?.();
    cancelTimer = null;
  };
  const attempt = async (version: number, signal: AbortSignal, index: number) => {
    const current = () => generation === version && !signal.aborted;
    if (!current()) return;
    try {
      const status = await options.load(signal);
      if (current()) publish({ phase: status.configured ? 'ready' : 'unconfigured', status, error: '' });
    } catch (error) {
      if (!current()) return;
      const failure = classifyFailure(error);
      if (failure.retry && index < retryDelays.length) {
        publish({ ...snapshot, phase: 'checking', error: failure.code });
        cancelTimer = (options.schedule ?? scheduleTimeout)(() => {
          cancelTimer = null;
          void attempt(version, signal, index + 1);
        }, retryDelays[index]);
      } else {
        // A failed GET cannot prove that previously configured service was disabled.
        publish({ ...snapshot, phase: 'error', error: failure.code });
      }
    }
  };
  return {
    getSnapshot: () => snapshot,
    refresh() {
      pause();
      controller = new AbortController();
      publish({ ...snapshot, phase: 'checking', error: '' });
      void attempt(generation, controller.signal, 0);
    },
    pause,
  };
}
