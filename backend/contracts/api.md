# 小Q API v1 — implementation contract

Local API: http://127.0.0.1:8787. JSON UTF-8, snake_case fields. ISO 8601 UTC timestamps, UUID IDs. Error responses: `{ "error": { "code": "...", "message": "..." } }`.
Authenticated endpoints require `Authorization: Bearer <opaque token>`; sessions expire and can be revoked. No token in URLs or logs. Only identity owns sessions; profiles owns preferences; ledger owns wallet writes. Financial amounts are integer minor units: 100 = 1.00 Q, currency QDC, always demo.

## Endpoints

- `GET /health` → `{status:"ok", mode:"demo"}`; verify DB connectivity.
- `POST /v1/auth/register` body `{handle,password,display_name}` → 201 `{token,user}`. Handle normalized lowercase ASCII `[a-z0-9_]{3,24}`; `xiaoq` is reserved for the system. Password 10–128 characters; display_name 1–40 chars. Creates profile, wallet and balanced 100000 minor-unit welcome credit atomically. All data is simulated.
- `POST /v1/auth/login` body `{handle,password}` → `{token,user}`. Generic invalid-credentials errors.
- `POST /v1/auth/logout` → 204; revoke current session.
- `GET /v1/me` → User.
- `PATCH /v1/me` body partial `{display_name,avatar,bio,theme,locale}` → User. bio ≤160 chars, validated enums below. Cannot change handle/id/balance/roles.
- `GET /v1/users/lookup?handle=lin` → Recipient, exact normalized handle; 404 if absent. Authenticated. Returns no private preferences or credentials.
- `GET /v1/wallet` → Wallet.
- `GET /v1/wallet/transactions` → `{items: LedgerTransaction[]}` newest first, limit 50; exclusively current user's entries.
- `POST /v1/wallet/transfers` body `{recipient_handle,amount_minor,memo,idempotency_key}` → TransferResponse. amount 1–100000000 minor units; memo ≤80 chars; UUID idempotency_key scoped to sender. Same key+same payload replays original transfer, different payload returns 409 IDEMPOTENCY_CONFLICT. Self-transfer rejected. Both user wallets locked in deterministic order in one transaction; insufficient balance rejects without any entries. Successful transactions append two balanced entries and update cached balances atomically.

## Shapes

Machine-readable shapes are authoritative in repository-relative `backend/contracts/openapi.json`. From `mobile/`, run `npm run api:generate` to update `shared/src/generated.ts`; index.ts exposes named aliases. Do not edit generated types by hand. This document defines behavioral rules alongside that schema. User theme: light/dark/warm (default warm); locale: zh-CN/en (default zh-CN); avatar: orbit/leaf/spark/wave (default orbit). Wallet `{account_id,balance_minor,currency:"QDC",mode:"demo"}`. LedgerTransaction `{id,kind:"welcome"|"transfer",direction:"in"|"out",amount_minor,counterparty_handle,counterparty_name,memo,created_at}`. Welcome counterparty handle `xiaoq`, name `小Q 演示金`.

Expected errors: 400 VALIDATION_ERROR, 401 UNAUTHORIZED / INVALID_CREDENTIALS, 404 USER_NOT_FOUND, 409 HANDLE_TAKEN / INSUFFICIENT_FUNDS / IDEMPOTENCY_CONFLICT / SELF_TRANSFER, 429 RATE_LIMITED, 500 INTERNAL_ERROR. Clients should localize codes and show safe fallback messages.

## Local demo bootstrap

Explicit `Q_SEED_DEMO=true` enables idempotent creation of `kai` and `lin`, password `Qdemo12345!`, each with 1000.00 Q welcome funds. These publicly documented credentials are only for local demonstration. This release never connects to real payment providers. No endpoint edits balances directly or turns demo balances into real assets.

## Acceptance

Register/login/logout and profile persistence; cross-account access isolation; theme/locale enum validation; integer amount validation; one transfer shows debit/credit histories; repeat request creates no extra entries; changed-payload retry rejected; concurrent sends cannot overspend; failed transfer creates no one-sided debit; ledger entries sum to zero including the system account; data survives backend restart.

## Personal video API workbench

Opt-in real supplier requests are separate from simulated QDC. Every video endpoint uses the existing identity bearer session; ownership is always derived server-side. No provider credential is returned. No ledger charge, public indexing, MCP discovery, or media upload is performed.

- `GET /v1/video/connections` → `{items: VideoConnection[]}`.
- `POST /v1/video/connections` → 201 `VideoConnection`, body `{name,region,api_key}`. Region `cn|global`, fixed official Kling hosts; no arbitrary endpoint. Saving encrypts credentials and does not prove provider authorization. Name ≤48 chars, API key ≤512.
- `DELETE /v1/video/connections/{id}` → 204. Revoke and erase encrypted credentials; history stays. Prevents subsequent credential use, but an already-started provider request may finish. This does not cancel supplier generation or refund charges.
- `GET /v1/video/jobs` → `{items: VideoJob[]}`, latest owned jobs.
- `POST /v1/video/jobs` → 202 new job or 200 replay. Body `{connection_id,prompt,model_name,mode,duration,aspect_ratio,idempotency_key}`. Initial adapter: `kling-v2-6`, `pro` (provider `sound: off`), duration strings `5|10`, ratios `16:9|9:16|1:1`, prompt 1–2500 chars, UUID idempotency key.
- `GET /v1/video/jobs/{id}` → `VideoJob`. Refresh provider status when appropriate; uncertain submissions query their original external task ID and never create again.

