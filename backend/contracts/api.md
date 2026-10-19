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

Manual GET of a completed job may refresh its expiring signed media URL under the same 3-second poll guard. Only the latest database poll claim may update the result. A failed refresh preserves completed state and the last safe URL while recording `VIDEO_POLL_UNAVAILABLE`; unavailable startup configuration leaves saved completed history readable. An early inconclusive lookup does not suppress a later definitive rejection from the original POST while the reservation still has no provider task ID.
