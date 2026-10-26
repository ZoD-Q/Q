import type { ChatMessage } from './state-model';

export type MascotState = 'ready' | 'thinking' | 'streaming' | 'interrupted' | 'paused' | 'offline' | 'error' | 'complete';
type LocalizedText = { zh: string; en: string };
export type MascotPresentation = {
  state: MascotState;
  title: LocalizedText;
  detail: LocalizedText;
  busy: boolean;
};
export type MascotPresentationInput = {
  phase: 'idle' | 'waiting' | 'thinking' | 'responding';
  /** The latest message in the selected conversation, not a historical assistant. */
  message?: ChatMessage;
  authBusy?: boolean;
  historyBusy?: boolean;
  historyError?: string;
  statusPhase?: 'checking' | 'ready' | 'unconfigured' | 'error';
  statusError?: string;
  messageError?: string;
  authError?: string;
  hasSession?: boolean;
};

const copy = (state: MascotState, zh: string, en: string, detailZh: string, detailEn: string, busy = false): MascotPresentation => ({
  state, title: { zh, en }, detail: { zh: detailZh, en: detailEn }, busy,
});
const interrupted = () => copy('interrupted', '回答已中断', 'Answer interrupted',
  '已收到的内容保留。你可以手动重试回答。', 'Received text is preserved. You can retry the answer manually.');
const stopped = () => copy('paused', '已停止', 'Stopped',
  '已停止接收，内容保留。重试会重新生成回答。', 'Receiving has stopped; the text is preserved. Retrying generates a new answer.');

function failure(code: string): MascotPresentation {
  switch (code) {
    case 'NETWORK_ERROR':
      // A failed transport does not establish that the device itself is offline.
      return copy('offline', '连接异常', 'Connection problem',
        '暂时无法连接小Q，请检查网络后重试。已收到的内容保留。',
        'Could not reach Q. Check your connection and retry. Received text is preserved.');
    case 'INTERRUPTED': case 'INCOMPLETE_RESPONSE':
      return interrupted();
    case 'CANCELLED':
      return stopped();
    case 'AI_TIMEOUT': case 'REQUEST_TIMEOUT':
      return copy('interrupted', '等待超时', 'Response timed out',
        '这次等待已结束，已收到的内容保留。可以手动重试。',
        'The wait has ended. Received text is preserved; you can retry manually.');
    case 'UNAUTHORIZED':
      return copy('paused', '请重新登录', 'Sign in again',
        '登录已过期，重新登录后再继续。', 'Your session expired. Sign in again to continue.');
    case 'HISTORY_SAVE_FAILED': case 'HISTORY_SAVE_PENDING':
      return copy('error', '历史尚未同步', 'History not synced',
        '请先重试同步，再继续发送。', 'Retry history sync before sending another message.');
    case 'AI_NOT_CONFIGURED': case 'AI_AUTH_ERROR': case 'AI_QUOTA_EXCEEDED':
      return copy('error', '对话暂不可用', 'Chat unavailable',
        '对话服务需要处理，请稍后重试或联系支持。',
        'The chat service needs attention. Try later or contact support.');
    case 'AI_RATE_LIMITED': case 'AI_BUSY': case 'RATE_LIMITED':
      return copy('paused', '请稍后再试', 'Try again shortly',
        '当前请求较多，稍等片刻后手动重试。',
        'The service is busy. Wait a moment, then retry manually.');
    case 'PLUGIN_AUTH_REQUIRED': case 'PLUGIN_RECONFIRM_REQUIRED':
      return copy('paused', '插件需要处理', 'Plugin needs attention',
        '请在“我的连接”完成授权或检查更新，再继续。',
        'Authorize or review the plugin under My connections before continuing.');
    case 'PLUGIN_RESULT_UNAVAILABLE': case 'PLUGIN_TURN_LIMIT':
      return copy('paused', '暂时无法续答', 'Cannot continue yet',
        '请查看插件提示；工具不会自动重新执行。',
        'Review the plugin notice. Tools will not run again automatically.');
    case 'MESSAGE_TOO_LONG': case 'VALIDATION_ERROR': case 'EMPTY_MESSAGE':
      return copy('paused', '请检查输入', 'Check your message',
        '调整文字内容或长度后再发送。', 'Review the message content or length, then send again.');
    default:
      return copy('error', '暂时无法回答', 'Could not answer',
        '这次请求未完成。已收到的内容保留，请查看提示后重试。',
        'This request did not finish. Received text is preserved; review the notice before retrying.');
  }
}

