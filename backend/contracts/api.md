# 小Q API v1 — implementation contract

Local API: http://127.0.0.1:8787. JSON UTF-8, snake_case fields. ISO 8601 UTC timestamps, UUID IDs. Error responses: `{ "error": { "code": "...", "message": "..." } }`.
Authenticated endpoints require `Authorization: Bearer <opaque token>`; sessions expire and can be revoked. No token in URLs or logs. Only identity owns sessions; profiles owns preferences; ledger owns wallet writes. Financial amounts are integer minor units: 100 = 1.00 Q for QDC or HK$1.00 for the separate bank simulation ledger; both are always demo.

## Payment wallet (default disabled)

See [payment contract](payments.md) for `/v1/payments` capabilities, independent HKD wallet, CNY quotes, orders, recovery, signed notification hints and maker/checker approval. These funds never mix with QDC or bank simulations. Missing merchant/rate/policy configuration disables new funding. Source implementation and isolated tests do not mean deployment, provider activation or real settlement.

The [operator contract](payment-operations.md) adds authenticated payment review, full external-refund evidence workflows, immutable HKD reversal journals and source-file reconciliation. The [FX contract](../src/payments/FX.md) adds explicit opt-in collection of versioned ECB reference evidence while preserving frozen quotes. Neither feature authorizes automatic payouts or bank FX conversion.

## Shared public news cache

`GET /v1/market-data/news` anonymously reads only the durable Q cache for fixed news topics. Requests do not trigger provider calls or accept arbitrary URLs. Publication/index timestamps, collection times, source-specific failures and stale states remain distinct. Central-bank releases do not replace the coverage of GDELT topics. See [news contract](market-news.md).

## Built-in bank plugins and HKD wallet

See [banking contract](banking.md). `GET /v1/banking/wallet`, `POST /v1/banking/connect`, and paginated `GET /v1/banking/transactions` / `entries` reuse Q identity and return `no-store`. The first explicit addition issues HKD 100,000 to each new simulated account; retries never refill balances. Existing QDC routes are unchanged.

Connections and invocations now return server-controlled `connection_kind: remote_mcp | bank_demo` and nullable `builtin_service_id`. Only bank_demo uses exact `urn:q:bank-demo:<bank_id>` identities and `auth_status: anonymous`; this is a Q first-party runtime, not bank OAuth or a remote MCP server. Remote discovery/addition cannot request this kind or accept a URN. The three built-in tools use the existing proposal/confirm/result endpoints. Confirmation, balanced HKD posting and its invocation result commit in one PostgreSQL transaction. A lost response is recovered by reading the original invocation; the model never confirms.

AI display history accepts optional bank plugin identity fields and boolean `bankCommand` message metadata for recovery. These display fields do not select the server execution runtime or authorize a transfer.

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

`POST /v1/ai/chat` accepts optional `plugin_connection_id` and `tool_invocation_ids` (up to eight distinct UUIDs). Plugin mode requires `thinking:false`. The server loads actual tools, then emits SSE `tool_proposal` containing `{invocation_id,connection_id,tool_name,arguments}`, followed by `done.finish_reason=tool_calls`; no text is required. By default this persists a proposal only. Continuation accepts only saved IDs, validates owner/connection/completion and reads the stored results. Clients cannot supply plugin-tool result bodies. Images, blobs and Apps HTML are excluded from the text model context.

New hosts advertise optional `automatic_readonly_tools:true` in `GET /v1/ai/status`. Only after observing that capability may a client opt in with the same boolean on a plugin chat request; missing means false, and true without a selected plugin is invalid. The host may then execute only server-owned `bank_demo` `bank_balance` / `bank_transactions` after persisting the invocation and rechecking its account, connection revision, immutable schema, expiry and exact tool under the transaction locks. Transfers and all untrusted remote tools still await explicit confirmation; names, descriptions and `readOnlyHint` cannot select this policy. Automatic reads do not populate `confirmed_at` as if the user had pressed confirmation.

