# 小Q demo backend

Rust modular monolith: Axum, Tokio, SQLx and PostgreSQL. Its ledger only handles simulated QDC. The opt-in video workbench can submit real Kling requests with user-owned API credentials. It has no real payment provider, bank account, lending, insurance or investment connection.

Start with the [repository development rules](../AGENTS.md) and [backend rules](AGENTS.md). The [Q plugin integration specification](docs/plugin-integration.md) defines the future host contract; MCP, discovery, authorization and Apps support are not implemented in this release.

## Run locally

This directory owns the local PostgreSQL scripts and their separate npm dependencies. The mobile UI starts independently. Alternatively, provide an existing PostgreSQL database using `DATABASE_URL`.

```sh
cd backend
npm install
npm run db:start
npm run dev
# Later, after stopping the API:
npm run db:stop
```

The local launcher reads `.env` when present and preserves existing environment values. It defaults to this project's loopback PostgreSQL and enables the public demo seed only for that exact local URL. To manage your own configuration, copy `.env.example` to `.env` and edit it. `Q_CARGO_BIN` can override the default `$HOME/.cargo/bin/cargo`. PostgreSQL data lives in `backend/.local/postgres` relative to the repository; logs and persistence snapshots also stay under this directory's `.local/`.

Migrations run at startup. Default bind is `127.0.0.1:8787`; `Q_BIND` overrides it. `Q_CORS_ORIGINS` is a comma-separated list of exact origins, defaulting to localhost and 127.0.0.1 on port 8081. Native clients are unaffected by browser CORS. `GET /health` checks the live database.

`Q_SEED_DEMO=true` idempotently provisions `kai` / `lin` with `Qdemo12345!`, each receiving 100000 minor units (1000.00 Q). Existing credentials, profiles and balances are preserved. These fixtures are public local demo credentials. Leave seeding off in environments containing non-demo data.

## Boundaries

- `identity`: credentials, login throttling, expiring opaque sessions, logout. Argon2 work runs on a bounded blocking pool. Session tokens contain 256 random bits and only SHA-256 hashes are stored. Sessions expire after seven days.
- `profiles`: editable name, avatar, bio, theme and locale; authenticated exact-handle lookup only returns public recipient fields. `xiaoq` is reserved for the system demo-funds identity.
- `ledger`: exclusively writes accounts, transfers and entries. Registration requests its atomic welcome grant. User balances cannot be negative; the system treasury may be negative. All amounts are integer minor units.
- `payments` is a documented future boundary, with no active provider or recharge endpoint in this release. A future mock provider may emit verified simulated events into a ledger application command; it must never edit balances. A mock event is not proof of a real payment. Real payment adapters, provider callbacks, reconciliation and refunds require a separate design and environment.

Transfers lock both wallets in UUID order, recheck sender-scoped idempotency under lock, post a balanced debit/credit pair and update cached balances in one PostgreSQL transaction. A replay returns the original transfer ID, timestamp and post-transfer balance, even if subsequent transfers changed the current balance. Same key with changed normalized recipient, amount or memo returns `IDEMPOTENCY_CONFLICT`. Failed attempts create no journal entries. PostgreSQL triggers prohibit edits/deletes of posted entries and transactions and reject unbalanced journals or mismatched cached balances at commit. They protect against accidental application writes, not a database administrator who can disable them.

Profiles and credentials do not embed balances. Login ownership is the authenticated session, never a client-supplied user ID. SQL uses bound parameters. Auth endpoints use per-IP and per-handle minute limits and reject excessive password hashing concurrency. Rate limits are process-local and reset on restart; internet deployment needs a shared limiter and trusted proxy configuration. The server deliberately ignores untrusted forwarded IP headers.

## Verification

```sh
~/.cargo/bin/cargo fmt --check
~/.cargo/bin/cargo clippy --all-targets -- -D warnings
~/.cargo/bin/cargo test
TEST_DATABASE_URL=postgresql://xiaoq:xiaoq_demo_local@127.0.0.1:55432/xiaoq_demo \
  ~/.cargo/bin/cargo test --test postgres -- --ignored
```

API tools run from this directory: `npm run test:api`, `npm run db:snapshot`, and `npm run db:verify`. The snapshot/verify pair reads account and ledger data without creating transactions. The API acceptance suite creates explicit test accounts, so run it only when that is intended.

The three ignored-by-default integration tests require real PostgreSQL, use isolated temporary schemas, and cover auth/profile isolation, expiring/revoked sessions, balanced histories, duplicate requests, conflicting payloads, concurrent overspending, opposing transfer lock order, immutable entries, rejected incomplete commits and idempotent demo seeding. No SQLite or in-memory substitute exists. Production work still includes TLS, secret management, migrations with a separate database role, password recovery, account deletion, durable throttling, monitoring, and operational recovery. None of those make this demonstration a real financial system.

## Personal video API workbench

See [API contract](contracts/api.md) and [workbench guide](../mobile/docs/video-api-workbench.md). Set server-only `Q_VIDEO_ENCRYPTION_KEY` to standard Base64 encoding of 32 random bytes. Generate it locally with `openssl rand -base64 32`, save it in a protected environment/secret store, and keep a backup. Do not commit it or expose it with `EXPO_PUBLIC_*`. Missing configuration disables credential/network actions. Current encryption does not provide automated key rotation; replacing the key loses access to old encrypted connections.

Credentials are bound to the authenticated owner, encrypted at rest, never returned, and erased on revoke. Fixed official provider hosts and disabled redirects prevent forwarding credentials to arbitrary URLs. The local frontend remains independent and the financial ledger stays simulated.

Fixture-enabled PostgreSQL verification uses a dedicated test database:

```sh
TEST_DATABASE_URL=postgresql://USER:PASSWORD@HOST/TEST_DATABASE \
  ~/.cargo/bin/cargo test --features video-test-fixtures --test video_workbench -- --ignored
```

The fixture feature is only for local validation; production/default builds use official endpoints. A passing fixture test proves the adapter lifecycle and data isolation, not a paid supplier generation.

To reproduce the local UI fixture without supplier calls, create a dedicated loopback database named `xiaoq_video_preview`, set `DATABASE_URL` to it and `Q_VIDEO_ENCRYPTION_KEY` as above, then run `cargo run --features video-test-fixtures --example video_workbench_preview`. It binds only `127.0.0.1:8792`, uses the public `kai` / `Qdemo12345!` demo login, and never contacts Kling. Start Expo with `EXPO_PUBLIC_API_URL=http://127.0.0.1:8792 npm exec --workspace=@xiaoq/native -- expo start --port 8092` from `mobile/`. Enter a placeholder provider key only. The fixture produces task transitions and an explicit missing-video result (or failure when prompt contains `fail`), never a fake generated film. Do not use this fixture with real credentials.

## DeepSeek chat

Set server-only `DEEPSEEK_API_KEY` in the ignored `backend/.env` (owner-only permissions). Chat uses the existing Q identity and a fixed official HTTPS endpoint; no key is returned to clients. `GET /v1/ai/status` reports configuration, and authenticated `POST /v1/ai/chat` returns bounded SSE text. See the [chat guide](../mobile/docs/deepseek-chat.md) and [API contract](contracts/api.md) for models, budgets, errors, cancellation and tests. No chat history or provider reasoning is stored. Model requests are real when configured, while the QDC ledger remains simulated.
