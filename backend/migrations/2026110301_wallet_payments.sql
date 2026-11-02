-- Real HKD is isolated from the unchanged QDC and bank_demo journals.
CREATE TABLE payment_quotes (
 id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES identities(id), channel TEXT NOT NULL CHECK(channel IN ('wechat','alipay')),
 merchant_id TEXT NOT NULL, credential_version TEXT NOT NULL CHECK(length(credential_version) BETWEEN 1 AND 64),
 credit_minor BIGINT NOT NULL CHECK(credit_minor BETWEEN 1 AND 9007199254740991),
 base_minor BIGINT NOT NULL CHECK(base_minor BETWEEN 1 AND 9007199254740991),
 fee_minor BIGINT NOT NULL CHECK(fee_minor BETWEEN 0 AND 9007199254740991),
 pay_minor BIGINT NOT NULL CHECK(pay_minor BETWEEN 1 AND 9007199254740991),
 fee_bps INTEGER NOT NULL CHECK(fee_bps BETWEEN 0 AND 10000),
 rate_snapshot JSONB NOT NULL, config_fingerprint BYTEA NOT NULL CHECK(octet_length(config_fingerprint)=32),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), expires_at TIMESTAMPTZ NOT NULL,
 CHECK(pay_minor=base_minor+fee_minor), CHECK(expires_at>created_at), UNIQUE(id,user_id), UNIQUE(id,user_id,merchant_id,credential_version)
);
CREATE TABLE payment_orders (
 id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES identities(id), quote_id UUID NOT NULL UNIQUE,
 client_request_id UUID NOT NULL, merchant_id TEXT NOT NULL, credential_version TEXT NOT NULL, merchant_no TEXT NOT NULL UNIQUE,
 provider_trade_no TEXT, status TEXT NOT NULL CHECK(status IN ('creating','awaiting_payment','confirming','awaiting_credit_approval','crediting','credited','expired','failed','review_required')),
 version BIGINT NOT NULL DEFAULT 1 CHECK(version>0), evidence_version BIGINT NOT NULL DEFAULT 0 CHECK(evidence_version>=0),
 evidence_hash BYTEA, provider_paid_at_raw TEXT CHECK(octet_length(provider_paid_at_raw)<=128), provider_paid_at TIMESTAMPTZ,
 verified_at TIMESTAMPTZ, may_have_sent_at TIMESTAMPTZ, checkout_url TEXT, checkout_expires_at TIMESTAMPTZ NOT NULL,
 checkout_detached BOOLEAN NOT NULL DEFAULT false, resolved BOOLEAN NOT NULL DEFAULT false,
 error_code TEXT, credited_transaction_id UUID UNIQUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,client_request_id), UNIQUE(id,user_id), UNIQUE(merchant_id,provider_trade_no),
 FOREIGN KEY(quote_id,user_id,merchant_id,credential_version) REFERENCES payment_quotes(id,user_id,merchant_id,credential_version),
 CHECK((verified_at IS NULL AND evidence_hash IS NULL AND evidence_version=0) OR (verified_at IS NOT NULL AND octet_length(evidence_hash)=32 AND evidence_version>0)),
 CHECK((status='credited')=(credited_transaction_id IS NOT NULL)),
 CHECK(NOT resolved OR status='credited' OR (status='failed' AND error_code='not_created' AND may_have_sent_at IS NULL AND verified_at IS NULL AND evidence_hash IS NULL AND provider_trade_no IS NULL AND checkout_url IS NULL AND credited_transaction_id IS NULL))
);
CREATE INDEX payment_orders_owner ON payment_orders(user_id,created_at DESC,id DESC);
CREATE TABLE payment_checkout_slots (
 user_id UUID PRIMARY KEY REFERENCES identities(id), payment_id UUID NOT NULL UNIQUE,
 FOREIGN KEY(payment_id,user_id) REFERENCES payment_orders(id,user_id)
);
CREATE TABLE payment_jobs (
 payment_id UUID PRIMARY KEY REFERENCES payment_orders(id), epoch BIGINT NOT NULL DEFAULT 0,
 token UUID, leased_until TIMESTAMPTZ, captured_version BIGINT,
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), attempts INTEGER NOT NULL DEFAULT 0,
 CHECK((token IS NULL AND leased_until IS NULL AND captured_version IS NULL) OR (token IS NOT NULL AND leased_until IS NOT NULL AND captured_version IS NOT NULL))
);
CREATE INDEX payment_jobs_due ON payment_jobs(next_attempt_at);
CREATE TABLE payment_notifications (
 id UUID PRIMARY KEY, payment_id UUID NOT NULL REFERENCES payment_orders(id), fingerprint BYTEA NOT NULL UNIQUE CHECK(octet_length(fingerprint)=32),
 received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE payment_proposals (
 id UUID PRIMARY KEY, payment_id UUID NOT NULL REFERENCES payment_orders(id), maker_id UUID NOT NULL REFERENCES identities(id),
 evidence_version BIGINT NOT NULL CHECK(evidence_version>0), evidence_hash BYTEA NOT NULL CHECK(octet_length(evidence_hash)=32),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), UNIQUE(payment_id,evidence_version)
);
CREATE TABLE payment_approvals (
 id UUID PRIMARY KEY, payment_id UUID NOT NULL UNIQUE REFERENCES payment_orders(id), proposal_id UUID NOT NULL UNIQUE REFERENCES payment_proposals(id),
 maker_id UUID NOT NULL REFERENCES identities(id), checker_id UUID NOT NULL REFERENCES identities(id),
 evidence_version BIGINT NOT NULL, evidence_hash BYTEA NOT NULL CHECK(octet_length(evidence_hash)=32),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), CHECK(maker_id<>checker_id)
);
CREATE TABLE real_hkd_accounts (
 id UUID PRIMARY KEY, user_id UUID UNIQUE REFERENCES identities(id), kind TEXT NOT NULL CHECK(kind IN ('user','clearing')),
 currency TEXT NOT NULL DEFAULT 'HKD' CHECK(currency='HKD'), balance_minor BIGINT NOT NULL DEFAULT 0,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CHECK((kind='user' AND user_id IS NOT NULL AND balance_minor BETWEEN 0 AND 9007199254740991) OR (kind='clearing' AND user_id IS NULL))
);
CREATE UNIQUE INDEX one_real_hkd_clearing ON real_hkd_accounts(kind) WHERE kind='clearing';
CREATE TABLE real_hkd_transactions (
 id UUID PRIMARY KEY, payment_id UUID NOT NULL UNIQUE REFERENCES payment_orders(id),
 source_account_id UUID NOT NULL REFERENCES real_hkd_accounts(id), destination_account_id UUID NOT NULL REFERENCES real_hkd_accounts(id),
 amount_minor BIGINT NOT NULL CHECK(amount_minor BETWEEN 1 AND 9007199254740991),
 source_balance_after BIGINT NOT NULL, destination_balance_after BIGINT NOT NULL CHECK(destination_balance_after BETWEEN 0 AND 9007199254740991),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), CHECK(source_account_id<>destination_account_id)
);
ALTER TABLE payment_orders ADD CONSTRAINT payment_credit_transaction FOREIGN KEY(credited_transaction_id) REFERENCES real_hkd_transactions(id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE real_hkd_entries (
 id UUID PRIMARY KEY, transaction_id UUID NOT NULL REFERENCES real_hkd_transactions(id), account_id UUID NOT NULL REFERENCES real_hkd_accounts(id),
 delta_minor BIGINT NOT NULL CHECK(delta_minor<>0), balance_after_minor BIGINT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), UNIQUE(transaction_id,account_id)
);
CREATE INDEX real_hkd_entries_account ON real_hkd_entries(account_id,created_at DESC,id DESC);
CREATE FUNCTION reject_payment_immutable_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'payment evidence and posted HKD records are immutable'; END; $$;
CREATE TRIGGER immutable_payment_quote BEFORE UPDATE OR DELETE ON payment_quotes FOR EACH ROW EXECUTE FUNCTION reject_payment_immutable_mutation();
CREATE TRIGGER immutable_payment_notification BEFORE UPDATE OR DELETE ON payment_notifications FOR EACH ROW EXECUTE FUNCTION reject_payment_immutable_mutation();
CREATE TRIGGER immutable_payment_proposal BEFORE UPDATE OR DELETE ON payment_proposals FOR EACH ROW EXECUTE FUNCTION reject_payment_immutable_mutation();
CREATE TRIGGER immutable_payment_approval BEFORE UPDATE OR DELETE ON payment_approvals FOR EACH ROW EXECUTE FUNCTION reject_payment_immutable_mutation();
CREATE TRIGGER immutable_real_hkd_transaction BEFORE UPDATE OR DELETE ON real_hkd_transactions FOR EACH ROW EXECUTE FUNCTION reject_payment_immutable_mutation();
CREATE TRIGGER immutable_real_hkd_entry BEFORE UPDATE OR DELETE ON real_hkd_entries FOR EACH ROW EXECUTE FUNCTION reject_payment_immutable_mutation();
CREATE FUNCTION preserve_payment_order() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'payment orders must be retained'; END IF;
 IF (NEW.id,NEW.user_id,NEW.quote_id,NEW.client_request_id,NEW.merchant_id,NEW.credential_version,NEW.merchant_no,NEW.created_at,NEW.checkout_expires_at)
 IS DISTINCT FROM (OLD.id,OLD.user_id,OLD.quote_id,OLD.client_request_id,OLD.merchant_id,OLD.credential_version,OLD.merchant_no,OLD.created_at,OLD.checkout_expires_at)
 OR (OLD.provider_trade_no IS NOT NULL AND NEW.provider_trade_no IS DISTINCT FROM OLD.provider_trade_no)
 OR (OLD.may_have_sent_at IS NOT NULL AND NEW.may_have_sent_at IS DISTINCT FROM OLD.may_have_sent_at)
 OR (OLD.verified_at IS NOT NULL AND (NEW.verified_at,NEW.provider_paid_at_raw,NEW.provider_paid_at,NEW.evidence_hash,NEW.evidence_version) IS DISTINCT FROM (OLD.verified_at,OLD.provider_paid_at_raw,OLD.provider_paid_at,OLD.evidence_hash,OLD.evidence_version))
 OR (OLD.resolved AND NEW IS DISTINCT FROM OLD)
 OR (OLD.verified_at IS NOT NULL AND NEW.status NOT IN ('awaiting_credit_approval','review_required','crediting','credited'))
 OR NEW.version<>OLD.version+1 OR (OLD.checkout_detached AND NOT NEW.checkout_detached)
 THEN RAISE EXCEPTION 'immutable payment identity or monotonic evidence changed'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER preserve_payment_order BEFORE UPDATE OR DELETE ON payment_orders FOR EACH ROW EXECUTE FUNCTION preserve_payment_order();