Only a completed automatic read adds `automatic:true` to the `tool_proposal` event. This is a hint to GET the saved invocation, not a result body or execution permission. The client verifies ID, connection, `succeeded|tool_error` and non-null result, durably saves the conversation and continues the model once for the current active request. Cancelling, account changes, failed storage or unknown results stop automatic continuation; recovery is explicit and never confirms again. Eight completed result IDs also exhaust the server's preparation budget: a ninth proposal returns `PLUGIN_TURN_LIMIT` before creation or execution. Old clients keep the confirmation flow; new clients omit the opt-in flag for old servers and present the same compact manual flow.

Invocation responses additionally expose optional nullable `tool_title` and `input_schema` from the immutable prepared tool snapshot for readable confirmation labels. These display fields cannot change permissions or hide actual arguments. Technical transport data remains available for explicit advanced inspection; ordinary chat uses business summaries, natural results and native media.

The native viewer displays bounded, signature/dimension-verified JPEG, PNG and WebP results. It never executes HTML, scripts or `ui://` resources. Full Apps sandboxing, input-request interaction, background tasks and a public index are not implemented. See [protocol support](../docs/reference/mcp-2026-wire-source.md).

## Endpoints

### Insurance integration reservations (2026-10-22)

- `GET /v1/insurance/status`: public, returns `conversation_available:false`, `inquiry_available:false`, `accepts_personal_data:false`.
- `POST /v1/insurance/conversations`: Q Bearer required; body `{message}`. Valid input returns **503 INSURANCE_SUPPORT_UNAVAILABLE**.
- `POST /v1/insurance/inquiries`: Q Bearer required; body `{topic,question}`, topic `coverage|eligibility|claims`. Valid input returns **503 INSURANCE_INQUIRY_UNAVAILABLE**.
- Message/question: trim first, 1–1000 Unicode characters, NUL forbidden; unknown fields or topic are rejected with 400 VALIDATION_ERROR. Missing/invalid/expired identity returns 401 UNAUTHORIZED. Existing 16 KiB body limit applies.
- These are reserved integration boundaries, not a live support system. No conversation IDs, tickets, persistence, provider requests, underwriting or success responses. Do not automatically retry 503. Do not send identity documents, health records or contact details. No user-ID override is accepted.
- The mobile insurance catalogue and question/claims guidance are curated local content. It does not submit inquiries or messages while capabilities are unavailable. A future provider integration must add explicit capability handling, consent, owner isolation, retention and retry semantics before enabling these forms.

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

`GET /v1/ai/status` is public and returns `{configured, models:[{id,name}]}` with optional capability flags `automatic_readonly_tools`, `app_tools_version:1`, `company_research_version:1`, `filing_research_version:1` and, when enabled, `recommendations_version:1`. `configured` means a server key exists, not that a paid provider request has succeeded. Allowed IDs are `deepseek-flash` and `deepseek-v4-pro`; the UI defaults to Flash. No key fragments, upstream headers or environment diagnostics are exposed.

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

## First-party application assistant (version 1)

Only after observing `app_tools_version:1` may a client opt into application tools with `{app_tools_version:1, thinking:false}`. This mode is mutually exclusive with plugin connection, invocation and automatic-read flags. Older requests retain their original behavior; older servers receive none of these new fields. Thinking mode can explain supplied material but does not use these application tools.

After observing the independent optional `company_research_version:1` capability, a new client may also send that flag alongside `app_tools_version:1`. The base application version stays at 1. Without the company flag, the server never advertises or emits company tools and rejects company contexts and unsolicited provider proposals. Null/unknown versions and company opt-in without application mode are invalid. The shared three-result/24,000-character context budget remains unchanged.

- `company_search {query}` searches public global company/listing candidates: trimmed nonempty single-line text, at most 120 Unicode characters, no controls/bidi overrides.
- `company_research {issuerId}` reads covered annual public financial facts. IDs are `sec:` plus exactly ten digits (not all zero), or `wikidata:Q` plus 1–16 digits with no leading zero. IDs come from search results; arbitrary URLs are forbidden.

Global coverage is incomplete. Candidates retain source identity, exchange/listing qualifiers, retrieval timestamps and explicit missing/error states. Name/ticker matches do not authorize issuer merging or establish current listing. Financial facts are distinct from full filing text or risk discussion; preserve period, currency/unit, taxonomy and accession, leave missing values unavailable, and calculate only comparable periods. The server treats results as untrusted public client context, never authoritative account data or permission to trade. This extension requires updated client and server; source implementation alone does not mean deployment.