/** Presentation only: never starts, retries, or interprets configuration as live health. */
export function getMascotPresentation(input: MascotPresentationInput): MascotPresentation {
  // Public configuration checks and old errors must not replace a live request.
  if (input.phase === 'waiting') return copy('thinking', '正在准备回答', 'Preparing an answer',
    '正在保存问题并等待服务响应。', 'Saving your question and waiting for the service.', true);
  if (input.phase === 'thinking') return copy('thinking', '思考中', 'Thinking',
    '小Q正在梳理你的问题。', 'Q is working through your question.', true);
  if (input.phase === 'responding') return copy('streaming', '正在回答', 'Answering',
    '正在接收回答，你可以随时停止。', 'Receiving the answer. You can stop at any time.', true);

  // A new blocked action or account transition is more relevant than an old answer.
  if (input.authBusy) return copy('thinking', '正在恢复登录', 'Restoring your session',
    '请稍候，草稿会保留。', 'Please wait. Your draft is preserved.', true);
  if (input.historyBusy) return copy('thinking', '正在同步对话', 'Syncing conversations',
    '同步完成后即可继续。', 'You can continue when sync finishes.', true);
  if (input.authError) return failure(input.authError);
  if (input.messageError && input.messageError !== 'AI_STATUS_CHECKING') return failure(input.messageError);
  // An unresolved history write/read can block the next request even after the
  // displayed answer completed; surface its recovery before any old outcome.
  if (input.historyError) return failure('HISTORY_SAVE_PENDING');

  const message = input.message?.role === 'assistant' ? input.message : undefined;
  if (message) {
    if (message.errorCode === 'INTERRUPTED') return interrupted();
    // The card owns live invocation status; this message alone cannot prove that
    // it is still awaiting confirmation or that the business action succeeded.
    if (message.status === 'tool') return copy('paused', '查看插件状态', 'Review plugin status',
      '请查看插件卡片中的状态与可用操作。',
      'Review the status and available actions in the plugin card.');
    if (message.status === 'cancelled') return stopped();
    if (message.status === 'error') return failure(message.errorCode ?? 'AI_UPSTREAM_ERROR');
    if (message.status === 'pending' || message.status === 'streaming') return interrupted();
    if (message.status === 'incomplete' || (message.finishReason && message.finishReason !== 'stop')) {
      return copy('interrupted', '回答未完整结束', 'Answer incomplete',
        message.finishReason === 'length' ? '这次回答已达长度上限，已收到的内容保留。' : '这次回答没有完整返回，已收到的内容保留。',
        message.finishReason === 'length' ? 'This answer reached its length limit. Received text is preserved.' : 'This answer did not finish. Received text is preserved.');
    }
    if (message.status === 'complete' && message.content.trim()) return copy('complete', '回答完成', 'Answer complete',
      '可以继续提问，或开始新的话题。', 'Ask a follow-up or start a new topic.');
  }

  if (input.statusPhase === 'checking') return copy('thinking', '正在准备对话', 'Preparing chat',
    '正在检查对话配置，请稍候。', 'Checking the chat configuration. Please wait.', true);
  if (input.statusPhase === 'unconfigured') return failure('AI_NOT_CONFIGURED');
  if (input.statusPhase === 'error') {
    if (input.statusError === 'NETWORK_ERROR') return failure('NETWORK_ERROR');
    return copy('error', '连接检查未完成', 'Connection check failed',
      '暂时无法检查对话配置，可以手动重新检查。',
      'Could not check the chat configuration. You can check again manually.');
  }
  return copy('ready', '小Q在这里', 'Q is here',
    input.hasSession === false ? '登录后，我们就可以开始聊了。' : '说说你的想法，我们一起想想。',
    input.hasSession === false ? 'Sign in when you are ready to chat.' : 'Share a thought. We can work through it together.');
}
