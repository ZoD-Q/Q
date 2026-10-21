# Public beta account lifecycle

This contract describes implemented account deletion, access suspension and local
report operations. It does not claim that all personal information is erased from
every medium or that Apple has approved the beta.

## User deletion

| Endpoint | Authentication and body | Result |
| --- | --- | --- |
| `POST /v1/account/deletions` | Current Q Bearer; `{request_id:UUID,recovery_token:string,password:string,confirmation:"DELETE"}` | `200 {request_id,status:"deleted",completed_at:ISO8601}` |
| `POST /v1/account/deletions/status` | Secret recovery capability; `{request_id:UUID,recovery_token:string}` | The same minimal completed receipt; unknown ID and wrong secret both return `404 ACCOUNT_DELETION_NOT_FOUND` |

`recovery_token` is exactly 32 cryptographically random bytes encoded as 43
canonical, unpadded base64url characters. Store only its SHA-256 digest on the
server. The request ID and recovery token must be durably saved by the native
client **before** sending a deletion request. Do not persist the password. The
status request uses a JSON body, never a URL or query parameter, and returns no
user ID, handle, content or credentials. Both routes return `Cache-Control:
no-store`; access logs must not record their bodies.

Deletion verifies the current password and literal confirmation. Password
attempts are limited to five per account per minute, with the endpoint's shared
source limits also applying. `INVALID_CREDENTIALS`, validation errors and
`IDEMPOTENCY_CONFLICT` are not success. Concurrent lock contention rolls back the
whole operation and returns `409 ACCOUNT_BUSY`. No external provider request is
made by the deletion transaction.

A network timeout, lost response, interruption or 401 does not prove failure or
success: deletion revokes the very session used to request it. Query the original
receipt first, with the saved request ID and secret. A 404 means there is no
matching **completed receipt**, not that the account still exists and not that it
was deleted. Keep pending recovery information. If the original authenticated
account remains usable, an explicit retry may use the same ID, secret and
confirmation with the password entered again. Never silently generate a new ID.
Deletion by another device or an operator may make a pending user request
unrecoverable under its own ID; do not claim that its receipt exists.

## Data boundary

Deletion is one PostgreSQL transaction, taking the target identity lock before
private cleanup. It:

- Revokes every Q session; marks the account `deleted`; removes the password
  hash, replaces the handle with an unused random placeholder and resets profile
  fields. Deleted accounts cannot sign in, be reinstated or be found by handle.
- Removes personal video jobs/connections, plugin discoveries/connections,
  proposals/results, OAuth attempts and encrypted credentials. A minimal
  `{user_id,kind,idempotency_key,operation_id}` tombstone remains for erased
  video/plugin operations. Anonymous public plugin service metadata is unaffected.
- Replaces the deleting user's ordinary social message bodies with an explicit
  deletion marker, keeping sequence and message IDs; removes their ephemeral
  message bodies. It ends relationships and clears their remarks/preferences and
  mutual interaction bookkeeping. Pending friendship requests and notifications
  involving the account are removed.
- Deletes all account-owned AI conversation snapshots, including their last save request metadata.
- Disables all bank simulation accounts and deletes their private memo rows. The immutable HKD amounts, bank/account identifiers, entries, timestamps and original invocation IDs remain under the pseudonymous identity. Bank transactions do not foreign-key to deleted plugin invocations; deletion cannot be blocked by their retained journal.
- Deletes reports submitted by this account and their copied evidence. Existing
  content-free report idempotency receipts remain.

The deletion screen and privacy policy must disclose the following exceptions:

- The simulated QDC account, balances, posted transactions, immutable entries,
  **transaction memo text**, timestamps and original idempotency information are
  retained. A pseudonymous identity UUID and the SHA-256 digest of the former
  normalized handle remain so old transfers can recover their original result.
  The old handle cannot be registered again. This is a current product and data
  integrity limitation, **not a claimed legal retention obligation**.
- Other participants' ordinary messages, private remarks and their independent
  reports are not deleted. A counterparty's previously submitted report can
  contain copied content from this user and remains only until its original
  30-day expiry; deletion does not extend it. A peer's remaining ephemeral content
  retains its original expiry, but an ended relationship cannot open it.
- Provider requests and data already sent to DeepSeek, Kling or a connected
  plugin cannot be recalled by local deletion. Existing external work may finish.
  Provider deletion/revocation, when available, is a separate operation under that
  provider's policy. Local credentials and future Q sessions are removed.