The server supplies fixed function schemas for `app_info`, `insurance_search`, `insurance_compare`, `market_query` and `app_open` (provider function names use `q_` prefixes). A successful proposal emits SSE `app_tool` with `{name,arguments}`, followed by `done.finish_reason=tool_calls`; at most one proposal per stream. The client validates it again. Insurance reads use the installed public knowledge catalog; market reads use only fixed supported assets, companies and topics. Navigation produces a card requiring a user click, with validated module/filter parameters, never an arbitrary URL. These tools cannot access bank accounts, private chats, payments, credentials or paid video jobs. Existing plugin and business authorization remain separate.

For model continuation, the client may send `app_context:[{name,arguments,result}]`, at most three entries, each result at most 10,000 Unicode characters and results totaling at most 24,000. Every stored call's arguments must match its fixed schema. These are **client-supplied public results, not independently verified by the server**; they enter provider tool messages as untrusted data, never instructions, permissions or authoritative plugin results. Existing 128 KiB request-body and chat-message limits still apply. This endpoint does not persist or execute application calls.

With three results, the server omits tools and requires an answer from available material. Optional `app_final_only:true` similarly disables tools and is valid only in application mode with nonempty context. The client uses it to continue explaining existing results after interruption without repeating a query. Application cycles share a client total deadline and reject repeated calls; cancellation, account changes, history-save failure or changed conversation prevent late execution/continuation. Provider admission limits apply separately to each continuation request.

The first client stores readable public results, source links and times in ordinary assistant history. Navigation cards and resumable structured contexts are session memory only; reopening history never executes queries. Failed/interrupted application turns carry stable client history error labels. With a retained context, an explicit resume explains those results only; after reload, the user can copy the retained readable material into a new question, but a generic retry cannot silently re-query. There is no new database table, migration or financial authority.

## Social conversations

Authenticated friends, one-to-one messages, explicit ephemeral opening, intimacy, relationship confirmation and reports are specified in [Social API](social.md). They share Q identity but never share AI conversation content or provider credentials.


## Account-owned AI history (source implementation, 2026-10-21)

These endpoints require the existing Q Bearer session, scope every read/write to
its active account, and return `Cache-Control: no-store`. They do not invoke a
model or a plugin. Deploy the new migration and client together; previously lost
in-memory history cannot be recovered.

- `GET /v1/ai/conversations?limit=20&cursor=UUID`: summaries
  `{items:[{id,title,revision,updated_at}],next_cursor:UUID|null}`. Limit 1–100;
  stable descending creation-time/UUID order (edits do not move records), cursor exclusive. A null cursor ends pagination.
- `GET /v1/ai/conversations/{id}`: full snapshot
  `{id,title,messages,plugin?,revision,updated_at}`; another account's ID returns
  `404 AI_HISTORY_NOT_FOUND`.
- `POST /v1/ai/conversations/{id}`: `{request_id,expected_revision,title,messages,plugin?}`.
  UUIDs identify the conversation and original save request. Revision 0 creates;
  subsequent writes must match the last known revision. A successful response is
  the full saved snapshot at revision `expected_revision + 1`.

The latest request ID and canonical payload are retained with the snapshot.
Replaying that same ID and payload returns the same snapshot/revision without a
second write. Changed payload with that ID returns `409 AI_HISTORY_REQUEST_REUSED`.
Stale revisions or earlier requests after a newer save return
`409 AI_HISTORY_CONFLICT`; clients must reload or explicitly resolve, never
silently overwrite. Unknown outcomes keep the original request and query/retry
it before starting another save or model request.

Message fields preserve the client's displayed `id`, `role`, `content`, `status`
and optional model, thinking, finish/usage and plugin-card metadata; exact shapes
are in OpenAPI. This is display history, not proof of model usage or permission
to invoke tools. All tool execution still uses the server's owned proposals,
confirmation and saved results. Stored plugin URLs are labels, not fetch targets.