CREATE FUNCTION preserve_real_hkd_account() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'real HKD accounts must be retained'; END IF;
 IF TG_OP='UPDATE' AND (NEW.id,NEW.user_id,NEW.kind,NEW.currency) IS DISTINCT FROM (OLD.id,OLD.user_id,OLD.kind,OLD.currency) THEN RAISE EXCEPTION 'real HKD account identity is immutable'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER preserve_real_hkd_account BEFORE UPDATE OR DELETE ON real_hkd_accounts FOR EACH ROW EXECUTE FUNCTION preserve_real_hkd_account();
CREATE FUNCTION check_real_hkd_pair() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE t real_hkd_transactions%ROWTYPE; target UUID; n BIGINT; net NUMERIC; matched BIGINT; owner UUID; quoted BIGINT; state TEXT;
BEGIN
 IF TG_TABLE_NAME='real_hkd_transactions' THEN target:=NEW.id; ELSE target:=NEW.transaction_id; END IF;
 SELECT * INTO STRICT t FROM real_hkd_transactions WHERE id=target;
 SELECT o.user_id,q.credit_minor,o.status INTO owner,quoted,state FROM payment_orders o JOIN payment_quotes q ON q.id=o.quote_id WHERE o.id=t.payment_id;
 IF NOT EXISTS(SELECT 1 FROM real_hkd_accounts WHERE id=t.source_account_id AND kind='clearing') OR NOT EXISTS(SELECT 1 FROM real_hkd_accounts WHERE id=t.destination_account_id AND user_id=owner AND kind='user') OR quoted<>t.amount_minor OR state<>'credited'
 OR NOT EXISTS(SELECT 1 FROM payment_orders o JOIN payment_approvals a ON a.payment_id=o.id JOIN payment_proposals p ON p.id=a.proposal_id
 WHERE o.id=t.payment_id AND o.credited_transaction_id=t.id AND o.resolved AND o.verified_at IS NOT NULL
 AND o.provider_paid_at BETWEEN o.created_at AND o.checkout_expires_at AND o.provider_paid_at<=clock_timestamp()
 AND o.evidence_version=a.evidence_version AND a.evidence_version=p.evidence_version AND p.payment_id=o.id
 AND o.evidence_hash=a.evidence_hash AND a.evidence_hash=p.evidence_hash AND a.maker_id=p.maker_id AND a.checker_id<>a.maker_id)
 THEN RAISE EXCEPTION 'HKD posting requires matching approved payment'; END IF;
 SELECT count(*),coalesce(sum(delta_minor),0),count(*) FILTER(WHERE (account_id=t.source_account_id AND delta_minor=-t.amount_minor AND balance_after_minor=t.source_balance_after) OR (account_id=t.destination_account_id AND delta_minor=t.amount_minor AND balance_after_minor=t.destination_balance_after)) INTO n,net,matched FROM real_hkd_entries WHERE transaction_id=target;
 IF n<>2 OR net<>0 OR matched<>2 THEN RAISE EXCEPTION 'real HKD transaction requires matching balanced entries'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER balanced_real_hkd_transaction AFTER INSERT ON real_hkd_transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_real_hkd_pair();
