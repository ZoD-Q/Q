type Translate = (zh: string, en: string) => string;
export function chatErrorMessage(code: string, text: Translate) {
  switch (code) {
    case 'UNAUTHORIZED': return text('登录已过期，请重新登录后继续。', 'Your session expired. Sign in again to continue.');
    case 'INVALID_CREDENTIALS': return text('账号或密码不正确。', 'The handle or password is incorrect.');
    case 'HANDLE_TAKEN': return text('这个账号已被使用，请换一个。', 'This handle is already in use.');
    case 'AI_NOT_CONFIGURED': return text('服务端还没有配置 DeepSeek，暂时无法开始对话。', 'DeepSeek is not configured on the server yet.');
    case 'AI_AUTH_ERROR': return text('DeepSeek 服务凭据当前不可用，请联系管理员。', 'The DeepSeek service credentials are unavailable. Contact the administrator.');
    case 'AI_QUOTA_EXCEEDED': return text('DeepSeek 账户额度不足，请联系管理员后重试。', 'The DeepSeek account has insufficient credit. Contact the administrator.');
    case 'AI_RATE_LIMITED': case 'AI_BUSY': case 'RATE_LIMITED': return text('请求较多，请稍后再试。', 'Too many requests. Try again shortly.');
    case 'AI_TIMEOUT': case 'REQUEST_TIMEOUT': return text('等待回答超时。已收到的内容保留，可以手动重试。', 'The answer timed out. Received text is preserved; you can retry manually.');
    case 'MESSAGE_TOO_LONG': return text('单条消息最多 12,000 个字符，请缩短后发送。', 'A message can contain up to 12,000 characters. Shorten it and try again.');
    case 'VALIDATION_ERROR': return text('输入内容不符合要求，请检查长度与格式。', 'Check the input length and format.');
    case 'INVALID_RESPONSE': case 'INCOMPLETE_RESPONSE': case 'AI_UPSTREAM_ERROR': return text('回答未完整返回。已收到的内容保留，请手动重试。', 'The answer did not finish. Received text is preserved; retry manually.');
    case 'RESPONSE_TOO_LARGE': return text('回答超出本次接收范围，已保留收到的部分。', 'The answer exceeded this session’s receive limit. Received text is preserved.');
    case 'STORAGE_ERROR': return text('无法安全保存登录状态，请重试。', 'Unable to securely save the session. Try again.');
    case 'LOGOUT_UNCONFIRMED': return text('已退出本机，服务端注销尚未确认。', 'Signed out locally; server-side revocation is not confirmed.');
    case 'INSECURE_API_URL': return text('服务地址配置不安全，请使用 HTTPS 或本地开发地址。', 'Use an HTTPS API URL or an approved local development address.');
    case 'CANCELLED': return text('已停止接收回答。', 'Stopped receiving the answer.');
    case 'PLUGIN_AUTH_REQUIRED': return text('插件需要授权，请到“我的连接”完成授权后继续。Q 登录仍然有效。', 'Authorize the plugin under My connections. Your Q session is still valid.');
    case 'PLUGIN_RECONFIRM_REQUIRED': return text('插件内容已变化，请到“我的连接”检查更新。', 'The plugin changed. Review its update under My connections.');
    case 'PLUGIN_TURN_LIMIT': return text('这一轮已使用 8 次工具结果，请开始新的一轮。', 'This turn reached eight tool results. Start a new turn.');
    case 'PLUGIN_RESULT_UNAVAILABLE': return text('这次工具结果尚不可用于续答，请先查询调用状态。', 'This tool result is not ready for continuation. Check the invocation status.');
    default: return text('暂时无法连接 Q 服务，请检查网络或稍后重试。', 'Unable to reach Q. Check the connection or try again later.');
  }
}
