# 小Q API v1 — implementation contract

Local API: http://127.0.0.1:8787. JSON UTF-8, snake_case fields. ISO 8601 UTC timestamps, UUID IDs. Error responses: `{ "error": { "code": "...", "message": "..." } }`.
Authenticated endpoints require `Authorization: Bearer <opaque token>`; sessions expire and can be revoked. No token in URLs or logs. Only identity owns sessions; profiles owns preferences; ledger owns wallet writes. Financial amounts are integer minor units: 100 = 1.00 Q, currency QDC, always demo.

## MCP plugins (0.4)

All plugin routes except status, CIMD and the browser OAuth callback require Q Bearer identity. IDs are owner scoped. Remote tokens never appear in client responses.

| Route | Behavior |
| --- | --- |
| `GET /v1/plugins/status` | Availability, OAuth configuration and protocol version only |
| `POST /v1/plugins/discover` | `{entry,kind?}`; default `auto`, or explicit card/catalog/page/domain; candidates expire after 10 minutes |
| `GET/POST /v1/plugins/connections` | List personal connections / add `{discovery_id,candidate_id}` |
| `GET/DELETE /v1/plugins/connections/{id}` | Inspect / disconnect and erase the connection's tokens |
| `POST …/{id}/refresh`, `POST …/{id}/accept-update` | Detect changes; inspect pending details before accepting `{revision}` |
| `GET …/{id}/tools`, `resources`, `prompts` | Runtime methods under current identity and capabilities |
| `POST …/{id}/resources/read`, `prompts/get` | Standard MCP results; resource URI is a parameter, never an arbitrary host fetch |
| `POST …/{id}/oauth/start` | Returns attempt ID, authorization URL and expiry; PKCE/state/CIMD |
| `GET /v1/plugins/oauth/attempts/{id}` | Owner's authorization status, without codes or tokens |
| `POST /v1/plugins/invocations` | Persist `{connection_id,tool_name,arguments,idempotency_key}` without executing |
| `GET /v1/plugins/invocations?connection_id=…` | Latest 50 owned records, optionally filtered; recover across restarts |
| `GET …/invocations/{id}` | Inspect saved outcome without replaying the tool |
| `POST …/invocations/{id}/confirm` | `{confirmed:true}`; atomically claims once before sending |
| `POST …/invocations/{id}/cancel` | Cancels a proposal that has not started; never promises rollback |

Automatic discovery selects well-known Catalog discovery only for a bare domain. A full URL is fetched at that exact path and query, then classified by the actual Card/Catalog media type or static page discovery links. Card and Catalog responses already fetched for classification are reused; an unrecognized specific URL never falls back to a guessed whole-domain address. Stored discovery records retain the resolved card/catalog/page/domain kind, so this extension needs no database migration. Explicit kinds retain their previous behavior.

Candidates, connections, pending candidate details and invocations include nullable `owner_name`, derived from the Card's optional `_meta["com.kaicloudpay.q/owner"].name`. This is a publisher-supplied display label, not verified ownership, a Q user identity or an authorization grant. Valid labels contain 1–80 Unicode characters after trimming, with no control or bidi direction/override/isolate characters. Missing or malformed optional owner metadata yields `null`; it does not block an otherwise valid standard Card. Other metadata is preserved. Adding a connection cannot override the publisher's owner through the add request. Changes to the Card still follow the existing explicit update-review flow.

Invocation states: `awaiting_confirmation / running / succeeded / tool_error / unknown / cancelled / expired / input_required / failed`. Tool `isError:true` remains a tool error. Input-request interaction is unsupported. Reusing an owner/idempotency key with identical payload returns the original proposal; a different payload conflicts. `running / unknown` cannot trigger another upstream execution, including after disconnection or restart. Lists contain summaries with `result:null`; get one record to read its full result. Immutable connection snapshots supply the title, declared owner, Card, endpoint and revision shown during confirmation. Legacy snapshots without declared-owner metadata return `owner_name:null` and are not rewritten.

Explicit OAuth reauthorization increments the connection revision and cancels older awaiting proposals. Model continuation refuses previous-revision results. Owner storage limits: 100 saved connections, 5,000 invocation records and 64 MiB JSON budget including reservations for unfinished/unknown results. New proposals return `409 PLUGIN_STORAGE_LIMIT` at the limit, while existing-key recovery, reads and confirmation remain available. Unknown records and idempotency tombstones are not deleted. Discoveries are capped at 20 unexpired records/owner with 512 KiB candidate data each, and expired discoveries are cleaned on the next discovery; OAuth caps each connection at 20 unexpired attempts and clears expired attempts on a new start. There is no user-facing history-archiving flow yet.

Public network calls require HTTPS and revalidate every redirect and DNS resolution, pin permitted addresses, ignore environment proxies and disable automatic retries. Credential-bearing POST requests never follow redirects. OAuth binds issuer, resource, state, redirect, PKCE and scopes, encrypts credentials and rechecks connection changes. Remote 401/403 becomes `409 PLUGIN_AUTH_REQUIRED`; only Q session failure is `401 UNAUTHORIZED`.

