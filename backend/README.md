# 小Q backend

Rust modular monolith: Axum, Tokio, SQLx and PostgreSQL. Its ledgers separate simulated QDC, first-party bank-plugin demo HKD and the payment module's independent HKD ledger. Configured DeepSeek chat and the opt-in video workbench make real provider requests. Kling uses user-owned API credentials. Qixiang CNY funding, server-side payment verification and maker/checker credit approval are implemented; configuration defaults to disabled. The 2026-11-03 deployment enabled its funding policy and verified quotes and unpaid WeChat/Alipay checkout recovery. Actual payment, approval, HKD credit and settlement remain unverified; see the [payment contract](contracts/payments.md) and [deployment record](deploy/PAYMENTS-2026-11-03.md). The 20 bank plugins and their wallet imagery remain simulations, with no real bank, lending, insurance or investment account connection; see [bank plugin behavior](../mobile/docs/bank-plugins.md).

Start with the [repository development rules](../AGENTS.md) and [backend rules](AGENTS.md). The [Q plugin integration specification](docs/plugin-integration.md) defines the host contract; personal MCP connections and explicit tool calls are implemented, while Apps sandboxing and a public index remain future work.

The `social` module reuses Q identity for friend requests, private text conversations, read receipts, ephemeral messages, mutual interaction days and reports. It is included in the deployed API; see [deployment status](deploy/STATUS.md), [the social API contract](contracts/social.md) and [the client guide](../mobile/docs/social-chat.md). Foreground polling is not OS push; automatic expiry is not end-to-end encryption. A repository change does not update a server or installed app by itself.

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
- `ledger`: exclusively writes accounts, transfers and entries. Registration requests its atomic simulated QDC welcome grant; bank demo HKD and payment HKD use separate tables and writers. Payment HKD starts at zero. User balances cannot be negative; the corresponding treasury or clearing counterparty may be negative. All amounts are integer minor units.
- `payments`: authenticated `/v1/payments` quotes, durable idempotent orders, signed notifications, server-side order queries, maker/checker approval and recovery workers. Only matching provider evidence and a different authorized checker can lead to credit through `ledger::real_hkd`; callbacks and return-page navigation cannot change balances directly. Real-account transfers, bank payouts, refunds and KPS are not implemented. An unpaid checkout test is not proof of payment or credit.

Transfers lock both wallets in UUID order, recheck sender-scoped idempotency under lock, post a balanced debit/credit pair and update cached balances in one PostgreSQL transaction. A replay returns the original transfer ID, timestamp and post-transfer balance, even if subsequent transfers changed the current balance. Same key with changed normalized recipient, amount or memo returns `IDEMPOTENCY_CONFLICT`. Failed attempts create no journal entries. PostgreSQL triggers prohibit edits/deletes of posted entries and transactions and reject unbalanced journals or mismatched cached balances at commit. They protect against accidental application writes, not a database administrator who can disable them.

Profiles and credentials do not embed balances. Login ownership is the authenticated session, never a client-supplied user ID. SQL uses bound parameters. Auth endpoints use per-IP and per-handle minute limits and reject excessive password hashing concurrency. `Q_TRUSTED_PROXY_IPS` accepts exact immediate-proxy IPs; only those peers may supply one valid `X-Forwarded-For` address. Missing, repeated, invalid or multi-address values fall back to the TCP peer, and untrusted peers cannot select their rate-limit key through headers. This policy is deployed and configured for the Q gateway. Limits remain process-local and reset on restart; distributed throttling and a multi-client public ingress pressure test are not established by that configuration check.

## Verification

Database suites run against an isolated `TEST_DATABASE_URL`. `social_backup` requires matching-major `pg_dump`/`pg_restore` (PATH or `Q_PG_BIN_DIR`), libpq credentials such as `PGPASSWORD`, and a disposable role allowed to create databases. It creates, restores and drops its own uniquely named databases using the deployment exclusion policy. The deployed backup policy excludes ephemeral social payloads and report/evidence data; retain that policy when upgrading or restoring.

```sh
~/.cargo/bin/cargo fmt --check
~/.cargo/bin/cargo clippy --all-targets -- -D warnings
~/.cargo/bin/cargo test
TEST_DATABASE_URL=postgresql://TEST_USER:TEST_PASSWORD@127.0.0.1:55433/xiaoq_test \
  ~/.cargo/bin/cargo test --test postgres -- --ignored
```

API tools run from this directory: `npm run test:api`, `npm run db:snapshot`, and `npm run db:verify`. The snapshot/verify pair reads account and ledger data without creating transactions. The API acceptance suite creates explicit test accounts, so run it only when that is intended.

The ignored-by-default suites require real PostgreSQL and cover identity/profile isolation, account lifecycle, immutable balanced ledgers, AI history, social expiry and restoration, plugin authorization and recovery, video adapters, financial profiles and payment approval/idempotency. Provider-fixture suites require their documented feature flags; commands and isolation requirements are in [AGENTS.md](../AGENTS.md). The URL above is a placeholder for a separately provisioned test database, not the existing local demo or a business database. No SQLite or in-memory substitute exists. Public HTTPS, protected deployment configuration, basic backups and health checks are deployed; separate migration/runtime roles, password recovery, durable distributed throttling, continuous offsite backup, external alerts and full production/real-business acceptance remain distinct work. The [deployment status](deploy/STATUS.md) records what was actually checked.

## Personal video API workbench

