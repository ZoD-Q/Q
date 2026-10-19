-- User-owned provider connections are separate from Q identity and its demo ledger.
CREATE TABLE video_connections (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES identities(id),
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 48),
    provider TEXT NOT NULL DEFAULT 'kling' CHECK (provider = 'kling'),
    region TEXT NOT NULL CHECK (region IN ('cn', 'global')),
    encrypted_credentials BYTEA,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked BOOLEAN NOT NULL DEFAULT false,
    UNIQUE (id, user_id),
    CHECK ((revoked AND encrypted_credentials IS NULL)
        OR (NOT revoked AND encrypted_credentials IS NOT NULL AND octet_length(encrypted_credentials) > 28))
);
CREATE INDEX video_connections_user ON video_connections(user_id, created_at DESC);

CREATE TABLE video_jobs (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES identities(id),
    connection_id UUID NOT NULL,
    idempotency_key UUID NOT NULL,
    prompt TEXT NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 2500),
    model_name TEXT NOT NULL CHECK (model_name = 'kling-v2-6'),
    mode TEXT NOT NULL CHECK (mode = 'pro'),
    duration TEXT NOT NULL CHECK (duration IN ('5', '10')),
    aspect_ratio TEXT NOT NULL CHECK (aspect_ratio IN ('16:9', '9:16', '1:1')),
    status TEXT NOT NULL CHECK (status IN ('submitting','unknown','submitted','processing','succeeded','failed')),
    provider_task_id TEXT,
    video_url TEXT,
    error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_poll_at TIMESTAMPTZ,
    UNIQUE (user_id, idempotency_key),
    FOREIGN KEY (connection_id, user_id) REFERENCES video_connections(id, user_id)
);
CREATE INDEX video_jobs_user ON video_jobs(user_id, created_at DESC);