`POST /v1/ai/chat` accepts optional `plugin_connection_id` and `tool_invocation_ids` (up to eight distinct UUIDs). Plugin mode requires `thinking:false`. The server loads actual tools, then emits SSE `tool_proposal` containing `{invocation_id,connection_id,tool_name,arguments}`, followed by `done.finish_reason=tool_calls`; no text is required. This persists a proposal only. After separate confirmation, continuation accepts only saved IDs, validates owner/connection/completion and reads the stored results. Clients cannot supply tool-result bodies. Images, blobs and Apps HTML are excluded from the text model context.

The native viewer displays bounded, signature/dimension-verified JPEG, PNG and WebP results. It never executes HTML, scripts or `ui://` resources. Full Apps sandboxing, input-request interaction, background tasks and a public index are not implemented. See [protocol support](../docs/reference/mcp-2026-wire-source.md).

## Endpoints

- `GET /health` → `{status:"ok", mode:"demo"}`; verify DB connectivity.
- `POST /v1/auth/register` body `{handle,password,display_name}` → 201 `{token,user}`. Handle normalized lowercase ASCII `[a-z0-9_]{3,24}`; `xiaoq` is reserved for the system. Password 10–128 characters; display_name 1–40 chars. Creates profile, wallet and balanced 100000 minor-unit welcome credit atomically. All data is simulated.
- `POST /v1/auth/login` body `{handle,password}` → `{token,user}`. Generic invalid-credentials errors.
- `POST /v1/auth/logout` → 204; revoke current session.
- `POST /v1/account/deletions` → completed deletion receipt after password verification and explicit confirmation; `POST /v1/account/deletions/status` recovers only that receipt with the original secret capability after sessions are revoked. Both are `no-store`. See [account lifecycle and retained records](account-lifecycle.md).
- `GET /v1/me` → User.
- `PATCH /v1/me` body partial `{display_name,avatar,bio,theme,locale}` → User. bio ≤160 chars, validated enums below. Cannot change handle/id/balance/roles.
- `GET /v1/users/lookup?handle=lin` → Recipient, exact normalized handle; 404 if absent. Authenticated. Returns no private preferences or credentials.
- `GET /v1/wallet` → Wallet.
- `GET /v1/wallet/transactions` → `{items: LedgerTransaction[]}` newest first, limit 50; exclusively current user's entries.
- `POST /v1/wallet/transfers` body `{recipient_handle,amount_minor,memo,idempotency_key}` → TransferResponse. amount 1–100000000 minor units; memo ≤80 chars; UUID idempotency_key scoped to sender. Same key+same payload replays original transfer, different payload returns 409 IDEMPOTENCY_CONFLICT. Self-transfer rejected. Both user wallets locked in deterministic order in one transaction; insufficient balance rejects without any entries. Successful transactions append two balanced entries and update cached balances atomically.

## Shapes

Machine-readable shapes are authoritative in repository-relative `backend/contracts/openapi.json`. From `mobile/`, run `npm run api:generate` to update `shared/src/generated.ts`; index.ts exposes named aliases. Do not edit generated types by hand. This document defines behavioral rules alongside that schema. User theme: light/dark/warm (default warm); locale: zh-CN/en (default zh-CN); avatar: orbit/leaf/spark/wave (default orbit). Wallet `{account_id,balance_minor,currency:"QDC",mode:"demo"}`. LedgerTransaction `{id,kind:"welcome"|"transfer",direction:"in"|"out",amount_minor,counterparty_handle,counterparty_name,memo,created_at}`. Welcome counterparty handle `xiaoq`, name `小Q 演示金`.

Expected errors: 400 VALIDATION_ERROR, 401 UNAUTHORIZED / INVALID_CREDENTIALS, 404 USER_NOT_FOUND, 409 HANDLE_TAKEN / INSUFFICIENT_FUNDS / IDEMPOTENCY_CONFLICT / SELF_TRANSFER, 429 RATE_LIMITED, 500 INTERNAL_ERROR. Clients should localize codes and show safe fallback messages.

Account lifecycle additionally defines `ACCOUNT_DELETION_NOT_FOUND`, `ACCOUNT_BUSY`,
`ACCOUNT_DELETED`, and `ACCOUNT_PROTECTED`; basic local content rules return
`422 CONTENT_BLOCKED`. Suspended/deleted accounts cannot create or use sessions.
New social interaction with an unavailable peer returns `SOCIAL_ACCOUNT_UNAVAILABLE`.
User-initiated deletion retains immutable demo-ledger amounts, entries and memo text;
the original recipient-handle digest preserves existing transfer replay without
reassigning an old handle to a new user. New transfers require active identities.
These retention limits are described in the lifecycle contract and deletion UI.

Register, login and account-deletion endpoints share a per-client-source
30 requests/minute limit. Forwarded client identity is accepted only from explicitly
trusted proxies; malformed or untrusted headers fall back to the TCP source.
See [proxy configuration](../docs/trusted-proxy.md). Account-specific password
limits and global password-computation concurrency also apply.

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

Manual GET of a completed job may refresh its expiring signed media URL under the same 3-second poll guard. Only the latest database poll claim may update the result. A failed refresh preserves completed state and the last safe URL while recording `VIDEO_POLL_UNAVAILABLE`; unavailable startup configuration leaves saved completed history readable. An early inconclusive lookup does not suppress a later definitive rejection from the original POST while the reservation still has no provider task ID.

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

## Social conversations

Authenticated friends, one-to-one messages, explicit ephemeral opening, intimacy, relationship confirmation and reports are specified in [Social API](social.md). They share Q identity but never share AI conversation content or provider credentials.
