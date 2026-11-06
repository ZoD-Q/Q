-- Additive operations records; existing immutable credits and their payment_id uniqueness remain.
CREATE TABLE payment_operator_policy (
 singleton BOOLEAN PRIMARY KEY CHECK(singleton), digest BYTEA NOT NULL CHECK(octet_length(digest)=32),
 generation BIGINT NOT NULL CHECK(generation>0), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE payment_operator_roles (
 user_id UUID NOT NULL, role TEXT NOT NULL CHECK(role IN ('maker','checker')), generation BIGINT NOT NULL CHECK(generation>0), PRIMARY KEY(user_id,role)
);
CREATE TABLE payment_operation_audit (
 id UUID PRIMARY KEY, actor_id UUID NOT NULL REFERENCES identities(id), payment_id UUID REFERENCES payment_orders(id),
 action TEXT NOT NULL CHECK(length(action) BETWEEN 1 AND 80), details JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX payment_operation_audit_order ON payment_operation_audit(payment_id,created_at,id);
CREATE TRIGGER immutable_payment_operation_audit BEFORE UPDATE OR DELETE ON payment_operation_audit FOR EACH ROW EXECUTE FUNCTION reject_payment_immutable_mutation();
CREATE TABLE payment_refunds (
 id UUID PRIMARY KEY, payment_id UUID NOT NULL UNIQUE REFERENCES payment_orders(id), client_request_id UUID NOT NULL,
 maker_id UUID NOT NULL REFERENCES identities(id), checker_id UUID REFERENCES identities(id),approved_at TIMESTAMPTZ,
 status TEXT NOT NULL CHECK(status IN ('requested','approved_external','unknown','evidence_pending','evidence_rejected','refunded')),
 version BIGINT NOT NULL DEFAULT 1 CHECK(version>0), reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),notes TEXT CHECK(octet_length(notes)<=1000),
 pay_minor BIGINT NOT NULL CHECK(pay_minor>0), credit_minor BIGINT NOT NULL CHECK(credit_minor>0),
 original_transaction_id UUID UNIQUE REFERENCES real_hkd_transactions(id), frozen_minor BIGINT NOT NULL CHECK(frozen_minor>=0),
 external_reference TEXT CHECK(length(external_reference) BETWEEN 1 AND 200), executed_at TIMESTAMPTZ,
 evidence_version BIGINT CHECK(evidence_version>0),rejection_reason TEXT CHECK(octet_length(rejection_reason) BETWEEN 1 AND 1000),
 evidence BYTEA CHECK(octet_length(evidence) BETWEEN 1 AND 131072), evidence_sha256 TEXT CHECK(length(evidence_sha256)=64),
 evidence_actor UUID REFERENCES identities(id), verified_by UUID REFERENCES identities(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(maker_id,client_request_id), CHECK(checker_id IS NULL OR checker_id<>maker_id), CHECK(verified_by IS NULL OR verified_by<>evidence_actor),
 CHECK((original_transaction_id IS NULL AND frozen_minor=0) OR (original_transaction_id IS NOT NULL AND frozen_minor=credit_minor)),
 CHECK((evidence IS NULL AND evidence_sha256 IS NULL AND external_reference IS NULL AND executed_at IS NULL AND evidence_actor IS NULL) OR
 (evidence IS NOT NULL AND evidence_sha256=encode(sha256(evidence),'hex') AND external_reference IS NOT NULL AND executed_at IS NOT NULL AND evidence_actor IS NOT NULL)),
 CHECK((checker_id IS NULL)=(approved_at IS NULL)),CHECK((status='requested')=(checker_id IS NULL)),CHECK(approved_at IS NULL OR approved_at>=created_at),CHECK(evidence_actor IS NULL OR evidence_actor=maker_id),CHECK(verified_by IS NULL OR verified_by=checker_id),CHECK(evidence IS NULL OR (approved_at IS NOT NULL AND executed_at>=approved_at)),
 CHECK((evidence IS NULL)=(evidence_version IS NULL)),CHECK((status='refunded')=(verified_by IS NOT NULL)), CHECK(status NOT IN ('evidence_pending','evidence_rejected','refunded') OR (evidence IS NOT NULL AND evidence_version IS NOT NULL)),CHECK((status='evidence_rejected')=(rejection_reason IS NOT NULL))
);
-- Each accepted attachment/rejection is append-only. Bind every historical hash/reference
-- to its original refund forever, even after a correction becomes the current evidence.
CREATE TABLE payment_refund_evidence (
 refund_id UUID NOT NULL REFERENCES payment_refunds(id),evidence_version BIGINT NOT NULL CHECK(evidence_version>0),
 evidence BYTEA NOT NULL CHECK(octet_length(evidence) BETWEEN 1 AND 131072),evidence_sha256 TEXT NOT NULL CHECK(evidence_sha256=encode(sha256(evidence),'hex')),
 external_reference TEXT NOT NULL CHECK(octet_length(external_reference) BETWEEN 1 AND 200),executed_at TIMESTAMPTZ NOT NULL,
 actor_id UUID NOT NULL REFERENCES identities(id),notes TEXT NOT NULL CHECK(octet_length(notes) BETWEEN 1 AND 1000),created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(refund_id,evidence_version)
);
ALTER TABLE payment_refunds ADD CONSTRAINT current_refund_evidence FOREIGN KEY(id,evidence_version) REFERENCES payment_refund_evidence(refund_id,evidence_version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE payment_refund_evidence_bindings (
 kind TEXT NOT NULL CHECK(kind IN ('reference','hash')),value TEXT NOT NULL CHECK(octet_length(value) BETWEEN 1 AND 200),refund_id UUID NOT NULL REFERENCES payment_refunds(id),PRIMARY KEY(kind,value)
);
CREATE TABLE payment_refund_evidence_rejections (
 refund_id UUID NOT NULL,evidence_version BIGINT NOT NULL,checker_id UUID NOT NULL REFERENCES identities(id),reason TEXT NOT NULL CHECK(octet_length(reason) BETWEEN 1 AND 1000),created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(refund_id,evidence_version),FOREIGN KEY(refund_id,evidence_version) REFERENCES payment_refund_evidence(refund_id,evidence_version)
);
CREATE TRIGGER immutable_refund_evidence BEFORE UPDATE OR DELETE ON payment_refund_evidence FOR EACH ROW EXECUTE FUNCTION reject_payment_immutable_mutation();
CREATE TRIGGER immutable_refund_evidence_binding BEFORE UPDATE OR DELETE ON payment_refund_evidence_bindings FOR EACH ROW EXECUTE FUNCTION reject_payment_immutable_mutation();
CREATE TRIGGER immutable_refund_evidence_rejection BEFORE UPDATE OR DELETE ON payment_refund_evidence_rejections FOR EACH ROW EXECUTE FUNCTION reject_payment_immutable_mutation();
CREATE FUNCTION guard_refund_evidence_append() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM payment_refunds r JOIN payment_orders o ON o.id=r.payment_id WHERE r.id=NEW.refund_id AND r.status IN ('approved_external','unknown','evidence_rejected') AND NEW.evidence_version=coalesce(r.evidence_version,0)+1 AND NEW.actor_id=r.maker_id AND NEW.executed_at>=r.approved_at AND NEW.executed_at>=o.provider_paid_at AND NEW.executed_at<=clock_timestamp())
 OR NOT EXISTS(SELECT 1 FROM payment_refund_evidence_bindings WHERE kind='hash' AND value=NEW.evidence_sha256 AND refund_id=NEW.refund_id)
 OR NOT EXISTS(SELECT 1 FROM payment_refund_evidence_bindings WHERE kind='reference' AND value=NEW.external_reference AND refund_id=NEW.refund_id)
 THEN RAISE EXCEPTION 'refund evidence must append the next independently reviewable version with permanent ownership'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER guard_refund_evidence_append BEFORE INSERT ON payment_refund_evidence FOR EACH ROW EXECUTE FUNCTION guard_refund_evidence_append();
CREATE TABLE real_hkd_reversals (
 id UUID PRIMARY KEY, refund_id UUID NOT NULL UNIQUE REFERENCES payment_refunds(id), payment_id UUID NOT NULL UNIQUE REFERENCES payment_orders(id),
 original_transaction_id UUID NOT NULL UNIQUE REFERENCES real_hkd_transactions(id),
 source_account_id UUID NOT NULL REFERENCES real_hkd_accounts(id), destination_account_id UUID NOT NULL REFERENCES real_hkd_accounts(id),
 amount_minor BIGINT NOT NULL CHECK(amount_minor BETWEEN 1 AND 9007199254740991),
 source_balance_after BIGINT NOT NULL CHECK(source_balance_after BETWEEN 0 AND 9007199254740991),destination_balance_after BIGINT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),CHECK(source_account_id<>destination_account_id)
);
CREATE TABLE real_hkd_reversal_entries (
 id UUID PRIMARY KEY, reversal_id UUID NOT NULL REFERENCES real_hkd_reversals(id), account_id UUID NOT NULL REFERENCES real_hkd_accounts(id),
 delta_minor BIGINT NOT NULL CHECK(delta_minor<>0),balance_after_minor BIGINT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(reversal_id,account_id)
);
CREATE INDEX real_hkd_reversal_entries_account ON real_hkd_reversal_entries(account_id,created_at DESC,id DESC);
CREATE TRIGGER immutable_real_hkd_reversal BEFORE UPDATE OR DELETE ON real_hkd_reversals FOR EACH ROW EXECUTE FUNCTION reject_payment_immutable_mutation();
CREATE TRIGGER immutable_real_hkd_reversal_entry BEFORE UPDATE OR DELETE ON real_hkd_reversal_entries FOR EACH ROW EXECUTE FUNCTION reject_payment_immutable_mutation();
CREATE FUNCTION preserve_payment_refund() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'refund obligations must be retained'; END IF;
 IF (NEW.id,NEW.payment_id,NEW.client_request_id,NEW.maker_id,NEW.reason,NEW.pay_minor,NEW.credit_minor,NEW.original_transaction_id,NEW.frozen_minor,NEW.created_at)
 IS DISTINCT FROM (OLD.id,OLD.payment_id,OLD.client_request_id,OLD.maker_id,OLD.reason,OLD.pay_minor,OLD.credit_minor,OLD.original_transaction_id,OLD.frozen_minor,OLD.created_at)
 OR NEW.version<>OLD.version+1 OR (OLD.checker_id IS NOT NULL AND (NEW.checker_id,NEW.approved_at) IS DISTINCT FROM (OLD.checker_id,OLD.approved_at))
 OR (OLD.evidence IS NOT NULL AND (NEW.external_reference,NEW.executed_at,NEW.evidence,NEW.evidence_sha256,NEW.evidence_actor,NEW.evidence_version) IS DISTINCT FROM (OLD.external_reference,OLD.executed_at,OLD.evidence,OLD.evidence_sha256,OLD.evidence_actor,OLD.evidence_version) AND NOT (OLD.status='evidence_rejected' AND NEW.status='evidence_pending' AND NEW.evidence_version=OLD.evidence_version+1))
 OR (OLD.evidence_version IS NULL AND NEW.evidence_version IS NOT NULL AND NEW.evidence_version<>1)
 OR (OLD.status='evidence_rejected' AND NEW.status='evidence_pending' AND NEW.evidence_version IS DISTINCT FROM OLD.evidence_version+1)
 OR NOT ((OLD.status='requested' AND NEW.status='approved_external') OR (OLD.status='approved_external' AND NEW.status IN ('unknown','evidence_pending')) OR (OLD.status='unknown' AND NEW.status='evidence_pending') OR (OLD.status='evidence_pending' AND NEW.status IN ('refunded','evidence_rejected')) OR (OLD.status='evidence_rejected' AND NEW.status='evidence_pending')) THEN RAISE EXCEPTION 'immutable refund identity or evidence changed'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER preserve_payment_refund BEFORE UPDATE OR DELETE ON payment_refunds FOR EACH ROW EXECUTE FUNCTION preserve_payment_refund();
-- Replace only the resolved-state check; original identity/evidence constraints are preserved.
DO $$ DECLARE c RECORD; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='payment_orders'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%NOT resolved%' LOOP
 EXECUTE format('ALTER TABLE payment_orders DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE payment_orders ADD CONSTRAINT payment_resolved_obligation CHECK(NOT resolved OR status='credited' OR (status='failed' AND error_code='refunded') OR (status='failed' AND error_code='not_created' AND may_have_sent_at IS NULL AND verified_at IS NULL AND evidence_hash IS NULL AND provider_trade_no IS NULL AND checkout_url IS NULL AND credited_transaction_id IS NULL));
CREATE OR REPLACE FUNCTION preserve_payment_order() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'payment orders must be retained'; END IF;
 IF (NEW.id,NEW.user_id,NEW.quote_id,NEW.client_request_id,NEW.merchant_id,NEW.credential_version,NEW.merchant_no,NEW.created_at,NEW.checkout_expires_at)
 IS DISTINCT FROM (OLD.id,OLD.user_id,OLD.quote_id,OLD.client_request_id,OLD.merchant_id,OLD.credential_version,OLD.merchant_no,OLD.created_at,OLD.checkout_expires_at)
 OR (OLD.provider_trade_no IS NOT NULL AND NEW.provider_trade_no IS DISTINCT FROM OLD.provider_trade_no)
 OR (OLD.may_have_sent_at IS NOT NULL AND NEW.may_have_sent_at IS DISTINCT FROM OLD.may_have_sent_at)
 OR (OLD.verified_at IS NOT NULL AND (NEW.verified_at,NEW.provider_paid_at_raw,NEW.provider_paid_at,NEW.evidence_hash,NEW.evidence_version) IS DISTINCT FROM (OLD.verified_at,OLD.provider_paid_at_raw,OLD.provider_paid_at,OLD.evidence_hash,OLD.evidence_version))
 OR (OLD.resolved AND NEW IS DISTINCT FROM OLD)
 OR (OLD.verified_at IS NOT NULL AND NEW.status NOT IN ('awaiting_credit_approval','review_required','crediting','credited') AND NOT (NEW.status='failed' AND NEW.error_code='refunded' AND EXISTS(SELECT 1 FROM payment_refunds r WHERE r.payment_id=NEW.id AND r.status='refunded' AND r.original_transaction_id IS NULL)))
 OR NEW.version<>OLD.version+1 OR (OLD.checkout_detached AND NOT NEW.checkout_detached)
 THEN RAISE EXCEPTION 'immutable payment identity or monotonic evidence changed'; END IF;
 RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION check_real_hkd_balance() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target UUID; cached BIGINT; actual NUMERIC; frozen NUMERIC; account_kind TEXT;
BEGIN
 IF TG_TABLE_NAME='real_hkd_accounts' THEN target:=NEW.id; ELSE target:=NEW.account_id; END IF;
 SELECT balance_minor,kind INTO STRICT cached,account_kind FROM real_hkd_accounts WHERE id=target;
 SELECT (SELECT coalesce(sum(delta_minor),0) FROM real_hkd_entries WHERE account_id=target)+(SELECT coalesce(sum(delta_minor),0) FROM real_hkd_reversal_entries WHERE account_id=target) INTO actual;
 SELECT coalesce(sum(r.frozen_minor),0) INTO frozen FROM payment_refunds r JOIN payment_orders o ON o.id=r.payment_id JOIN real_hkd_accounts a ON a.user_id=o.user_id WHERE a.id=target AND r.status<>'refunded';
 IF cached<>actual OR (account_kind='user' AND frozen>cached) THEN RAISE EXCEPTION 'real HKD cached balance/holds must match journals'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER valid_real_hkd_reversal_balance AFTER INSERT ON real_hkd_reversal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_real_hkd_balance();
CREATE FUNCTION check_real_hkd_reversal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target UUID; t real_hkd_reversals%ROWTYPE; n BIGINT; net NUMERIC; matched BIGINT;
BEGIN
 IF TG_TABLE_NAME='real_hkd_reversals' THEN target:=NEW.id; ELSE target:=NEW.reversal_id; END IF;
 SELECT * INTO STRICT t FROM real_hkd_reversals WHERE id=target;
 IF NOT EXISTS(SELECT 1 FROM payment_refunds r JOIN payment_orders o ON o.id=r.payment_id JOIN real_hkd_transactions original ON original.id=r.original_transaction_id
 WHERE r.id=t.refund_id AND r.status='refunded' AND r.payment_id=t.payment_id AND r.original_transaction_id=t.original_transaction_id AND r.credit_minor=t.amount_minor AND r.verified_by IS NOT NULL
 AND original.payment_id=o.id AND o.status='credited' AND o.credited_transaction_id=original.id AND original.destination_account_id=t.source_account_id AND original.source_account_id=t.destination_account_id AND original.amount_minor=t.amount_minor)
 THEN RAISE EXCEPTION 'reversal requires the original full credit and verified refund'; END IF;
 SELECT count(*),coalesce(sum(delta_minor),0),count(*) FILTER(WHERE (account_id=t.source_account_id AND delta_minor=-t.amount_minor AND balance_after_minor=t.source_balance_after) OR (account_id=t.destination_account_id AND delta_minor=t.amount_minor AND balance_after_minor=t.destination_balance_after)) INTO n,net,matched FROM real_hkd_reversal_entries WHERE reversal_id=target;
 IF n<>2 OR net<>0 OR matched<>2 THEN RAISE EXCEPTION 'refund reversal requires balanced linked entries'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER balanced_real_hkd_reversal AFTER INSERT ON real_hkd_reversals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_real_hkd_reversal();
CREATE CONSTRAINT TRIGGER balanced_real_hkd_reversal_entry AFTER INSERT ON real_hkd_reversal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_real_hkd_reversal();
CREATE FUNCTION check_payment_refund() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE owner UUID; amount BIGINT; hkd BIGINT; credit UUID; balance BIGINT; frozen NUMERIC; paid TIMESTAMPTZ;
BEGIN
 SELECT o.user_id,q.pay_minor,q.credit_minor,o.credited_transaction_id,o.provider_paid_at INTO STRICT owner,amount,hkd,credit,paid FROM payment_orders o JOIN payment_quotes q ON q.id=o.quote_id WHERE o.id=NEW.payment_id;
 IF (NEW.evidence IS NOT NULL AND (paid IS NULL OR NEW.executed_at<paid OR NEW.executed_at<NEW.approved_at OR NEW.executed_at>clock_timestamp())) OR NEW.maker_id=owner OR NEW.checker_id=owner OR NEW.verified_by=owner OR NEW.pay_minor<>amount OR NEW.credit_minor<>hkd OR NEW.original_transaction_id IS DISTINCT FROM credit
 THEN RAISE EXCEPTION 'refund requires original amounts, transaction and independent operators'; END IF;
 SELECT a.balance_minor INTO balance FROM real_hkd_accounts a WHERE a.user_id=owner;
 SELECT coalesce(sum(r.frozen_minor),0) INTO frozen FROM payment_refunds r JOIN payment_orders o ON o.id=r.payment_id WHERE o.user_id=owner AND r.status<>'refunded';
 IF frozen>coalesce(balance,0) THEN RAISE EXCEPTION 'refund holds require sufficient HKD'; END IF;
 IF NEW.evidence IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM payment_refund_evidence e WHERE e.refund_id=NEW.id AND e.evidence_version=NEW.evidence_version AND (e.evidence,e.evidence_sha256,e.external_reference,e.executed_at,e.actor_id)=(NEW.evidence,NEW.evidence_sha256,NEW.external_reference,NEW.executed_at,NEW.evidence_actor)) OR NOT EXISTS(SELECT 1 FROM payment_refund_evidence_bindings WHERE kind='reference' AND value=NEW.external_reference AND refund_id=NEW.id) OR NOT EXISTS(SELECT 1 FROM payment_refund_evidence_bindings WHERE kind='hash' AND value=NEW.evidence_sha256 AND refund_id=NEW.id)) THEN RAISE EXCEPTION 'current refund evidence requires retained original attachment and bindings'; END IF;
 IF NEW.status='evidence_rejected' AND NOT EXISTS(SELECT 1 FROM payment_refund_evidence_rejections r WHERE r.refund_id=NEW.id AND r.evidence_version=NEW.evidence_version AND r.checker_id=NEW.checker_id AND r.reason=NEW.rejection_reason) THEN RAISE EXCEPTION 'refund evidence rejection requires independent retained reason'; END IF;
 IF NEW.status='refunded' AND ((credit IS NOT NULL AND NOT EXISTS(SELECT 1 FROM real_hkd_reversals WHERE refund_id=NEW.id)) OR (credit IS NULL AND NOT EXISTS(SELECT 1 FROM payment_orders WHERE id=NEW.payment_id AND resolved AND status='failed' AND error_code='refunded')))
 THEN RAISE EXCEPTION 'completed refund requires reversal or resolved uncredited payment'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER valid_payment_refund AFTER INSERT OR UPDATE ON payment_refunds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_payment_refund();