A durable owner-scoped idempotency record is committed before any supplier POST. Concurrent same-key requests return the same job; changed payload returns 409. Unknown transport/provider outcomes are represented as `unknown`, not a safe-to-retry failure. Supplier errors are sanitized codes, never raw bodies or credentials. If the client loses the Q response, it loads saved history and reuses its original key when recovering the same request, not a fresh billable POST.

Connection and job schemas are in OpenAPI. Status: `submitting|unknown|submitted|processing|succeeded|failed`. Nullable `provider_task_id`, `video_url`, `error_code`. Result media is a validated supplier HTTPS URL with supplier retention/expiry; Q does not guarantee permanent storage. Credentials are authenticated-encrypted under server `Q_VIDEO_ENCRYPTION_KEY` (standard Base64 of 32 random bytes), bound to owner and connection. Missing key fails closed for credential/network operations (`503 VIDEO_UNAVAILABLE`). All authenticated history remains owner-scoped.

Errors include 404 `VIDEO_CONNECTION_NOT_FOUND`/`VIDEO_JOB_NOT_FOUND`, 409 `VIDEO_CONNECTION_REVOKED`/`IDEMPOTENCY_CONFLICT`, 429 `RATE_LIMITED`, and the usual validation/authentication errors. `VIDEO_SUBMISSION_UNKNOWN` in a job requires checking the existing supplier task, never blind resubmission. HTTP timeouts, bounded response bodies and disabled redirects keep provider credentials on fixed intended origins.

## DeepSeek text conversations

`GET /v1/ai/status` is public and returns `{configured, models:[{id,name}]}` only. `configured` means a server key exists, not that a paid provider request has succeeded. Allowed IDs are `deepseek-flash` and `deepseek-v4-pro`; the UI defaults to Flash. No key fragments, upstream headers or environment diagnostics are exposed.

`POST /v1/ai/chat` requires the existing Q Bearer session. Body is `{model,thinking,messages:[{role:"user"|"assistant",content}]}`. Unknown fields, client system/tool roles, empty messages, unsupported models, over 40 messages, over 12000 Unicode characters per message, over 24000 total characters or a non-user final message are rejected. The route body limit is 128 KiB. The server supplies the system prompt, provider address, key and output budget; clients cannot override them.

A successful local admission opens `text/event-stream`. These are SSE `event:` names and JSON `data:` bodies (the JSON has no `type` field):

- `status`: `{phase:"thinking"|"responding"}`. Raw reasoning text is not forwarded.
- `delta`: `{text}`. Append in order; a large provider delta is split at UTF-8 character boundaries into at most 8 KiB text segments, keeping public frames below 64 KiB after JSON escaping.
- `done`: `{model,finish_reason,usage?}`. Usage, when present, has `prompt_tokens`, `completion_tokens`, `total_tokens` and is a request total, not a per-chunk increment. Only `stop` with a nonempty answer is complete. `length` or filtering means an incomplete answer. Unsupported/aborted provider termination can instead become a safe terminal error.
- `error`: `{code,message}`. Terminal, never followed by `done`. The client localizes the code and does not display raw provider bodies.

Local authentication/configuration/validation/admission failures return normal HTTP JSON errors before SSE. Provider connection or HTTP failures happen inside the response body and are terminal SSE errors even when the HTTP status is 200. EOF without a terminal success event is incomplete. Keep-alive comment frames are not answer content. The client retains partial answers after interruption; retries are explicit and do not duplicate the user message or include failed assistant text as model history.

Codes include 503 `AI_NOT_CONFIGURED`, 429 `AI_BUSY` / `AI_RATE_LIMITED`, and existing 400 `VALIDATION_ERROR` / 401 `UNAUTHORIZED`. Stream errors include `AI_AUTH_ERROR`, `AI_QUOTA_EXCEEDED`, `AI_UPSTREAM_ERROR`, `AI_TIMEOUT`; provider errors contain no secrets or raw diagnostic bodies.

Limits: one admitted request per Q user, four globally, ten admissions per user per minute; counters are process-local. Provider connect timeout 10s, idle timeout 60s, total deadline 180s. Output text is capped at 1 MiB, upstream raw data at 8 MiB and each upstream frame at 256 KiB. Output tokens are capped at 4096 normally or 8192 with thinking. The client allows 190s total, 40s without incoming bytes, 2 MiB response bytes, and 64 KiB per public SSE frame; server keep-alives keep an active thinking request alive.

The response body owns the upstream future/response and concurrency permit. Client cancellation/drop stops polling and releases these resources; there is no detached generation task or automatic retry. This does not promise provider refunds or zero usage after cancellation. Chat requests do not write wallet entries or persist conversation text. Account registration still follows the existing identity/profile/demo-wallet transaction.

The app uses the shared Q session store: native SecureStore, web memory only, serialized writes, guarded authentication results, conditional clearing and change notifications. A snapshot revision prevents delayed `/me` from restoring a logged-out session. Account changes and logout cancel in-flight chat and clear client conversation history, including hidden pages and sidebar titles.