See [API contract](contracts/api.md) and [workbench guide](../mobile/docs/video-api-workbench.md). Set server-only `Q_VIDEO_ENCRYPTION_KEY` to standard Base64 encoding of 32 random bytes. Generate it locally with `openssl rand -base64 32`, save it in a protected environment/secret store, and keep a backup. Do not commit it or expose it with `EXPO_PUBLIC_*`. Missing configuration disables credential/network actions. Current encryption does not provide automated key rotation; replacing the key loses access to old encrypted connections.

Credentials are bound to the authenticated owner, encrypted at rest, never returned, and erased on revoke. Fixed official provider hosts and disabled redirects prevent forwarding credentials to arbitrary URLs. The local frontend remains independent; video workbench requests do not charge the QDC, bank demo HKD or payment HKD ledgers.

Fixture-enabled PostgreSQL verification uses a dedicated test database:

```sh
TEST_DATABASE_URL=postgresql://USER:PASSWORD@HOST/TEST_DATABASE \
  ~/.cargo/bin/cargo test --features video-test-fixtures --test video_workbench -- --ignored
```

The fixture feature is only for local validation; production/default builds use official endpoints. A passing fixture test proves the adapter lifecycle and data isolation, not a paid supplier generation.

To reproduce the local UI fixture without supplier calls, create a dedicated loopback database named `xiaoq_video_preview`, set `DATABASE_URL` to it and `Q_VIDEO_ENCRYPTION_KEY` as above, then run `cargo run --features video-test-fixtures --example video_workbench_preview`. It binds only `127.0.0.1:8792`, uses the public `kai` / `Qdemo12345!` demo login, and never contacts Kling. Start Expo with `EXPO_PUBLIC_API_URL=http://127.0.0.1:8792 npm exec --workspace=@xiaoq/native -- expo start --port 8092` from `mobile/`. Enter a placeholder provider key only. The fixture produces task transitions and an explicit missing-video result (or failure when prompt contains `fail`), never a fake generated film. Do not use this fixture with real credentials.

The UI fixture also recognizes `[fixture:unknown]` in a prompt (stores the supplier task, returns an uncertain response) and `[fixture:slow]` (delays the supplier response beyond the fixture transport timeout). Both can subsequently be queried by the original external task ID to verify recovery without another submission.

## DeepSeek chat

Set server-only `DEEPSEEK_API_KEY` in the ignored `backend/.env` (owner-only permissions). Chat uses the existing Q identity and a fixed official HTTPS endpoint; no key is returned to clients. `GET /v1/ai/status` reports configuration, and authenticated `POST /v1/ai/chat` returns bounded SSE text. Separate authenticated history endpoints persist and restore conversation snapshots in PostgreSQL by owner; the client saves through those endpoints, while server logs omit message bodies and keys. Raw provider reasoning is not forwarded as answer text. See the [chat guide](../mobile/docs/deepseek-chat.md) and [API contract](contracts/api.md) for models, budgets, history revisions, errors, cancellation and tests.

The 2026-11-04 public status check returned `configured:true`, `app_tools_version:1`, `company_research_version:1` and `automatic_readonly_tools:true`; authenticated history listing also returned 200. A short live Flash SSE request and cancellation were verified, while real model selection and continuation through every application/company research tool remain separate acceptance checks. These flags do not grant cross-module private data access. Installed clients must still support and opt into the advertised version; see the [application assistant](../mobile/docs/app-assistant.md).

## MCP connections and photo example

`src/plugins/` implements personal connections, four discovery entry types, MCP 2026-07-28 and OAuth/CIMD. It reuses Q identity and never writes ledgers directly. Calls are persisted before execution. With capability negotiation and the server-owned policy, first-party bank demo balance/history queries can run automatically after checking the current request and connection; transfers and untrusted remote tools still require explicit confirmation. Third-party `readOnlyHint` does not select that policy. Ambiguous outcomes remain `unknown` and are never replayed automatically. See the [host guide](../mobile/docs/mcp-host.md) and [protocol sources](docs/reference/mcp-2026-wire-source.md).

The six fixed financial provider profiles are deployed; the 2026-11-04 authenticated directory returned six entries and host availability, credential-storage and OAuth configuration flags. Those flags do not prove a user's provider authorization or a real supplier call. The five protected services still need their own authorized business acceptance; see [financial plugins](../mobile/docs/financial-plugins.md). The separate `/q-admin/` web page remains a static demo, not a real payment approval console.

Optional OAuth requires `Q_MCP_ENCRYPTION_KEY` (a separate persistent 32-byte base64 key) and `Q_MCP_PUBLIC_BASE_URL` (a public HTTPS origin). Anonymous connections require neither. Tokens are encrypted and bound to the owner, connection, issuer and resource; never sent to the mobile client. MCP Apps HTML sandboxing and a public index are not implemented. The native raster viewer is not an Apps host.

## Conversation recommendations

`Q_AI_RECOMMENDATIONS=false` keeps the feature disabled by default. Enable it only after reviewing the [recommendation behavior and validation](../mobile/docs/plugin-recommendations.md); the deployment template passes this setting explicitly. The versioned API builds an owner-scoped capability view and stores idempotent handoffs separately from history snapshots. It does not index personal services publicly or execute tools on selection. The additive `2026110801_ai_recommendations.sql` migration creates recommendation, request-alias and selection tables; disabling the feature is the application rollback, and existing account/history deletion still cascades records. Do not remove or edit an applied migration.