CREATE OR REPLACE FUNCTION check_payment_credit_consistency() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='credited' AND (NOT EXISTS(SELECT 1 FROM real_hkd_transactions t WHERE t.id=NEW.credited_transaction_id AND t.payment_id=NEW.id) OR EXISTS(SELECT 1 FROM payment_refunds r WHERE r.payment_id=NEW.id AND r.original_transaction_id IS NULL)) THEN RAISE EXCEPTION 'credited payment must reference its own journal transaction without pending refund'; END IF;
 IF NEW.resolved AND NEW.error_code='refunded' AND NOT EXISTS(SELECT 1 FROM payment_refunds r WHERE r.payment_id=NEW.id AND r.status='refunded' AND r.original_transaction_id IS NULL) THEN RAISE EXCEPTION 'resolved refund requires verified external evidence'; END IF;
 RETURN NULL;
END; $$;
CREATE TABLE payment_settlements (
 id UUID PRIMARY KEY, client_request_id UUID NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('order_reconciliation','bank_settlement','hkd_reserve')),
 source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 200), currency TEXT NOT NULL CHECK(currency IN ('CNY','HKD')),
 status TEXT NOT NULL CHECK(status IN ('awaiting_verification','discrepancy','operator_verified')),check_version BIGINT NOT NULL DEFAULT 1 CHECK(check_version>0),
 mapping BYTEA NOT NULL CHECK(octet_length(mapping) BETWEEN 1 AND 131072),mapping_sha256 TEXT NOT NULL CHECK(mapping_sha256=encode(sha256(mapping),'hex')),
 evidence BYTEA NOT NULL CHECK(octet_length(evidence) BETWEEN 1 AND 262144), evidence_sha256 TEXT NOT NULL CHECK(evidence_sha256=encode(sha256(evidence),'hex')),
 media_type TEXT NOT NULL CHECK(media_type IN ('application/pdf','text/csv')),
 bank_reference TEXT CHECK(length(bank_reference) BETWEEN 1 AND 200),bank_amount_minor BIGINT CHECK(bank_amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
 record_count INTEGER NOT NULL CHECK(record_count BETWEEN 0 AND 200), matched_count INTEGER NOT NULL CHECK(matched_count BETWEEN 0 AND record_count), differences JSONB NOT NULL,
 maker_id UUID NOT NULL REFERENCES identities(id),checker_id UUID REFERENCES identities(id),created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),verified_at TIMESTAMPTZ,
 UNIQUE(maker_id,client_request_id),UNIQUE(kind,evidence_sha256,mapping_sha256),CHECK(checker_id IS NULL OR checker_id<>maker_id),CHECK((status='operator_verified')=(checker_id IS NOT NULL AND verified_at IS NOT NULL))
);
-- Recomputations append Q-state evidence; the imported bank/source materials never change.
CREATE TABLE payment_settlement_checks (
 settlement_id UUID NOT NULL REFERENCES payment_settlements(id),check_version BIGINT NOT NULL CHECK(check_version>0),
 matched_count INTEGER NOT NULL CHECK(matched_count BETWEEN 0 AND 200),differences JSONB NOT NULL CHECK(jsonb_typeof(differences)='array'),
 actor_id UUID NOT NULL REFERENCES identities(id),created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(settlement_id,check_version)
);
ALTER TABLE payment_settlements ADD CONSTRAINT current_payment_settlement_check FOREIGN KEY(id,check_version) REFERENCES payment_settlement_checks(settlement_id,check_version) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER immutable_payment_settlement_check BEFORE UPDATE OR DELETE ON payment_settlement_checks FOR EACH ROW EXECUTE FUNCTION reject_payment_immutable_mutation();
CREATE FUNCTION check_payment_settlement_calculation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM payment_settlement_checks c WHERE c.settlement_id=NEW.id AND c.check_version=NEW.check_version AND c.matched_count=NEW.matched_count AND c.differences=NEW.differences)
 OR ((NEW.status='discrepancy') IS DISTINCT FROM (jsonb_array_length(NEW.differences)>0)) THEN RAISE EXCEPTION 'settlement state requires its immutable calculation version'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER valid_payment_settlement_calculation AFTER INSERT OR UPDATE ON payment_settlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_payment_settlement_calculation();
