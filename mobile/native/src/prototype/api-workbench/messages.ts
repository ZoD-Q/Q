import { WorkbenchError } from "./core";
import type { VideoJob } from "@xiaoq/shared";

type Translate = (zh: string, en: string) => string;
export function errorMessage(error: unknown, t: Translate): string {
  const code = error instanceof WorkbenchError ? error.code : "REQUEST_FAILED";
  const messages: Record<string, [string, string]> = {
    NETWORK_ERROR: ["连接失败。请检查 Q 服务与网络；提交结果可能尚未确认。", "Could not reach Q. Check the service and your network; a submission may still be unconfirmed."],
    REQUEST_TIMEOUT: ["请求超时。请查询原任务，不要重复创建。", "The request timed out. Check the existing request before creating another."],
    CANCELLED: ["请求已中断，提交结果请在任务记录中确认。", "The request was interrupted. Check your history to confirm its result."],
    INVALID_RESPONSE: ["服务返回的数据无法识别，请刷新查询原任务。", "The service returned an unexpected response. Refresh the existing task."],
    STORAGE_ERROR: ["无法安全保存或读取待确认请求。请勿重复提交，先恢复设备存储访问。", "Cannot safely save or read the pending request. Restore device storage access before submitting again."],
    INSECURE_API_URL: ["Q 服务需要 HTTPS。仅本机开发地址允许 HTTP，请检查服务配置。", "Q requires HTTPS. HTTP is allowed only for local development. Check the service configuration."],
    UNAUTHORIZED: ["登录已过期，请重新登录。待确认任务会保留。", "Your session expired. Sign in again; pending requests are retained."],
    INVALID_CREDENTIALS: ["账号或密码不正确。", "The account or password is incorrect."],
    HANDLE_TAKEN: ["这个账号已被使用，请更换账号或登录。", "This handle is already taken. Choose another or sign in."],
    VALIDATION_ERROR: ["请检查填写内容是否符合要求。", "Check that the fields meet the requirements."],
    RATE_LIMITED: ["请求过于频繁，请稍后再查询。待确认请求已保留。", "Too many requests. Check again later; the pending request is retained."],
    VIDEO_UNAVAILABLE: ["Q 视频服务尚未配置完成，请联系服务管理员。", "The Q video service is not configured yet. Contact the service administrator."],
    VIDEO_CONNECTION_NOT_FOUND: ["连接不存在或不属于当前账号，请刷新连接列表。", "This connection is unavailable for this account. Refresh your connections."],
    VIDEO_CONNECTION_REVOKED: ["连接已撤销，无法继续调用。已有供应商任务不会被取消。", "The connection was revoked. Existing supplier tasks are not cancelled."],
    VIDEO_JOB_NOT_FOUND: ["未找到该账号的任务，请刷新记录。", "No task was found for this account. Refresh your history."],
    IDEMPOTENCY_CONFLICT: ["原请求与当前内容不一致，请保留原任务并联系管理员核对。", "This request differs from the original. Keep the original task and contact the administrator."],
    VIDEO_SUBMISSION_UNKNOWN: ["可灵是否已受理尚未确认。请刷新此任务，不要重新创建。", "Kling acceptance is unconfirmed. Refresh this task; do not create it again."],
    VIDEO_PROVIDER_AUTH: ["可灵未接受凭据，请检查 API Key 与接口区域。", "Kling did not accept the credentials. Check your API key and region."],
    VIDEO_PROVIDER_REJECTED: ["可灵拒绝了请求，请在供应商控制台检查权限、余额和内容要求。", "Kling rejected the request. Check permissions, balance and content requirements in its console."],
    VIDEO_PROVIDER_ERROR: ["可灵服务暂时无法处理，请查询原任务状态。", "Kling could not process this request. Check the original task status."],
    VIDEO_PROVIDER_FAILED: ["可灵生成失败，请在供应商控制台查看详情。", "Kling generation failed. Check the supplier console for details."],
    VIDEO_POLL_UNAVAILABLE: ["暂时无法查询可灵状态，请稍后刷新原任务。", "Kling status is temporarily unavailable. Refresh the original task later."],
    VIDEO_RESULT_UNAVAILABLE: ["可灵结果暂不可用，请稍后刷新或在供应商控制台查看。", "The Kling result is unavailable. Refresh later or check the supplier console."],
    VIDEO_RESULT_URL_UNSUPPORTED: ["视频地址未通过安全检查，暂不能播放。请在可灵控制台查看。", "The video URL did not pass the safety check. View it in the Kling console."],
  };
  const copy = messages[code] ?? ["操作未完成，请稍后查询。若刚提交了任务，请先确认原请求。", "The operation could not finish. Check again later. If you submitted a task, confirm the original request first."];
  return t(copy[0], copy[1]);
}

export function statusLabel(status: VideoJob["status"], t: Translate) {
  const labels: Record<VideoJob["status"], [string, string]> = {
    submitting: ["正在提交", "Submitting"], unknown: ["待确认受理", "Acceptance unknown"], submitted: ["已受理", "Submitted"],
    processing: ["生成中", "Generating"], succeeded: ["已完成", "Completed"], failed: ["生成失败", "Failed"],
  };
  return t(...labels[status]);
}
