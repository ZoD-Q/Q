CREATE TABLE ai_conversations (
    user_id uuid NOT NULL REFERENCES identities(id),
    id uuid NOT NULL,
    revision bigint NOT NULL CHECK (revision > 0),
    request_id uuid NOT NULL,
    expected_revision bigint NOT NULL CHECK (expected_revision >= 0),
    snapshot jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, id)
);
CREATE INDEX ai_conversations_created ON ai_conversations(user_id, created_at DESC, id DESC);