CREATE CONSTRAINT TRIGGER balanced_real_hkd_entry AFTER INSERT ON real_hkd_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_real_hkd_pair();
CREATE FUNCTION check_real_hkd_balance() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target UUID; cached BIGINT; actual NUMERIC;
BEGIN
 IF TG_TABLE_NAME='real_hkd_accounts' THEN target:=NEW.id; ELSE target:=NEW.account_id; END IF;
 SELECT balance_minor INTO STRICT cached FROM real_hkd_accounts WHERE id=target;
 SELECT coalesce(sum(delta_minor),0) INTO actual FROM real_hkd_entries WHERE account_id=target;
 IF cached<>actual THEN RAISE EXCEPTION 'real HKD cached balance must equal journal'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER valid_real_hkd_balance AFTER INSERT OR UPDATE ON real_hkd_accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_real_hkd_balance();
CREATE CONSTRAINT TRIGGER valid_real_hkd_entry_balance AFTER INSERT ON real_hkd_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_real_hkd_balance();
CREATE FUNCTION check_payment_credit_consistency() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='credited' AND NOT EXISTS(SELECT 1 FROM real_hkd_transactions t WHERE t.id=NEW.credited_transaction_id AND t.payment_id=NEW.id) THEN RAISE EXCEPTION 'credited payment must reference its own journal transaction'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER consistent_payment_credit AFTER INSERT OR UPDATE ON payment_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_payment_credit_consistency();
INSERT INTO real_hkd_accounts(id,kind) VALUES('00000000-0000-4000-8000-000000000002','clearing');