-- Keep correction imports, but never count one bank reference as verified twice.
CREATE UNIQUE INDEX one_verified_payment_bank_reference ON payment_settlements(kind,currency,bank_reference) WHERE status='operator_verified' AND bank_reference IS NOT NULL;
CREATE FUNCTION preserve_payment_settlement() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'settlement evidence must be retained'; END IF;
 IF (NEW.id,NEW.client_request_id,NEW.kind,NEW.source,NEW.currency,NEW.mapping,NEW.mapping_sha256,NEW.evidence,NEW.evidence_sha256,NEW.media_type,NEW.bank_reference,NEW.bank_amount_minor,NEW.record_count,NEW.maker_id,NEW.created_at)
 IS DISTINCT FROM (OLD.id,OLD.client_request_id,OLD.kind,OLD.source,OLD.currency,OLD.mapping,OLD.mapping_sha256,OLD.evidence,OLD.evidence_sha256,OLD.media_type,OLD.bank_reference,OLD.bank_amount_minor,OLD.record_count,OLD.maker_id,OLD.created_at)
 OR NOT (
  (OLD.status IN ('awaiting_verification','discrepancy') AND NEW.status IN ('awaiting_verification','discrepancy') AND NEW.check_version=OLD.check_version+1 AND NEW.checker_id IS NULL AND NEW.verified_at IS NULL)
  OR (OLD.status='awaiting_verification' AND NEW.status='operator_verified' AND NEW.check_version=OLD.check_version AND NEW.matched_count=OLD.matched_count AND NEW.differences=OLD.differences)
 ) THEN RAISE EXCEPTION 'immutable settlement evidence changed or calculation history bypassed'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER preserve_payment_settlement BEFORE UPDATE OR DELETE ON payment_settlements FOR EACH ROW EXECUTE FUNCTION preserve_payment_settlement();

CREATE FUNCTION check_credit_operator_independence() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE owner UUID;
BEGIN
 SELECT user_id INTO STRICT owner FROM payment_orders WHERE id=NEW.payment_id;
 IF NEW.maker_id=owner THEN RAISE EXCEPTION 'payment customer cannot propose their own credit'; END IF;
 IF TG_TABLE_NAME='payment_approvals' AND (to_jsonb(NEW)->>'checker_id')::uuid=owner THEN RAISE EXCEPTION 'payment customer cannot approve their own credit'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER independent_payment_proposal AFTER INSERT ON payment_proposals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_credit_operator_independence();
CREATE CONSTRAINT TRIGGER independent_payment_approval AFTER INSERT ON payment_approvals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_credit_operator_independence();
