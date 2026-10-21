-- First-party bank simulations share Q identity, never the QDC ledger or remote MCP authority.
ALTER TABLE plugin_connections
    ADD COLUMN connection_kind TEXT NOT NULL DEFAULT 'remote_mcp',
    ADD COLUMN builtin_service_id TEXT,
    ADD CONSTRAINT plugin_connection_executor CHECK (
        (connection_kind = 'remote_mcp' AND builtin_service_id IS NULL)
        OR (connection_kind = 'bank_demo' AND builtin_service_id IN (
            'q.bank-demo.hsbc', 'q.bank-demo.hangseng', 'q.bank-demo.bochk', 'q.bank-demo.scb',
            'q.bank-demo.bea', 'q.bank-demo.dbs', 'q.bank-demo.citi', 'q.bank-demo.icbc',
            'q.bank-demo.ccb', 'q.bank-demo.ncb', 'q.bank-demo.citic', 'q.bank-demo.cmbwinglung',
            'q.bank-demo.dahsing', 'q.bank-demo.fubon', 'q.bank-demo.chiyu', 'q.bank-demo.shacombank',
            'q.bank-demo.bocom', 'q.bank-demo.za', 'q.bank-demo.mox', 'q.bank-demo.livi'
        ) AND builtin_service_id IS NOT NULL)
    );
ALTER TABLE plugin_connections DROP CONSTRAINT plugin_connections_auth_status_check;
ALTER TABLE plugin_connections ADD CONSTRAINT plugin_connections_auth_status_check CHECK (
    (connection_kind = 'remote_mcp' AND auth_status IN ('none','required','authorized','blocked'))
    OR (connection_kind = 'bank_demo' AND auth_status = 'anonymous')
);
CREATE UNIQUE INDEX one_owned_builtin_bank ON plugin_connections(user_id,builtin_service_id)
    WHERE connection_kind = 'bank_demo';

CREATE TABLE bank_demo_accounts (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES identities(id),
    bank_id TEXT CHECK (bank_id IN ('hsbc','hangseng','bochk','scb','bea','dbs','citi','icbc','ccb','ncb','citic','cmbwinglung','dahsing','fubon','chiyu','shacombank','bocom','za','mox','livi')),
    participant TEXT NOT NULL CHECK (participant IN ('self','demo_chen','issuance')),
    currency TEXT NOT NULL DEFAULT 'HKD' CHECK (currency = 'HKD'),
    balance_minor BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(id,user_id),
    CHECK ((participant = 'issuance' AND bank_id IS NULL)
        OR (participant IN ('self','demo_chen') AND bank_id IS NOT NULL AND balance_minor >= 0))
);
CREATE UNIQUE INDEX one_bank_demo_account ON bank_demo_accounts(user_id,bank_id,participant)
    WHERE participant <> 'issuance';
CREATE UNIQUE INDEX one_bank_demo_issuer ON bank_demo_accounts(user_id)
    WHERE participant = 'issuance';

CREATE TABLE bank_demo_transactions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES identities(id),
    kind TEXT NOT NULL CHECK (kind IN ('initial','transfer')),
    invocation_id UUID,
    request_fingerprint BYTEA,
    source_account_id UUID NOT NULL,
    destination_account_id UUID NOT NULL,
    amount_minor BIGINT NOT NULL CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
    source_balance_after BIGINT NOT NULL,
    destination_balance_after BIGINT NOT NULL CHECK (destination_balance_after >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(id,user_id),
    FOREIGN KEY(source_account_id,user_id) REFERENCES bank_demo_accounts(id,user_id),
    FOREIGN KEY(destination_account_id,user_id) REFERENCES bank_demo_accounts(id,user_id),
    CHECK (source_account_id <> destination_account_id),
    CHECK ((kind = 'initial' AND invocation_id IS NULL AND request_fingerprint IS NULL AND amount_minor = 10000000)
        OR (kind = 'transfer' AND invocation_id IS NOT NULL AND request_fingerprint IS NOT NULL AND octet_length(request_fingerprint) = 32))
);
-- Invocation rows are erased on account deletion; the minimal immutable journal remains.
CREATE UNIQUE INDEX one_bank_demo_invocation ON bank_demo_transactions(user_id,invocation_id)
    WHERE invocation_id IS NOT NULL;
CREATE UNIQUE INDEX one_bank_demo_initial_credit ON bank_demo_transactions(destination_account_id)
    WHERE kind = 'initial';
CREATE INDEX bank_demo_transactions_owner ON bank_demo_transactions(user_id,created_at DESC,id DESC);

CREATE TABLE bank_demo_entries (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES identities(id),
    transaction_id UUID NOT NULL,
    account_id UUID NOT NULL,
    delta_minor BIGINT NOT NULL CHECK (delta_minor <> 0),
    balance_after_minor BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY(transaction_id,user_id) REFERENCES bank_demo_transactions(id,user_id),
    FOREIGN KEY(account_id,user_id) REFERENCES bank_demo_accounts(id,user_id),
    UNIQUE(transaction_id,account_id)
);
CREATE INDEX bank_demo_entries_owner ON bank_demo_entries(user_id,created_at DESC,id DESC);
CREATE INDEX bank_demo_entries_account ON bank_demo_entries(account_id,created_at DESC,id DESC);

