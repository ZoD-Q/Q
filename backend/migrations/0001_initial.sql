CREATE TABLE identities (
    id UUID PRIMARY KEY,
    handle TEXT NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9_]{3,24}$'),
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE profiles (
    user_id UUID PRIMARY KEY REFERENCES identities(id),
    display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 40),
    avatar TEXT NOT NULL DEFAULT 'orbit' CHECK (avatar IN ('orbit','leaf','spark','wave')),
    bio TEXT NOT NULL DEFAULT '' CHECK (char_length(bio) <= 160),
    theme TEXT NOT NULL DEFAULT 'warm' CHECK (theme IN ('light','dark','warm')),
    locale TEXT NOT NULL DEFAULT 'zh-CN' CHECK (locale IN ('zh-CN','en'))
);

CREATE TABLE sessions (
    token_hash BYTEA PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    user_id UUID NOT NULL REFERENCES identities(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE ledger_accounts (
    id UUID PRIMARY KEY,
    user_id UUID UNIQUE REFERENCES identities(id),
    kind TEXT NOT NULL CHECK (kind IN ('user','treasury')),
    currency TEXT NOT NULL DEFAULT 'QDC' CHECK (currency = 'QDC'),
    balance_minor BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((kind = 'user' AND user_id IS NOT NULL AND balance_minor >= 0)
        OR (kind = 'treasury' AND user_id IS NULL))
);
CREATE UNIQUE INDEX one_treasury ON ledger_accounts(kind) WHERE kind = 'treasury';

CREATE TABLE ledger_transactions (
    id UUID PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('welcome','transfer')),
    sender_account_id UUID NOT NULL REFERENCES ledger_accounts(id),
    recipient_account_id UUID NOT NULL REFERENCES ledger_accounts(id),
    amount_minor BIGINT NOT NULL CHECK (amount_minor BETWEEN 1 AND 100000000),
    memo TEXT NOT NULL CHECK (char_length(memo) <= 80),
    idempotency_key UUID,
    sender_balance_after BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (sender_account_id <> recipient_account_id),
    CHECK ((kind = 'welcome' AND idempotency_key IS NULL)
        OR (kind = 'transfer' AND idempotency_key IS NOT NULL))
);
CREATE UNIQUE INDEX sender_idempotency_key ON ledger_transactions(sender_account_id,idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE TABLE ledger_entries (
    id UUID PRIMARY KEY,
    transaction_id UUID NOT NULL REFERENCES ledger_transactions(id),
    account_id UUID NOT NULL REFERENCES ledger_accounts(id),
    delta_minor BIGINT NOT NULL CHECK (delta_minor <> 0),
    UNIQUE(transaction_id,account_id)
);
CREATE INDEX ledger_entries_account_idx ON ledger_entries(account_id,transaction_id);

-- Entries and posted transactions are append-only, including direct SQL writes.
CREATE FUNCTION reject_ledger_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'posted ledger records are immutable';
END;
$$;
CREATE TRIGGER immutable_entries BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER immutable_transactions BEFORE UPDATE OR DELETE ON ledger_transactions
    FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE FUNCTION preserve_account_identity() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'ledger account identity is immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_account_identity BEFORE UPDATE ON ledger_accounts
    FOR EACH ROW EXECUTE FUNCTION preserve_account_identity();

-- Deferred checks inspect the completed transaction, never a transient half-transfer.
CREATE FUNCTION check_balanced_transaction() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE tx ledger_transactions%ROWTYPE;
target_id UUID;
entry_count BIGINT;
matched_count BIGINT;
net NUMERIC;
BEGIN
    IF TG_TABLE_NAME = 'ledger_transactions' THEN target_id := NEW.id;
    ELSE target_id := NEW.transaction_id;
    END IF;
    SELECT * INTO STRICT tx FROM ledger_transactions WHERE id = target_id;
    SELECT count(*), coalesce(sum(delta_minor),0),
        count(*) FILTER (WHERE (account_id = tx.sender_account_id AND delta_minor = -tx.amount_minor)
            OR (account_id = tx.recipient_account_id AND delta_minor = tx.amount_minor))
        INTO entry_count, net, matched_count FROM ledger_entries WHERE transaction_id = target_id;
    IF entry_count <> 2 OR net <> 0 OR matched_count <> 2 THEN
        RAISE EXCEPTION 'ledger transaction must contain its matching balanced pair';
    END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER balanced_transaction AFTER INSERT ON ledger_transactions
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_balanced_transaction();
CREATE CONSTRAINT TRIGGER balanced_entries AFTER INSERT ON ledger_entries
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_balanced_transaction();

CREATE FUNCTION check_account_balance() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target_id UUID;
cached BIGINT;
actual NUMERIC;
BEGIN
    IF TG_TABLE_NAME = 'ledger_accounts' THEN target_id := NEW.id;
    ELSE target_id := NEW.account_id;
    END IF;
    SELECT balance_minor INTO STRICT cached FROM ledger_accounts WHERE id = target_id;
    SELECT coalesce(sum(delta_minor),0) INTO actual FROM ledger_entries WHERE account_id = target_id;
    IF cached <> actual THEN RAISE EXCEPTION 'cached balance must match immutable ledger'; END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER valid_account_balance AFTER INSERT OR UPDATE ON ledger_accounts
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_account_balance();
CREATE CONSTRAINT TRIGGER valid_entry_balance AFTER INSERT ON ledger_entries
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_account_balance();

INSERT INTO ledger_accounts(id,kind) VALUES ('00000000-0000-4000-8000-000000000001','treasury');

