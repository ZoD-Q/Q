# Wallet funding operator configuration

This implementation is source capability. Fixture tests do not verify the merchant's real payment channels, FX settlement, merchant approval or deployment. Existing QDC and bank-plugin HKD remain demonstrations; real HKD starts at zero in a separate journal. There is no withdrawal, automatic provider refund, KPS or real-bank transfer. Full externally executed refunds have a reviewed evidence, reservation and reversal workflow in the [operator contract](../../contracts/payment-operations.md).

Funding remains unavailable until a complete policy and an explicitly versioned provider configuration are supplied. The preferred server configuration is:

- `Q_PAYMENT_CREDENTIALS_JSON`: an array of at most 32 records, each containing `version`, `merchant_id`, `merchant_key`, `notify_url`, `return_url`. Use a new immutable version name for every credential revision; do not overwrite an old version's meaning.
- `Q_PAYMENT_ACTIVE_CREDENTIAL_VERSION`: the version used for **new** quotes/orders. It must exist in the registry.
- `Q_PAYMENT_POLICY_JSON`: the complete JSON policy below.

Registry example (placeholders only; not directly usable):

```json
[{"version":"<revision-id>","merchant_id":"<merchant-id>","merchant_key":"<server-only-secret>","notify_url":"https://<Q-host>/v1/payments/qixiang/notify","return_url":"https://<Q-host>/v1/payments/return"}]
```

The legacy single-provider environment form remains supported only when **all** these settings are supplied:

- `Q_PAYMENT_MERCHANT_ID`: Qixiang merchant ID.
- `Q_PAYMENT_MERCHANT_KEY`: merchant signing secret; never put this in the app, a URL, an issue, screenshots or logs.
- `Q_PAYMENT_NOTIFY_URL`: public HTTPS URL ending in `/v1/payments/qixiang/notify`.
- `Q_PAYMENT_RETURN_URL`: public HTTPS URL ending in `/v1/payments/return`.
- `Q_PAYMENT_CREDENTIAL_VERSION`: explicit immutable revision name; absence disables funding rather than assigning a default production version.
- `Q_PAYMENT_POLICY_JSON`: the complete JSON object below, with independently verified values replacing every placeholder. This example deliberately cannot enable funding unchanged.

```json
{
  "rate": {
    "rate_cny_per_100_hkd": "<verified positive decimal CNY per HKD100; at most 8 decimals>",
    "rate_source": "<approved source name>",
    "rate_source_url": "https://<approved-source>/<evidence-location>",
    "rate_source_date": "<YYYY-MM-DD>",
    "rate_at": "<RFC3339 source timestamp>",
    "rate_fetched_at": "<RFC3339 retrieval timestamp>",
    "rate_evidence_sha256": "<64 lowercase hex characters hashing retained rate evidence>"
  },
  "fee_basis_points": "<integer 0..10000; approved customer fee>",
  "min_credit_amount_minor_hkd": "<positive integer HKD cents>",
  "max_credit_amount_minor_hkd": "<integer no larger than 9007199254740991>",
  "quote_ttl_seconds": "<integer 1..900>",
  "checkout_ttl_seconds": "<integer 1..3600>",
  "rate_max_age_seconds": "<integer 1..604800>",
  "provider_utc_offset_seconds": null,
  "makers": ["<existing active Q user UUID>"],
  "checkers": ["<different existing active Q user UUID>"]
}
```

Numeric placeholders must become JSON numbers. There are no built-in rate, fee, operator or merchant defaults. The configured rate is a trusted manual bootstrap snapshot: retain and verify its underlying evidence. Explicit `Q_PAYMENT_FX_AUTO_REFRESH=1` enables the fixed, versioned ECB collector described in [FX.md](FX.md); default `0` remains manual. Repeated downloads and restarts never renew the source date. Stale evidence disables new funding without blocking history or original-order recovery. Ordinary rate refreshes preserve accepted quotes; business-policy and credential checks remain.

The server uses checked integer rational arithmetic:

`base = ceil(HKD cents * R / 100)`

`pay = ceil(HKD cents * R * (10000 + bps) / (100 * 10000))`

`fee = pay - base`

Here `R` is the exact configured CNY-per-HKD100 decimal. `total_ceiling_minor_v1` describes Q's implemented policy; it is not a claim that KAI's backend formula was recovered. Each order retains its accepted quote even when subsequent policy changes.

