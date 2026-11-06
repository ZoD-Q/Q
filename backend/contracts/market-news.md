# Public news cache v1

`GET /v1/market-data/news?topic=central_banks|fed|markets|crypto|technology` is anonymous. It reads public PostgreSQL cache rows only; it does not query providers, enqueue collection, accept URLs or send account/chat information. Missing/unknown/duplicated `topic` or any unknown query parameter returns `400 VALIDATION_ERROR`. Responses use `Cache-Control: public, max-age=30` and the existing configured CORS policy. The normal structured error contract applies to database failures.

A successful HTTP 200 is a successful **cache-status read**, not a promise that every source has data. Body:

- `version: 1`, exact requested `topic`, UTC `server_time`.
- `status`: `ready` (all sources ready), `partial` (some ready), `stale` (only old usable cache remains), `unavailable` (no usable source cache). A validated empty feed can be `ready` with no articles; failure is not reported as a validated empty feed.
- `records`: at most 20 deduplicated headline metadata records, newest source timestamp first. Each has `title`, original HTTPS `url`, exact `source_id`, `publisher`, nullable `published_at` and nullable `indexed_at`. Official RSS records use publication time and have null index time. GDELT uses index time and has null publication time. Missing or unparseable source time remains null. No article bodies, model summaries or invented publication times.
- `sources`: each expected source exactly once, with `id`, `name`, fixed public `url`, `status: ready|stale|unavailable`, nullable `last_checked_at`, nullable `last_success_at`, `retry_at`, nullable stable `error_code`. `retry_at` includes source/provider cooldown and active lease expiry. It is a collection schedule, not a freshness guarantee or an immediate user retry command.

## Source scope

| Topic | Sources |
| --- | --- |
| `central_banks` | `fed` and `ecb` official RSS |
| `fed` | `fed` only (older client/assistant compatibility) |
| `markets` | `gdelt_markets` only |
| `crypto` | `gdelt_crypto` only |
| `technology` | `gdelt_technology` only |

Fed is fixed to `https://www.federalreserve.gov/feeds/press_monetary.xml`; ECB to `https://www.ecb.europa.eu/rss/press.html`. Their article URLs must stay on the corresponding official HTTPS host. GDELT retains the existing three fixed queries at `https://api.gdeltproject.org/api/v2/doc/doc`, ArticleList JSON, 24-hour window and maximum 20 records. Central-bank releases do not replace or claim global market/crypto/technology coverage. Free official RSS data is not a trading quotation.

## Collection, persistence and failure behavior

The executable owns one background worker, polling the database schedule every 10 seconds and checking successfully collected sources every 15 minutes. Customer read frequency does not change vendor frequency. Source leases last 60 seconds, while a complete DNS/HTTP/read operation is bounded to 15 seconds. Claim and completion use PostgreSQL time. Every completion, including failures and 304, checks the current token and unexpired source lease; GDELT additionally checks the shared provider lease. An expired/killed worker cannot overwrite a successor or release its lease. Multiple API instances use the same durable schedule, leases and fencing; no process-only lock or cache is relied upon.

All three GDELT topics share one in-flight slot, a minimum five-second interval and durable failure state. Consecutive failures use 1/5/15/60-minute backoff, remaining at 60 minutes thereafter; a valid longer `Retry-After` wins. Delta-seconds remain a relative duration until completion adds them to PostgreSQL wall time; HTTP-date stays an absolute provider timestamp. A skewed API-instance clock cannot shorten the durable cooldown. Oldest due topic is attempted first to prevent starvation. A success clears that source's failure state and the provider cooldown. There is no client-side direct fallback and no repeated customer-triggered request to a failed upstream.

Only validated successful results replace cached records. Conditional RSS requests use bounded ETag/Last-Modified values. A 304 refreshes collection success time only when a valid stored cache exists; article timestamps stay unchanged. Errors retain the previous records and successful collection time. Cache older than 15 minutes, or a source whose latest collection failed, is labeled stale; cache older than 24 hours is omitted from responses without deleting the stored record. Old article publication dates do not become new dates after a successful collection.

All fixed destinations resolve to public addresses and are pinned for the request. Private/special-purpose DNS answers fail closed; environment proxies and redirects are disabled. HTTPS validation remains enabled. Responses are bounded to 512KiB; RSS rejects DTD/entities and bounds XML nodes/depth/items, GDELT requires its bounded article array. Stable error codes are `network`, `timeout`, `rate_limited`, `http`, `invalid_data`, `too_large`, `unsafe_destination`. Provider bodies, full article text, credentials and account data are not logged.

## Client behavior and rollout

New clients send only the selected fixed topic to Q's normal API origin, with no Bearer token or cookies. They validate source identities, timestamps, article URLs, scope and aggregate status before presentation. Server 404/501 means the server has not deployed this feature; display that state after one request and never fall back to vendor calls. A short 30-second view cache is separate from the server's 15-minute collection cadence.

The UI separates central-bank releases from the three GDELT topics, reports each source's success/check/retry time, and distinguishes source publication/index time from cache-read time. Partial or unavailable collection never receives an “all sources retrieved” label. Empty unavailable caches cannot be handed to AI. Optional research handoff remains a user-reviewed draft, never automatic chat upload. If the view has expired or its refresh failed/was cancelled, the draft preserves the last recorded server collection status and separately warns that this is an older result; a historical `ready` state does not imply that the current refresh succeeded.

Deployment requires the new migration, backend worker/API and updated client. Code and isolated tests do not establish live GDELT recovery. The preceding read-only server probes verified two official RSS responses; GDELT has not yielded a successful real JSON response in this investigation. Real server deployment and cross-platform UI checks must be recorded separately.
