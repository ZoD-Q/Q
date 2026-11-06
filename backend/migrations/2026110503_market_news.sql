-- Public headline metadata only. Reads never trigger vendor calls or access Q identities.
CREATE TABLE market_news_sources (
 id TEXT PRIMARY KEY CHECK (id IN ('fed','ecb','gdelt_markets','gdelt_crypto','gdelt_technology')),
 records JSONB,
 last_success_at TIMESTAMPTZ,
 last_checked_at TIMESTAMPTZ,
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures BETWEEN 0 AND 1000000),
 error_code TEXT CHECK(error_code IN ('network','timeout','rate_limited','http','invalid_data','too_large','unsafe_destination')),
 etag TEXT CHECK(octet_length(etag)<=512),
 last_modified TEXT CHECK(octet_length(last_modified)<=128),
 lease_token UUID,
 lease_expires_at TIMESTAMPTZ,
 CHECK((records IS NULL) = (last_success_at IS NULL)),
 CHECK(records IS NULL OR (jsonb_typeof(records)='array' AND jsonb_array_length(records)<=20)),
 CHECK((lease_token IS NULL) = (lease_expires_at IS NULL))
);
INSERT INTO market_news_sources(id) VALUES ('fed'),('ecb'),('gdelt_markets'),('gdelt_crypto'),('gdelt_technology');
-- GDELT's three topics share one in-flight request, retry state and cooldown across instances.
CREATE TABLE market_news_provider_state (
 id TEXT PRIMARY KEY CHECK(id='gdelt'),
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures BETWEEN 0 AND 1000000),
 error_code TEXT CHECK(error_code IN ('network','timeout','rate_limited','http','invalid_data','too_large','unsafe_destination')),
 lease_token UUID,
 lease_expires_at TIMESTAMPTZ,
 CHECK((lease_token IS NULL) = (lease_expires_at IS NULL))
);
INSERT INTO market_news_provider_state(id) VALUES ('gdelt');