The provider query's `endtime` must be RFC3339, or the operator must explicitly configure `provider_utc_offset_seconds` for the provider's legacy `YYYY-MM-DD HH:MM:SS` format. `null` does not assume the host's timezone or China time. Missing, ambiguous, future or out-of-checkout-window time holds the payment in `review_required`; it cannot be approved through the ordinary maker/checker endpoints. No operator endpoint guesses or edits payment evidence.

## Processing and approval

Creation first commits a unique merchant order and a durable work item. The worker marks “may have sent” **before** its single create request. After uncertainty or restart, it only queries that original merchant order; it never automatically sends a second create. Any **possibly sent** detached or expired order remains an unresolved obligation and blocks deletion. A never-sent order can be resolved as `failed/not_created` only while holding the identity, order, slot and job fences, proving that no create can race past cancellation. Such cancellation removes the job and slot and permits zero-balance deletion. Once the durable may-have-sent mark exists, this resolution is forbidden even if no request ultimately reached the provider.

An expired quote whose original client request never reserved an order also receives an authoritative `failed/not_created` receipt when that owner retries creation. This terminal record freezes the quote's amounts, merchant and credential version but creates no provider job, checkout slot or ledger entry; its creation and checkout-expiry timestamps are equal because no checkout existed. It remains queryable by the original client key even without current provider configuration. Delayed retries cannot resurrect a send, and another key cannot replace an order or receipt already bound to that quote. Clients clear pending intent only after accepting this persisted no-create receipt, never merely because a local clock or HTTP expiration error suggests failure.

Verified known-order notifications receive `success` only after a deduplicated reconciliation job is durable. Only a **newly inserted** notification can expedite reconciliation; replays acknowledge the original receipt without changing backoff or an active lease. Notification signatures and browser returns never credit a wallet. The worker independently queries Qixiang and matches merchant, channel, both order identifiers and exact CNY cents. Worker leases use epoch/token, expiry and captured order version; late results cannot overwrite a newer decision. Known eligible credential bindings are prioritized so unavailable old configurations cannot monopolize the bounded claim scan.

1. A configured maker authenticates through ordinary Q login and reads the current evidence via `/v1/payments/operator/orders/{id}`. `POST /v1/payments/orders/{id}/proposals` accepts `{ "evidence_version": <version> }`.
2. A **different** configured checker authenticates with their own Q session. `POST /v1/payments/orders/{id}/approvals` accepts `{ "proposal_id": "<UUID>", "evidence_version": <same version> }`.
3. Both operators and the owner must still be active; the owner, maker and checker must be three different identities. New-funding readiness checks this independent pair before taking payment. The checker rechecks the immutable proposal, frozen evidence, current role generation and account state under locks. Approval, paired HKD entries, balances and credited order commit together. Repeating the original approval does not credit twice.

Ordinary customers do not receive operator rights. Configuring UUIDs does not create accounts, invite members, sign in, or bypass Q authentication. Startup synchronizes the trusted operator policy; an old process cannot keep authorizing a revoked role. Suspension retains evidence and holds ordinary credit; independently reviewed original-method refunds may settle an existing suspended customer's obligation. Account deletion is refused while real balance, reserved funds or unresolved orders/refunds remain. Refund evidence correction and source-file reconciliation retain immutable history; neither is an automatic channel payout or bank FX operation.

## Merchant configuration changes

Quotes and orders retain their original merchant ID **and credential version**; the database prevents rebinding either. The policy fingerprint includes that version, never the raw key. Switching the active version only affects new quotes/orders. Keep old registry entries while their obligations remain. Notifications and order queries select the stored version and merchant, even when the active version uses another key for the same merchant or a different merchant entirely.

Removing a needed registry entry causes an explicit unavailable hold: the system never substitutes the active client. Unavailable jobs are deferred and cannot starve eligible new jobs. Restore the original version to recover; do not reuse its name for a different secret or merchant. If the provider revokes an old key while old orders remain, resolve that version's recovery plan with the provider before removing it. There is no silent credential migration, plaintext key in order rows, old-key fallback or production test endpoint.

## Verification

`payments-test-fixtures` allows explicit constructor injection of an HTTP `127.0.0.1` origin for tests only. No environment variable or production constructor can select it. PostgreSQL tests require a dedicated `TEST_DATABASE_URL`, create their own `q_payment_test_*` schemas and drop those schemas after completion. They never call the real provider. Run the repository's Rust, isolated-database, generated-contract and mobile checks, and keep real supplier/device acceptance separate from these fixture results.
