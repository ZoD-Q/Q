import { chatErrorMessage } from '../ai-chat/messages';

export function accountErrorMessage(code: string, text: (zh: string, en: string) => string) {
  switch (code) {
    case 'REQUEST_TIMEOUT': return text('账号请求超时，保存结果尚未确认。请重新读取资料后再决定是否修改。', 'The account request timed out. Reload your profile to check whether changes were saved.');
    case 'INVALID_RESPONSE': return text('账号服务返回了无法识别的结果，请重新读取资料确认。', 'The account service returned an invalid response. Reload your profile to confirm its state.');
    case 'STORAGE_ERROR': return text('无法读写本机登录存储，请重试；已失效的会话不会继续使用。', 'Unable to access local session storage. Retry; invalidated sessions will not be reused.');
    default: return chatErrorMessage(code, text);
  }
}
