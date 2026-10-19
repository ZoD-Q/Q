-- Social conversations are independent from AI history and the simulated ledger.
CREATE TABLE social_conversations (
    id UUID PRIMARY KEY,
    user_low UUID NOT NULL REFERENCES identities(id),
    user_high UUID NOT NULL REFERENCES identities(id),
    active BOOLEAN NOT NULL DEFAULT true,
    last_seq BIGINT NOT NULL DEFAULT 0 CHECK (last_seq BETWEEN 0 AND 9007199254740991),
    low_read_seq BIGINT NOT NULL DEFAULT 0,
    high_read_seq BIGINT NOT NULL DEFAULT 0,
    low_remark TEXT NOT NULL DEFAULT '' CHECK (char_length(low_remark) <= 40),
    high_remark TEXT NOT NULL DEFAULT '' CHECK (char_length(high_remark) <= 40),
    low_muted BOOLEAN NOT NULL DEFAULT false,
    high_muted BOOLEAN NOT NULL DEFAULT false,
    low_intimacy_enabled BOOLEAN NOT NULL DEFAULT true,
    high_intimacy_enabled BOOLEAN NOT NULL DEFAULT true,
    intimacy_score BIGINT NOT NULL DEFAULT 0 CHECK (intimacy_score >= 0),
    relationship_label TEXT CHECK (relationship_label IN ('close_friend','partner','couple')),
    proposed_label TEXT CHECK (proposed_label IN ('close_friend','partner','couple')),
    proposed_by UUID REFERENCES identities(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (user_low < user_high),
    CHECK (low_read_seq BETWEEN 0 AND last_seq AND high_read_seq BETWEEN 0 AND last_seq),
    CHECK ((proposed_label IS NULL AND proposed_by IS NULL) OR
           (proposed_label IS NOT NULL AND proposed_by IN (user_low,user_high)))
);
CREATE UNIQUE INDEX social_active_pair ON social_conversations(user_low,user_high) WHERE active;
CREATE INDEX social_conversations_low ON social_conversations(user_low,updated_at);
CREATE INDEX social_conversations_high ON social_conversations(user_high,updated_at);

CREATE TABLE social_requests (
    id UUID PRIMARY KEY,
    from_id UUID NOT NULL REFERENCES identities(id),
    to_id UUID NOT NULL REFERENCES identities(id),
    note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 80),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (from_id <> to_id)
);
CREATE UNIQUE INDEX social_request_pair ON social_requests(least(from_id,to_id),greatest(from_id,to_id));
CREATE INDEX social_requests_to ON social_requests(to_id);
CREATE INDEX social_requests_from ON social_requests(from_id);

CREATE TABLE social_blocks (
    blocker_id UUID NOT NULL REFERENCES identities(id),
    blocked_id UUID NOT NULL REFERENCES identities(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(blocker_id,blocked_id),
    CHECK (blocker_id <> blocked_id)
);

CREATE TABLE social_messages (
    id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES social_conversations(id),
    seq BIGINT NOT NULL CHECK (seq BETWEEN 1 AND 9007199254740991),
    sender_id UUID NOT NULL REFERENCES identities(id),
    client_message_id UUID NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text','ephemeral')),
    body TEXT,
    ttl_seconds INTEGER CHECK (ttl_seconds IN (30,300,86400)),
    opened_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    unopened_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(conversation_id,seq),
    UNIQUE(sender_id,client_message_id),
    CHECK ((kind='text' AND body IS NOT NULL AND char_length(body) BETWEEN 1 AND 2000
                AND ttl_seconds IS NULL AND opened_at IS NULL AND expires_at IS NULL AND unopened_expires_at IS NULL)
        OR (kind='ephemeral' AND body IS NULL AND ttl_seconds IS NOT NULL AND unopened_expires_at IS NOT NULL
                AND ((opened_at IS NULL AND expires_at IS NULL) OR (opened_at IS NOT NULL AND expires_at > opened_at))))
);
-- This table's data must be excluded from backups. Missing rows are permanently unavailable.
CREATE TABLE social_ephemeral_payloads (
    message_id UUID PRIMARY KEY REFERENCES social_messages(id) ON DELETE CASCADE,
    body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000)
);
CREATE INDEX social_message_expiry ON social_messages(expires_at,unopened_expires_at) WHERE kind='ephemeral';

CREATE TABLE social_daily_activity (
    conversation_id UUID NOT NULL REFERENCES social_conversations(id),
    day DATE NOT NULL,
    low_sent BOOLEAN NOT NULL DEFAULT false,
    high_sent BOOLEAN NOT NULL DEFAULT false,
    credited BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY(conversation_id,day)
);

CREATE TABLE social_notifications (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES identities(id),
    actor_id UUID NOT NULL REFERENCES identities(id),
    kind TEXT NOT NULL CHECK (kind IN ('friend_request','friend_accepted','relationship_proposed','relationship_accepted')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    read_at TIMESTAMPTZ
);
CREATE INDEX social_notifications_owner ON social_notifications(user_id,created_at);

CREATE TABLE social_reports (
    id UUID PRIMARY KEY,
    reporter_id UUID NOT NULL REFERENCES identities(id),
    reported_id UUID NOT NULL REFERENCES identities(id),
    message_id UUID REFERENCES social_messages(id),
    reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
    include_evidence BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    CHECK (reporter_id <> reported_id AND expires_at > created_at)
);
-- No public endpoint reads evidence. Exclude these data from backups as well.
CREATE TABLE social_report_evidence (
    report_id UUID PRIMARY KEY REFERENCES social_reports(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX social_reports_expiry ON social_reports(expires_at);
CREATE INDEX social_evidence_expiry ON social_report_evidence(expires_at);

-- Minimal idempotency tombstones outlive sensitive report metadata/evidence.
CREATE TABLE social_report_receipts (
    reporter_id UUID NOT NULL REFERENCES identities(id),
    client_report_id UUID NOT NULL,
    report_id UUID NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(reporter_id,client_report_id)
);
