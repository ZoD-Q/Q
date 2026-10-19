-- Personal connections, authorization, and confirmed invocations are isolated from Q's ledger.
CREATE TABLE plugin_services (
    id UUID PRIMARY KEY,
    card_url TEXT NOT NULL,
    card_url_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(card_url_hash) = 32),
    anonymous_card JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE plugin_discoveries (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES identities(id),
    entry_kind TEXT NOT NULL CHECK (entry_kind IN ('card','catalog','page','domain')),
    entry_url TEXT NOT NULL,
    candidates JSONB NOT NULL CHECK (jsonb_typeof(candidates) = 'array'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX plugin_discoveries_owner ON plugin_discoveries(user_id, expires_at);

CREATE TABLE plugin_connections (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES identities(id),
    service_id UUID NOT NULL REFERENCES plugin_services(id),
    candidate JSONB NOT NULL,
    pending_candidate JSONB,
    tools_snapshot JSONB,
    pending_tools JSONB,
    schema_fingerprint TEXT,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','auth_required','blocked','needs_review','revoked')),
    auth_status TEXT NOT NULL DEFAULT 'none' CHECK (auth_status IN ('none','required','authorized','blocked')),
    auth_challenge JSONB,
    requested_scopes TEXT[] NOT NULL DEFAULT '{}',
    last_error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, service_id),
    UNIQUE(id, user_id)
);
CREATE INDEX plugin_connections_owner ON plugin_connections(user_id, created_at DESC);

CREATE TABLE plugin_oauth_attempts (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    connection_id UUID NOT NULL,
    connection_revision BIGINT NOT NULL,
    state_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(state_hash) = 32),
    encrypted_verifier BYTEA,
    issuer TEXT NOT NULL,
    resource TEXT NOT NULL,
    token_endpoint TEXT NOT NULL,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    scopes TEXT[] NOT NULL,
    require_response_iss BOOLEAN NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','exchanging','succeeded','failed','expired')),
    error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY(connection_id,user_id) REFERENCES plugin_connections(id,user_id)
);
CREATE INDEX plugin_oauth_attempts_owner ON plugin_oauth_attempts(user_id, connection_id, expires_at);

CREATE TABLE plugin_oauth_tokens (
    connection_id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    connection_revision BIGINT NOT NULL,
    issuer TEXT NOT NULL,
    resource TEXT NOT NULL,
    token_endpoint TEXT NOT NULL,
    client_id TEXT NOT NULL,
    encrypted_tokens BYTEA NOT NULL CHECK (octet_length(encrypted_tokens) > 28),
    scopes TEXT[] NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    refresh_state TEXT NOT NULL DEFAULT 'ready' CHECK (refresh_state IN ('ready','refreshing')),
    refresh_deadline TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY(connection_id,user_id) REFERENCES plugin_connections(id,user_id)
);

CREATE TABLE plugin_invocations (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    connection_id UUID NOT NULL,
    connection_revision BIGINT NOT NULL,
    idempotency_key UUID NOT NULL,
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    tool_name TEXT NOT NULL,
    arguments JSONB NOT NULL,
    tool_snapshot JSONB NOT NULL,
    connection_snapshot JSONB NOT NULL CHECK (jsonb_typeof(connection_snapshot) = 'object'),
    schema_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'awaiting_confirmation' CHECK (status IN ('awaiting_confirmation','running','succeeded','tool_error','unknown','cancelled','expired','input_required','failed')),
    result JSONB,
    error_code TEXT,
    confirmed_at TIMESTAMPTZ,
    execution_deadline TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    UNIQUE(user_id,idempotency_key),
    FOREIGN KEY(connection_id,user_id) REFERENCES plugin_connections(id,user_id)
);
CREATE INDEX plugin_invocations_owner ON plugin_invocations(user_id, created_at DESC);

-- A confirmation always refers to the original arguments, tool and connection revision.
CREATE FUNCTION plugin_invocation_identity_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
      OR NEW.connection_revision IS DISTINCT FROM OLD.connection_revision
      OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
      OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
      OR NEW.tool_name IS DISTINCT FROM OLD.tool_name OR NEW.arguments IS DISTINCT FROM OLD.arguments
      OR NEW.tool_snapshot IS DISTINCT FROM OLD.tool_snapshot
      OR NEW.connection_snapshot IS DISTINCT FROM OLD.connection_snapshot
      OR NEW.schema_fingerprint IS DISTINCT FROM OLD.schema_fingerprint
      OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
        RAISE EXCEPTION 'plugin invocation proposal is immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER plugin_invocation_identity BEFORE UPDATE ON plugin_invocations
  FOR EACH ROW EXECUTE FUNCTION plugin_invocation_identity_immutable();
