-- Immutable public FX evidence, snapshots, explicit reviews and a shared poll fence.
CREATE TABLE payment_fx_evidence (
 evidence_hash BYTEA PRIMARY KEY CHECK(octet_length(evidence_hash)=32),
 raw_xml BYTEA NOT NULL CHECK(octet_length(raw_xml) BETWEEN 1 AND 262144),
 first_fetched_at TIMESTAMPTZ NOT NULL,
 CHECK(evidence_hash=sha256(raw_xml))
);
CREATE TABLE payment_fx_snapshots (
 id UUID PRIMARY KEY,
 provenance TEXT NOT NULL CHECK(provenance IN ('bootstrap_config','ecb')),
 source_date DATE NOT NULL,
 rate_snapshot JSONB NOT NULL,
 evidence_hash BYTEA NOT NULL CHECK(octet_length(evidence_hash)=32),
 verified_evidence_hash BYTEA REFERENCES payment_fx_evidence(evidence_hash),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CHECK((provenance='bootstrap_config' AND verified_evidence_hash IS NULL)
    OR (provenance='ecb' AND verified_evidence_hash IS NOT NULL AND verified_evidence_hash=evidence_hash)),
 CHECK(rate_snapshot ? 'rate_evidence_sha256' AND rate_snapshot->>'rate_evidence_sha256'=encode(evidence_hash,'hex')),
 CHECK(rate_snapshot ? 'rate_source_date' AND rate_snapshot->>'rate_source_date'=to_char(source_date,'YYYY-MM-DD')),
 UNIQUE(provenance,source_date,evidence_hash)
);
CREATE TABLE payment_fx_state (
 singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
 policy_fingerprint BYTEA NOT NULL CHECK(octet_length(policy_fingerprint)=32),
 generation BIGINT NOT NULL DEFAULT 1 CHECK(generation>0),
 automatic_enabled BOOLEAN NOT NULL,
 active_snapshot_id UUID NOT NULL REFERENCES payment_fx_snapshots(id),
 candidate_snapshot_id UUID REFERENCES payment_fx_snapshots(id),
 hold_reason TEXT,
 held_evidence_hash BYTEA REFERENCES payment_fx_evidence(evidence_hash),
 epoch BIGINT NOT NULL DEFAULT 0,
 lease_token UUID, leased_until TIMESTAMPTZ,
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count>=0),
 last_checked_at TIMESTAMPTZ, last_success_at TIMESTAMPTZ,
 last_error_code TEXT, last_http_status INTEGER,
 etag TEXT, last_modified TEXT,
 CHECK((lease_token IS NULL)=(leased_until IS NULL))
);
CREATE TABLE payment_fx_activations (
 id UUID PRIMARY KEY,
 snapshot_id UUID NOT NULL REFERENCES payment_fx_snapshots(id),
 operator_id UUID NOT NULL REFERENCES identities(id),
 policy_generation BIGINT NOT NULL,
 policy_fingerprint BYTEA NOT NULL CHECK(octet_length(policy_fingerprint)=32),
 evidence_hash BYTEA NOT NULL CHECK(octet_length(evidence_hash)=32),
 reason TEXT NOT NULL CHECK(char_length(reason) BETWEEN 10 AND 500),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_fx_evidence BEFORE UPDATE OR DELETE ON payment_fx_evidence FOR EACH ROW EXECUTE FUNCTION reject_payment_immutable_mutation();
CREATE TRIGGER immutable_fx_snapshot BEFORE UPDATE OR DELETE ON payment_fx_snapshots FOR EACH ROW EXECUTE FUNCTION reject_payment_immutable_mutation();
CREATE TRIGGER immutable_fx_activation BEFORE UPDATE OR DELETE ON payment_fx_activations FOR EACH ROW EXECUTE FUNCTION reject_payment_immutable_mutation();
