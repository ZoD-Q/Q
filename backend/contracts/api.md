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