The client saves the prompt and pending answer before opening the model stream,
then saves terminal or interrupted state. Reloaded pending/streaming answers are
shown as interrupted, never as completed. Unacknowledged answer fragments can be
lost on a process crash; persistence does not make a generation run in the
background. Model context selection is separate from full stored history.

Limits are explicit: 100 conversations per account (`409 AI_HISTORY_LIMIT`),
2,000 messages per snapshot, title up to 200 Unicode characters, message content
up to 1 MiB UTF-8, and canonical snapshot up to 4 MiB
(`413 AI_HISTORY_TOO_LARGE`). No silent history truncation. History has no
automatic expiry, is included in ordinary database backups, and online snapshots
are erased with account deletion. Backup retention and deletion reconciliation
remain as described in the account lifecycle contract.

Client compatibility with pre-history servers: only an initial authenticated collection GET `/v1/ai/conversations` returning 404 or 405, before any successful cloud history access, can select explicitly disclosed session-only history. An established cloud-history session never downgrades because of a later failure. Detail 404, POST failures, malformed responses, 401, timeouts and 5xx do not authorize downgrade or discard unresolved writes. Core AI status and streaming remain independent of optional history capability.
# Financial provider compatibility

The authenticated `GET /v1/plugins/financial/providers` returns six fixed profiles by default or with `catalog_version=1`; version 2 also includes Tavily and FRED. Responses include auth modes, configuration flags and current-user connections. `POST /v1/plugins/financial/connections` accepts only `provider_id`, adds or returns the same personal connection and performs no business call. `POST /v1/plugins/connections/{id}/credential` accepts only `secret` for iFinD/Jin10, encrypts it per owner/connection/revision/endpoint, invalidates old proposals and verifies the tool catalog. The saved connection and safe verification status are returned even on upstream failure; secrets are never returned. Do not automatically retry uncertain credential writes.

Connections retain `remote_mcp` with optional `financial_provider_id`; external Card metadata cannot select profiles. iFinD uses the official combined nine-tool service, excluding Kuaicha/Fazhi. Massive exposes search_endpoints and stateless call_api only, excluding query_data and forbidding store_as/api_key/credential-like arguments before preparation and execution. Alpha/Twelve expose explicitly selected research tools; tool schemas always come from runtime discovery. All third-party calls retain proposal/confirmation, stored invocation and bounded continuation; `readOnlyHint` grants no automatic execution.

This isolated compatibility path supports MCP 2025-03-26/2025-06-18/2025-11-25 initialization sessions with a total 30-second catalog/call timeout, bounded bodies/pagination/schemas and no business retries. Unsupported resources/prompts return typed unsupported errors. Ordinary Card/Catalog services retain the 2026 baseline. Twelve uses CIMD; only fixed Massive/Alpha profiles allow public PKCE dynamic registration at their verified official issuers/endpoints. API-key storage needs encryption alone; OAuth still needs public Q hosting. Vendor entitlements and actual business validation remain separate from fixture coverage.

### Research providers and ephemeral FRED (2026-11-08 source)

Internal profiles add `tavily` and `fred` via a new migration. Public connections retain the original six `financial_provider_id` enum values; new providers return null there and a separate optional `research_provider_id`. Both cannot be non-null. This preserves old generic connection decoders and history display projections; older catalog clients still receive six. No external Card or client input may select a trusted profile or custom headers.

Tavily permits only `tavily_search` and `tavily_extract` at its fixed official keyless endpoint. The fixed non-secret access-mode header cannot be sent to other targets. Quota text inside a successful HTTP envelope is classified as failure. Alpha Vantage additionally selects `EARNINGS_CALL_TRANSCRIPT`, `INSIDER_TRANSACTIONS`, `INSTITUTIONAL_HOLDINGS`, still subject to live schemas and change review. Upstream 401 requires authorization; 403 uses `MCP_FORBIDDEN`, 402 `MCP_PAYMENT_REQUIRED`, 429 `MCP_RATE_LIMITED`, without clearing a valid credential on non-auth failures. Known denied requests are failed, while an uncertain dispatched operation remains unknown and is not retried automatically.

FRED requires authenticated dedicated routes:

- `GET /v1/plugins/connections/{id}/fred/tools`: `{connection_revision,items,retention:"ephemeral"}`; reads the current three permitted schemas without saving a tool snapshot.
- `POST /v1/plugins/connections/{id}/fred/query`: `{connection_revision,tool_name,arguments}`; denies unknown fields, validates the live schema, and invokes within the same temporary session. The three names are `fred-search-series`, `fred-get-series-metadata`, `fred-get-series-observations`.
- Success: `{connection_id,connection_revision,tool_name,result,retrieved_at,retention:"ephemeral"}`. Ownership, current revision and revocation are checked before and after upstream work. All responses, including authentication/extraction errors, carry `Cache-Control: no-store` and `Pragma: no-cache`.

Queries, results, returned schemas and body text are never stored in invocation/history/cache/logs or forwarded to the model. Only fixed connection identity, encrypted authorization state/credentials and safe status codes persist. Ordinary tools, proposals, execution, AI plugin mode and history writes reject FRED with `PLUGIN_EPHEMERAL_REQUIRED`. Historical generic plugin snapshots remain saveable even if their old connection is gone. The client discards FRED form/results on background, departure, account change and unmount; explicit query is the business confirmation, with no chat handoff.

Persistent recommendation candidates exclude FRED even when its connection is authorized. Selection also rejects its fixed provider identity and rechecks the owned connection before creating any conversation; stale candidate records cannot introduce a saved FRED continuation. Tavily can use the normal confirmed plugin workflow. Completed filing reads suppress duplicate market-data navigation recommendations, while failed reads do not.

FRED alone uses confidential registration on fixed official endpoints, S256/state and exact issuer/resource `https://mcp.stlouisfed.org/`. Its validated secret is encrypted with the existing OAuth envelope, bound to purpose/owner/connection/revision/issuer/resource, retained through refresh, and cannot be replaced by token-response fields. Public Massive/Alpha clients still require `none`; arbitrary CIMD clients do not gain this exception. The visible temporary-mode notice includes FRED terms and non-endorsement wording. Real FRED account authorization remains separate acceptance work.

### SEC original filing research (2026-11-08 source)

Public `GET /v1/research/filings?issuer_id=sec:0000320193` returns `FilingCatalog`: verified issuer/CIK/name, retrieval time, up to 20 recent supported filings, total and truncation. Supported forms are 10-K/10-Q/20-F/40-F/8-K/6-K and amendments. Source submissions must match the requested CIK; invalid or unsupported records are omitted. Historical SEC archives, non-SEC sources and exhibits are not traversed.

Public `GET /v1/research/filings/{cik}/{accession}?offset=0` verifies the accession's membership in that issuer's recent submissions and derives the primary document URL. CIK is exactly ten decimal digits and cannot be all zeroes (leading zeroes allowed); accession is ten digits, hyphen, two digits, hyphen, six digits. It is not required to start with the issuer's CIK. The request accepts no arbitrary URL. Offset range is 0–1999; offsets greater than zero require `expected_sha256` (64 lowercase hex digits). A mismatch is 409 `RESEARCH_DOCUMENT_CHANGED`; the client discards previous pages and explicitly reloads.

`FilingDocument` identifies the source, SHA256, retrieval time, detected section offsets, global extracted paragraph IDs and source URL/real anchors. It returns at most 80 paragraphs/60000 Unicode characters per page, with next offset, total extracted count and a separate extraction truncation flag. IDs describe extraction ordinals, never original pages. HTML is plain untrusted text; hidden/script content is excluded. Table rows are lossy text, not structured financial facts. PDF/unsupported formats return `not_read`, null hash/content type, empty paragraphs/sections and a limitation; a source link is not evidence that text was read.

Sources are fixed SEC HTTPS hosts with public DNS pinning, no proxy or redirects, no user credentials. Per-source deadline15s, catalog JSON2MiB, HTML8MiB, parse200000 nodes, extraction2000 paragraphs/500000 characters, individual paragraph8000 characters. Request lifetime35s and four concurrent admissions bound queued work; parsing has one permit. SEC-only cache has TTL5min, at most8 entries/aggregate8MiB, with shared1 request/s and429 cooldown at least60s or longer Retry-After. It never caches FRED content. Errors are `VALIDATION_ERROR`, `RESEARCH_FILING_NOT_FOUND`, `RESEARCH_SOURCE_UNAVAILABLE`, `RESEARCH_SOURCE_RATE_LIMITED`, `RESEARCH_SOURCE_TIMEOUT`, `RESEARCH_SOURCE_INVALID`, `RESEARCH_SOURCE_TOO_LARGE` and `RESEARCH_DOCUMENT_CHANGED`.