- Previously created backups are not instantly overwritten. A restore must
  reconcile subsequent deletion receipts/retired handles before services resume;
  do not restore an older backup into an accessible environment without that
  reconciliation. Secure physical erasure of PostgreSQL/WAL/storage is not
  promised by this endpoint.

The identity-row status is rechecked under lock when creating sessions,
updating profiles and performing social mutations. Database owner triggers also
reject late session/video/plugin writes after suspension or deletion. In-flight
business writes can encounter a lock conflict or unavailable-owner error; they
must retain their original business idempotency key rather than start new work.
Deletion's lock timeout is three seconds, so contention cannot cause an
unbounded API wait.

Active users may still read their own ordinary historical conversations, mark
them read, remove a friendship, block/unblock, submit a report, or retrieve their
report receipt when the peer is unavailable. New friendship acceptance, messages,
ephemeral opening and relationship interactions require an active peer. This is
not a system for anonymous or random matching.

## Restricted operator tool

`account-admin` is a local Rust executable built from
`backend/scripts/account-admin.rs`. It does not expose an HTTP listener, migrate a
database, start another backend or discover credentials. Run it only through an
existing authorized SSH/DB environment, with `DATABASE_URL` supplied securely.
The deployment operator must control access to that environment and role.

```sh
account-admin reports
account-admin reports --after REPORT_UUID
account-admin report REPORT_UUID
account-admin report REPORT_UUID --include-content

Q_ACCOUNT_ADMIN_MUTATIONS=1 account-admin suspend USER_UUID --confirm USER_UUID
Q_ACCOUNT_ADMIN_MUTATIONS=1 account-admin reinstate USER_UUID --confirm USER_UUID
Q_ACCOUNT_ADMIN_MUTATIONS=1 account-admin delete USER_UUID --confirm USER_UUID
Q_ACCOUNT_ADMIN_MUTATIONS=1 account-admin resolve-report REPORT_UUID --decision actioned --confirm REPORT_UUID
Q_ACCOUNT_ADMIN_MUTATIONS=1 account-admin resolve-report REPORT_UUID --decision dismissed --confirm REPORT_UUID
```

The default report queue contains only currently unexpired, unresolved reports
and returns up to 100 records with `has_more` and `next_cursor`. Pass the returned
cursor to `reports --after` to continue. A cursor that has expired or been erased
requires restarting the queue. Resolved reports can still be inspected by their
UUID until their original expiry.

The default report view contains metadata, not the reason or copied message.
`--include-content` explicitly reads currently unexpired reason/evidence. Do not
redirect that output into persistent logs or incident documents containing
private content. Expired reports cannot be read or resolved through this tool.
Resolving a report records a decision; it does not automatically suspend an
account. An operator must perform and verify any appropriate account action.
The limited audit records DB role, action, target UUID and timestamp, without
free-text reasons or copied evidence; report expiry is never extended.

Suspension invalidates existing sessions and prevents new login and protected
writes. Reinstatement enables a suspended account and requires fresh login.
Deleted accounts cannot be reinstated; deletion of a suspended account is
available to the authorized operator. The simulated system identity is protected.

## Basic local content rules

`content_policy.rs` checks new social message publication, new friend-request
notes, display names and biographies locally. A small normalized phrase list
rejects explicit child-exploitation trading solicitation and direct death threats
with `422 CONTENT_BLOCKED`. Existing idempotent message/request recovery precedes
publication filtering. Report reasons are not filtered, so users can report abuse
using the original words.

This is a limited exact-phrase safeguard; it does not understand context,
obfuscation or all languages and may reject quoted material. It forwards no
private chat to a third-party moderator. User blocking/reporting and an actual
operator response process remain necessary; this rule set is not evidence of
complete automated moderation.

## Verification

Run `cargo test --manifest-path backend/Cargo.toml --test account_lifecycle --
--ignored` only with `TEST_DATABASE_URL` pointing at an explicitly designated
isolated PostgreSQL test database. Each test creates and removes its own schema.
Coverage includes deletion/password/confirmation, secret receipt recovery,
credential/session write guards, suspended-account deletion, retained peer
content, exact immutable-ledger preservation and original transfer replay after
recipient deletion, parallel participant deletion, filtering, and report expiry.
Actual results belong in the release testing record; this contract alone is not
evidence that the tests ran.
