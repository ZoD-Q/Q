# 小Q demo backend

Rust modular monolith: Axum, Tokio, SQLx and PostgreSQL. This backend only handles simulated QDC. It has no real payment provider, bank account, lending, insurance or investment connection.

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
