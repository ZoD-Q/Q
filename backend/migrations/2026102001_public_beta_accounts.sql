-- Account lifecycle does not mutate posted simulated-ledger records.
ALTER TABLE identities
    ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'deleted')),
    ADD COLUMN deleted_at TIMESTAMPTZ,
    ADD COLUMN deleted_handle_hash BYTEA,
    ADD CONSTRAINT identity_deletion_shape CHECK (
        (status = 'deleted' AND deleted_at IS NOT NULL
            AND deleted_handle_hash IS NOT NULL AND octet_length(deleted_handle_hash) = 32)
        OR (status <> 'deleted' AND deleted_at IS NULL AND deleted_handle_hash IS NULL)
    );
CREATE UNIQUE INDEX retired_identity_handle ON identities(deleted_handle_hash)
    WHERE deleted_handle_hash IS NOT NULL;

-- Registration and deletion take the same advisory lock for the normalized handle.
-- This prevents a concurrent registration from reusing a just-retired handle.
CREATE FUNCTION guard_identity_lifecycle() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.handle, 910042));
        IF EXISTS (SELECT 1 FROM identities
                   WHERE deleted_handle_hash = sha256(convert_to(NEW.handle, 'UTF8'))) THEN
            RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'handle unavailable';
        END IF;
    ELSIF OLD.status = 'deleted' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted identity is immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER identity_lifecycle BEFORE INSERT OR UPDATE ON identities
    FOR EACH ROW EXECUTE FUNCTION guard_identity_lifecycle();

CREATE TABLE account_deletion_receipts (
    request_id UUID PRIMARY KEY,
    user_id UUID NOT NULL UNIQUE REFERENCES identities(id),
    recovery_hash BYTEA NOT NULL CHECK (octet_length(recovery_hash) = 32),
    completed_at TIMESTAMPTZ NOT NULL
);

-- No request arguments, provider references, URLs, content, or credentials remain here.
CREATE TABLE account_erased_operations (
    user_id UUID NOT NULL REFERENCES identities(id),
    kind TEXT NOT NULL CHECK (kind IN ('video', 'plugin')),
    idempotency_key UUID NOT NULL,
    operation_id UUID NOT NULL,
    PRIMARY KEY (user_id, kind, idempotency_key)
);

-- Restricted operator actions record no free-text reason or message evidence.
CREATE TABLE account_operator_audit (
    id UUID PRIMARY KEY,
    database_actor TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('suspend', 'reinstate', 'delete', 'report_dismissed', 'report_actioned')),
    user_id UUID REFERENCES identities(id),
    report_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK ((action IN ('suspend', 'reinstate', 'delete') AND user_id IS NOT NULL AND report_id IS NULL)
        OR (action IN ('report_dismissed', 'report_actioned') AND user_id IS NULL AND report_id IS NOT NULL))
);
CREATE INDEX account_operator_reports ON account_operator_audit(report_id, created_at);

-- An authenticated request can outlive its session. A late write must not restore
-- private provider state after deletion. Deletion itself only DELETEs these rows.
CREATE FUNCTION require_active_record_owner() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE owner_status TEXT;
BEGIN
    SELECT status INTO owner_status FROM identities WHERE id = NEW.user_id FOR SHARE;
    IF owner_status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'account is unavailable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER active_session_owner BEFORE INSERT OR UPDATE ON sessions
    FOR EACH ROW EXECUTE FUNCTION require_active_record_owner();
CREATE TRIGGER active_video_connection_owner BEFORE INSERT OR UPDATE ON video_connections
    FOR EACH ROW EXECUTE FUNCTION require_active_record_owner();
CREATE TRIGGER active_video_job_owner BEFORE INSERT OR UPDATE ON video_jobs
    FOR EACH ROW EXECUTE FUNCTION require_active_record_owner();
CREATE TRIGGER active_plugin_discovery_owner BEFORE INSERT OR UPDATE ON plugin_discoveries
    FOR EACH ROW EXECUTE FUNCTION require_active_record_owner();
CREATE TRIGGER active_plugin_connection_owner BEFORE INSERT OR UPDATE ON plugin_connections
    FOR EACH ROW EXECUTE FUNCTION require_active_record_owner();
CREATE TRIGGER active_plugin_attempt_owner BEFORE INSERT OR UPDATE ON plugin_oauth_attempts
    FOR EACH ROW EXECUTE FUNCTION require_active_record_owner();
CREATE TRIGGER active_plugin_token_owner BEFORE INSERT OR UPDATE ON plugin_oauth_tokens
    FOR EACH ROW EXECUTE FUNCTION require_active_record_owner();
CREATE TRIGGER active_plugin_invocation_owner BEFORE INSERT OR UPDATE ON plugin_invocations
    FOR EACH ROW EXECUTE FUNCTION require_active_record_owner();