`AiStatus` and `AiChatRequest` negotiate independent optional `filing_research_version:1` with `app_tools_version:1`. Only opted-in clients receive/submit `company_filings({issuerId})` and `company_filing({issuerId,accession,offset?,expectedSha256?})`. They share the existing three-result/24000-character budget, with client evidence at most8000 serialized characters per result, preserving whole paragraph citations and explicit omissions. Unsupported versions or unnegotiated contexts fail validation. Final-only continuation cannot query again. This source change is not a deployment claim.

# Natural-language recommendations (version 1)

Discovery adds optional `recommendations_version: 0 | 1` to `GET /v1/ai/status`.
`Q_AI_RECOMMENDATIONS` defaults to false. Clients must see version 1 before using
these authenticated, account-owned endpoints. Responses are `Cache-Control: no-store`.

- `POST /v1/ai/recommendations`: `conversation_id`, saved `source_message_id`, UUID
  `request_id`, `locale: zh | en`. The server extracts the saved question and at most
  two complete ordinary preceding rounds, never accepts client-supplied ranking
  context, and binds their content digest. Private tool results are excluded.
  Exact service requests use rules; other requests recall at most 12 candidates
  and make at most one bounded Flash choice. Result has zero to three server-owned
  candidates. Five-second total budget; saturation/failure preserves the main answer.
- `GET /v1/ai/recommendations?conversation_id=…&limit=20&cursor=…`: restore cards
  with stable descending creation-time/UUID pagination. Limit 1–20. No model or
  tool calls. Each source conversation retains up to 100 records; cards expire
  after seven days. Source deletion/account erasure cascades recommendations.
- `POST /v1/ai/recommendations/{id}/select` with `candidate_id`: check current
  source digest, ownership, access, capability version and connection revision.
  Return `conversation`, `connect`, `authorize`, `review` or `navigate` plus current
  server metadata. A dedicated target is created transactionally with the same
  account lock and quota as history. It returns an `AiConversation` with its CAS
  revision. `(recommendation, candidate)` is unique; replay returns the current
  target without overwriting later messages. A deleted target cannot be recreated
  through the same card. The endpoint itself never executes a business tool.

The client may continue automatically only after a known first creation. Lost
responses, repeated selections and reloaded history require explicit continuation
of an untouched user turn. Pending connect/auth/review selections retain only
identifiers and must call select again after setup; saved cards are never credentials.
Navigation is restricted to existing module identifiers. Existing write/payment/tool
confirmation is unchanged. Selection is not a new authorization grant.

Stable recommendation conflicts include `RECOMMENDATION_PENDING`,
`RECOMMENDATION_REQUEST_REUSED`, `RECOMMENDATION_SOURCE_UNAVAILABLE`, and
`RECOMMENDATION_STALE`. `RECOMMENDATION_REQUEST_LIMIT` (409) caps the accepted
request aliases for one source at 32; recover with GET instead of new request IDs.
`RECOMMENDATIONS_DISABLED` and `RECOMMENDATION_NOT_FOUND` are 404. Disabled functionality and unavailable records are not
found; source ownership is never disclosed. Deadline expiry uses
`RECOMMENDATION_TIMEOUT`. Existing auth, rate, history-quota and validation errors
retain their meanings. Same request ID with changed source content/locale conflicts;
another request ID for the same source digest returns the saved result.

A service-instance generation gate and a separately cancellable ranking slot keep
recommendations low priority. The ranking slot shares upstream concurrency and
per-user request quota with normal chat; normal chat preempts ranking. Dynamic
sources are owned MCP connections and fixed host catalogs. Anonymous Card storage
is not proof of public-index consent and does not make a personal service public.
See [client behavior and validation](../../mobile/docs/plugin-recommendations.md).
