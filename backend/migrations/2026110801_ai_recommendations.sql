CREATE TABLE ai_recommendations (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL,
    source_message_id text NOT NULL CHECK (length(source_message_id) BETWEEN 1 AND 200),
    source_fingerprint bytea NOT NULL CHECK (octet_length(source_fingerprint) = 32),
    request_id uuid NOT NULL,
    locale text NOT NULL CHECK (locale IN ('zh', 'en')),
    status text NOT NULL CHECK (status IN ('pending', 'complete', 'skipped')),
    candidates jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(candidates) = 'array' AND jsonb_array_length(candidates) <= 3),
    catalog_version text NOT NULL DEFAULT 'pending-v1' CHECK (length(catalog_version) > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    lease_until timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '5 seconds'),
    expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '7 days'),
    FOREIGN KEY (user_id, conversation_id) REFERENCES ai_conversations(user_id, id) ON DELETE CASCADE,
    UNIQUE (user_id, request_id),
    UNIQUE (user_id, conversation_id, source_message_id, source_fingerprint),
    UNIQUE (user_id, id)
);

CREATE INDEX ai_recommendations_conversation
    ON ai_recommendations(user_id, conversation_id, created_at DESC, id DESC);

-- Bind additional device request keys without repeating the ranking request.
CREATE TABLE ai_recommendation_requests (
    user_id uuid NOT NULL,
    request_id uuid NOT NULL,
    recommendation_id uuid NOT NULL,
    locale text NOT NULL CHECK (locale IN ('zh', 'en')),
    PRIMARY KEY (user_id, request_id),
    FOREIGN KEY (user_id, recommendation_id) REFERENCES ai_recommendations(user_id, id) ON DELETE CASCADE
);

CREATE INDEX ai_recommendation_request_record
    ON ai_recommendation_requests(user_id, recommendation_id);

CREATE TABLE ai_recommendation_selections (
    user_id uuid NOT NULL,
    recommendation_id uuid NOT NULL,
    candidate_id text NOT NULL,
    conversation_id uuid,
    first_message_count integer NOT NULL CHECK (first_message_count > 0),
    outcome text CHECK (outcome IN ('answered', 'tool_succeeded', 'error', 'cancelled')),
    finished_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (user_id, recommendation_id, candidate_id),
    FOREIGN KEY (user_id, recommendation_id) REFERENCES ai_recommendations(user_id, id) ON DELETE CASCADE,
    FOREIGN KEY (user_id, conversation_id) REFERENCES ai_conversations(user_id, id) ON DELETE SET NULL (conversation_id)
);

CREATE INDEX ai_recommendation_selection_target
    ON ai_recommendation_selections(user_id, conversation_id) WHERE conversation_id IS NOT NULL;