-- Free-text memo content can be erased without modifying posted amounts or entries.
CREATE TABLE bank_demo_private_memos (
    transaction_id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES identities(id),
    memo TEXT NOT NULL CHECK (char_length(memo) <= 120),
    FOREIGN KEY(transaction_id,user_id) REFERENCES bank_demo_transactions(id,user_id)
);

CREATE FUNCTION reject_bank_demo_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'posted bank demo records are immutable'; END;
$$;
CREATE TRIGGER immutable_bank_demo_transactions BEFORE UPDATE OR DELETE ON bank_demo_transactions
    FOR EACH ROW EXECUTE FUNCTION reject_bank_demo_mutation();
CREATE TRIGGER immutable_bank_demo_entries BEFORE UPDATE OR DELETE ON bank_demo_entries
    FOR EACH ROW EXECUTE FUNCTION reject_bank_demo_mutation();

CREATE FUNCTION preserve_bank_demo_account() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE owner_status TEXT;
BEGIN
    IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.bank_id IS DISTINCT FROM OLD.bank_id OR NEW.participant IS DISTINCT FROM OLD.participant
        OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
        RAISE EXCEPTION 'bank demo account identity is immutable';
    END IF;
    -- Erasure can disable an account after marking the identity deleted; it never changes money.
    IF TG_OP = 'UPDATE' AND NEW.status = 'disabled' AND NEW.balance_minor = OLD.balance_minor THEN
        RETURN NEW;
    END IF;
    SELECT status INTO owner_status FROM identities WHERE id = NEW.user_id FOR SHARE;
    IF owner_status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'account is unavailable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER bank_demo_account_identity BEFORE INSERT OR UPDATE ON bank_demo_accounts
    FOR EACH ROW EXECUTE FUNCTION preserve_bank_demo_account();
CREATE TRIGGER active_bank_demo_transaction_owner BEFORE INSERT ON bank_demo_transactions
    FOR EACH ROW EXECUTE FUNCTION require_active_record_owner();
CREATE TRIGGER active_bank_demo_entry_owner BEFORE INSERT ON bank_demo_entries
    FOR EACH ROW EXECUTE FUNCTION require_active_record_owner();
CREATE TRIGGER active_bank_demo_memo_owner BEFORE INSERT OR UPDATE ON bank_demo_private_memos
    FOR EACH ROW EXECUTE FUNCTION require_active_record_owner();

CREATE FUNCTION check_bank_demo_pair() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE item bank_demo_transactions%ROWTYPE;
target_id UUID; entry_count BIGINT; net NUMERIC; matched_count BIGINT;
source_participant TEXT; destination_participant TEXT;
BEGIN
    IF TG_TABLE_NAME = 'bank_demo_transactions' THEN target_id := NEW.id;
    ELSE target_id := NEW.transaction_id; END IF;
    SELECT * INTO STRICT item FROM bank_demo_transactions WHERE id = target_id;
    SELECT participant INTO STRICT source_participant FROM bank_demo_accounts WHERE id = item.source_account_id;
    SELECT participant INTO STRICT destination_participant FROM bank_demo_accounts WHERE id = item.destination_account_id;
    IF (item.kind = 'initial' AND source_participant <> 'issuance')
       OR (item.kind = 'transfer' AND source_participant <> 'self')
       OR destination_participant NOT IN ('self','demo_chen') THEN
        RAISE EXCEPTION 'invalid bank demo posting participants';
    END IF;
    SELECT count(*),coalesce(sum(delta_minor),0),count(*) FILTER (WHERE
        (account_id = item.source_account_id AND delta_minor = -item.amount_minor AND balance_after_minor = item.source_balance_after)
        OR (account_id = item.destination_account_id AND delta_minor = item.amount_minor AND balance_after_minor = item.destination_balance_after))
        INTO entry_count,net,matched_count FROM bank_demo_entries WHERE transaction_id = target_id;
    IF entry_count <> 2 OR net <> 0 OR matched_count <> 2 THEN
        RAISE EXCEPTION 'bank demo transaction requires its matching balanced pair';
    END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER balanced_bank_demo_transaction AFTER INSERT ON bank_demo_transactions
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_bank_demo_pair();
CREATE CONSTRAINT TRIGGER balanced_bank_demo_entry AFTER INSERT ON bank_demo_entries
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_bank_demo_pair();

CREATE FUNCTION check_bank_demo_balance() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target_id UUID; cached BIGINT; actual NUMERIC;
BEGIN
    IF TG_TABLE_NAME = 'bank_demo_accounts' THEN target_id := NEW.id;
    ELSE target_id := NEW.account_id; END IF;
    SELECT balance_minor INTO STRICT cached FROM bank_demo_accounts WHERE id = target_id;
    SELECT coalesce(sum(delta_minor),0) INTO actual FROM bank_demo_entries WHERE account_id = target_id;
    IF cached <> actual THEN RAISE EXCEPTION 'bank demo cached balance must match its journal'; END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER valid_bank_demo_account_balance AFTER INSERT OR UPDATE ON bank_demo_accounts
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_bank_demo_balance();
CREATE CONSTRAINT TRIGGER valid_bank_demo_entry_balance AFTER INSERT ON bank_demo_entries
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_bank_demo_balance();
