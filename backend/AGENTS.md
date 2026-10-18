# 小Q backend development contract

- Repository top-level directories are `web/`, `mobile/` and `backend/`. All backend business logic belongs here and uses Rust. Keep the current PostgreSQL-backed modular monolith; do not substitute SQLite or in-memory data.
- Read `contracts/api.md` before changing endpoints. `contracts/openapi.json` is the machine-readable wire contract. Shared TypeScript types live in `../mobile/shared/src`; regenerate them with `npm run api:generate` from `../mobile/`, never by hand. The integration owner coordinates contracts, shared types, dependency locks and SQL migration ordering.
- identity owns credentials and sessions; profiles owns editable personal fields; ledger exclusively owns accounts, immutable entries and transfers; payments is a future/mock provider boundary and must not write balances directly.
- Only simulated QDC units exist. Mark money-related UI as demo. Never connect real payment or financial services as an incidental change.
- Amounts use integer minor units. Transfer debit and credit commit in the same DB transaction; enforce authorization, nonnegative user balances, request idempotency and deterministic locking. Existing ledger entries and transaction history must not be edited or deleted for frontend redesigns or directory cleanup.
- Secrets stay server-side. Use Argon2 for passwords, hash opaque session tokens at rest, and retain expiring/revocable sessions. Native client sessions use SecureStore. Demo credentials must not imply production readiness.
- Local tooling and its npm dependencies belong in this directory. `npm run db:start` / `db:stop` / `db:status` manage only this project's loopback PostgreSQL; `npm run dev` starts the Rust API. Data lives in `.local/postgres`. Never delete that directory as a routine repair.
- Frontend source belongs in sibling `../mobile/` and `../web/`. The default mobile UI launcher is frontend-only and must not start or require this backend.
- Agent ownership must not overlap. Ask the integration owner before touching another agent's directory or shared files. Avoid empty speculative implementations for future modules.
- Verify meaningful backend changes with Rust checks and integration tests against real PostgreSQL. Read-only snapshot verification is appropriate for directory relocation. Record runtime limits honestly.
