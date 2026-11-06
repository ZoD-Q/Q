//! Durable work claims. Network calls never hold a SQL transaction; stale leases cannot finalize.
use super::{
    PaymentRuntime,
    config::provider_paid_time,
    qixiang::{CreatePayment, CreatedPayment, PaidConfirmation, QueryOutcome},
    store::{self, Order},
};
use crate::error::{ApiError, ApiResult};
use chrono::Utc;
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use std::{sync::Arc, time::Duration};
use uuid::Uuid;

pub async fn schedule(tx: &mut Transaction<'_, Postgres>, payment: Uuid) -> ApiResult<()> {
    sqlx::query("INSERT INTO payment_jobs(payment_id) VALUES($1) ON CONFLICT(payment_id) DO UPDATE SET next_attempt_at=LEAST(payment_jobs.next_attempt_at,clock_timestamp())")
 .bind(payment).execute(&mut **tx).await?;
    Ok(())
}
pub async fn invalidate(tx: &mut Transaction<'_, Postgres>, payment: Uuid) -> ApiResult<()> {
    sqlx::query("INSERT INTO payment_jobs(payment_id) VALUES($1) ON CONFLICT(payment_id) DO UPDATE SET epoch=payment_jobs.epoch+1,token=NULL,leased_until=NULL,captured_version=NULL,next_attempt_at=clock_timestamp()")
 .bind(payment).execute(&mut **tx).await?;
    Ok(())
}
#[derive(Clone)]
pub struct Claim {
    pub order: Order,
    pub epoch: i64,
    pub token: Uuid,
    pub create: bool,
}
/// Caller holds identity -> order -> slot locks. A create can run only after its durable
/// may-have-sent mark, so absence of that mark under these same locks proves no send can win.
pub async fn cancel_never_sent(
    tx: &mut Transaction<'_, Postgres>,
    order: &Order,
) -> ApiResult<bool> {
    if order.may_have_sent_at.is_some() || order.resolved || order.verified_at.is_some() {
        return Ok(false);
    }
    sqlx::query("SELECT payment_id FROM payment_jobs WHERE payment_id=$1 FOR UPDATE")
        .bind(order.id)
        .fetch_optional(&mut **tx)
        .await?;
    sqlx::query("UPDATE payment_orders SET status='failed',error_code='not_created',resolved=true,checkout_detached=true,version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND may_have_sent_at IS NULL AND NOT resolved").bind(order.id).execute(&mut **tx).await?;
    sqlx::query("DELETE FROM payment_checkout_slots WHERE user_id=$1 AND payment_id=$2")
        .bind(order.user_id)
        .bind(order.id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM payment_jobs WHERE payment_id=$1")
        .bind(order.id)
        .execute(&mut **tx)
        .await?;
    Ok(true)
}
pub async fn claim(pool: &sqlx::PgPool, runtime: &PaymentRuntime) -> ApiResult<Option<Claim>> {
    let candidates:Vec<(Uuid,Uuid)>=sqlx::query_as("SELECT j.payment_id,o.user_id FROM payment_jobs j JOIN payment_orders o ON o.id=j.payment_id WHERE j.next_attempt_at<=clock_timestamp() AND (j.leased_until IS NULL OR j.leased_until<=clock_timestamp()) ORDER BY ((o.credential_version||':'||o.merchant_id)=ANY($1)) DESC,j.next_attempt_at,j.payment_id LIMIT 16").bind(runtime.eligible_bindings()).fetch_all(pool).await?;
    for (id, user) in candidates {
        let mut tx = pool.begin().await?;
        let identities = store::lock_identities(&mut tx, &[user]).await?;
        let mut order = store::lock_order(&mut tx, id).await?;
        store::slot(&mut tx, user).await?;
        let job:Option<(i64,)> =sqlx::query_as("SELECT epoch FROM payment_jobs WHERE payment_id=$1 AND next_attempt_at<=clock_timestamp() AND (leased_until IS NULL OR leased_until<=clock_timestamp()) FOR UPDATE")
 .bind(id).fetch_optional(&mut *tx).await?;
        let Some((epoch,)) = job else { continue };
        if order.verified_at.is_some() || order.resolved || order.refund_id.is_some() {
            sqlx::query("DELETE FROM payment_jobs WHERE payment_id=$1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            continue;
        }
        if order.may_have_sent_at.is_none()
            && (order.checkout_detached || order.checkout_expires_at <= Utc::now())
        {
            cancel_never_sent(&mut tx, &order).await?;
            tx.commit().await?;
            continue;
        }
        if runtime
            .provider(&order.credential_version, &order.merchant_id)
            .is_none()
        {
            sqlx::query("UPDATE payment_orders SET status='review_required',error_code='CREDENTIAL_VERSION_UNAVAILABLE',version=version+1,updated_at=clock_timestamp() WHERE id=$1").bind(id).execute(&mut *tx).await?;
            sqlx::query("UPDATE payment_jobs SET next_attempt_at=clock_timestamp()+interval '5 minutes' WHERE payment_id=$1").bind(id).execute(&mut *tx).await?;
            tx.commit().await?;
            continue;
        }
        let create = order.may_have_sent_at.is_none()
            && store::active(&identities, user)
            && !order.checkout_detached
            && order.checkout_expires_at > Utc::now();
        if order.may_have_sent_at.is_none() && !create {
            sqlx::query("UPDATE payment_orders SET status='review_required',error_code='CHECKOUT_NOT_SENT',version=version+1,updated_at=clock_timestamp() WHERE id=$1").bind(id).execute(&mut *tx).await?;
            sqlx::query("UPDATE payment_jobs SET next_attempt_at=clock_timestamp()+interval '1 hour' WHERE payment_id=$1").bind(id).execute(&mut *tx).await?;
            tx.commit().await?;
            continue;
        }
        if create {
            sqlx::query("UPDATE payment_orders SET may_have_sent_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=$1").bind(id).execute(&mut *tx).await?;
            order = store::lock_order(&mut tx, id).await?;
        }
        let token = Uuid::new_v4();
        let epoch = epoch.checked_add(1).ok_or_else(ApiError::internal)?;
        sqlx::query("UPDATE payment_jobs SET epoch=$2,token=$3,leased_until=clock_timestamp()+interval '60 seconds',captured_version=$4,attempts=attempts+1 WHERE payment_id=$1")
 .bind(id).bind(epoch).bind(token).bind(order.version).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(Some(Claim {
            order,
            epoch,
            token,
            create,
        }));
    }
    Ok(None)
}
pub enum Outcome {
    Created(CreatedPayment),
    Paid(PaidConfirmation),
    Unpaid,
    Unknown,
    RejectedIdentity,
}
pub async fn execute(runtime: &PaymentRuntime, claim: &Claim) -> Outcome {
    let Some(provider) =
        runtime.provider(&claim.order.credential_version, &claim.order.merchant_id)
    else {
        return Outcome::Unknown;
    };
    if claim.create {
        let request = CreatePayment {
            merchant_order_no: claim.order.merchant_no.clone(),
            channel: claim.order.channel(),
            amount_minor_cny: claim.order.pay_minor,
            name: "Q HKD wallet deposit".into(),
            client_ip: "127.0.0.1".into(),
        };
        match provider.create(&request).await {
            Ok(value) => Outcome::Created(value),
            Err(_) => Outcome::Unknown,
        }
    } else {
        match provider.query(&claim.order.expected()).await {
            Ok(QueryOutcome::Paid(value)) => Outcome::Paid(value),
            Ok(QueryOutcome::Unpaid) => Outcome::Unpaid,
            Err(super::qixiang::Error::IdentityMismatch) => Outcome::RejectedIdentity,
            Err(_) => Outcome::Unknown,
        }
    }
}
pub async fn finalize(
    pool: &sqlx::PgPool,
    runtime: &PaymentRuntime,
    claim: &Claim,
    outcome: Outcome,
) -> ApiResult<bool> {
    let mut tx = pool.begin().await?;
    let identities = store::lock_identities(&mut tx, &[claim.order.user_id]).await?;
    let order = store::lock_order(&mut tx, claim.order.id).await?;
    store::slot(&mut tx, order.user_id).await?;
    let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM payment_jobs WHERE payment_id=$1 AND epoch=$2 AND token=$3 AND captured_version=$4 AND leased_until>clock_timestamp())")
 .bind(order.id).bind(claim.epoch).bind(claim.token).bind(claim.order.version).fetch_one(&mut *tx).await?;
    if !valid {
        return Ok(false);
    }
    // A version change (including checkout detachment) invalidates a delayed network result.
    if order.version != claim.order.version
        || order.verified_at.is_some()
        || order.status == "credited"
        || order.refund_id.is_some()
    {
        sqlx::query("UPDATE payment_jobs SET token=NULL,leased_until=NULL,captured_version=NULL,next_attempt_at=clock_timestamp() WHERE payment_id=$1 AND epoch=$2 AND token=$3")
 .bind(order.id).bind(claim.epoch).bind(claim.token).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(false);
    }
    let expired = Utc::now() > order.checkout_expires_at;
    let mut verified = false;
    match outcome {
        Outcome::Created(created) => {
            if order
                .provider_trade_no
                .as_ref()
                .is_some_and(|id| id != &created.provider_trade_no)
            {
                return Err(store::conflict());
            }
            sqlx::query("UPDATE payment_orders SET provider_trade_no=coalesce(provider_trade_no,$2),checkout_url=$3,status=$4,error_code=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=$1")
 .bind(order.id).bind(created.provider_trade_no).bind(created.checkout_url).bind(if expired{"expired"}else{"awaiting_payment"}).execute(&mut *tx).await?;
        }
        Outcome::Paid(paid) => {
            // Recheck the frozen identity even for typed outcomes; callers cannot bypass the adapter.
            if paid.merchant_order_no != order.merchant_no
                || paid.amount_minor_cny != order.pay_minor
                || order
                    .provider_trade_no
                    .as_ref()
                    .is_some_and(|id| id != &paid.provider_trade_no)
            {
                return Err(store::conflict());
            }
            let paid_at = provider_paid_time(
                paid.provider_paid_at_raw.as_deref(),
                runtime.policy.provider_utc_offset_seconds,
            );
            let timely = paid_at.is_some_and(|at| {
                at >= order.created_at && at <= order.checkout_expires_at && at <= Utc::now()
            });
            let hash=Sha256::digest(serde_json::to_vec(&serde_json::json!({"payment_id":order.id,"merchant_id":order.merchant_id,"merchant_no":order.merchant_no,"trade_no":paid.provider_trade_no,"amount_minor_cny":order.pay_minor,"credit_minor_hkd":order.credit_minor,"quote_id":order.quote_id,"paid_at_raw":paid.provider_paid_at_raw,"paid_at":paid_at})).map_err(|_|ApiError::internal())?).to_vec();
            let active = store::active(&identities, order.user_id);
            let held_review = order.status == "review_required"
                && !matches!(
                    order.error_code.as_deref(),
                    Some("ACCOUNT_UNAVAILABLE" | "CREDENTIAL_VERSION_UNAVAILABLE")
                );
            sqlx::query("UPDATE payment_orders SET provider_trade_no=coalesce(provider_trade_no,$2),provider_paid_at_raw=$3,provider_paid_at=$4,verified_at=clock_timestamp(),evidence_version=evidence_version+1,evidence_hash=$5,status=$6,error_code=$7,version=version+1,updated_at=clock_timestamp() WHERE id=$1")
 .bind(order.id).bind(paid.provider_trade_no).bind(paid.provider_paid_at_raw).bind(paid_at).bind(hash)
 .bind(if timely&&active&&!held_review{"awaiting_credit_approval"}else{"review_required"})
 .bind(if held_review{order.error_code.as_deref().or(Some("PAYMENT_REVIEW_REQUIRED"))}else if !timely{Some("PAYMENT_TIME_REVIEW")}else if !active{Some("ACCOUNT_UNAVAILABLE")}else{None})
 .execute(&mut *tx).await?;
            verified = true;
        }
        Outcome::RejectedIdentity => {
            sqlx::query("UPDATE payment_orders SET status='review_required',error_code='PROVIDER_IDENTITY_MISMATCH',version=version+1,updated_at=clock_timestamp() WHERE id=$1").bind(order.id).execute(&mut *tx).await?;
        }
        Outcome::Unpaid | Outcome::Unknown => {
            let unknown = matches!(outcome, Outcome::Unknown);
            let state = if order.status == "review_required" {
                "review_required"
            } else if expired || order.status == "expired" {
                "expired"
            } else if order.checkout_url.is_some() {
                "awaiting_payment"
            } else {
                "confirming"
            };
            sqlx::query("UPDATE payment_orders SET status=$2,error_code=$3,version=version+1,updated_at=clock_timestamp() WHERE id=$1")
 .bind(order.id).bind(state).bind(if state=="review_required"{order.error_code.as_deref()}else if unknown{Some("PROVIDER_RESULT_UNKNOWN")}else{None}).execute(&mut *tx).await?;
        }
    }
    if verified {
        sqlx::query("DELETE FROM payment_jobs WHERE payment_id=$1")
            .bind(order.id)
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query("UPDATE payment_jobs SET token=NULL,leased_until=NULL,captured_version=NULL,next_attempt_at=clock_timestamp()+CASE WHEN $2 THEN interval '5 minutes' ELSE interval '10 seconds' END WHERE payment_id=$1")
 .bind(order.id).bind(expired).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(true)
}
pub fn spawn(pool: sqlx::PgPool, runtime: Arc<PaymentRuntime>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(2));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            for _ in 0..4 {
                match claim(&pool, &runtime).await {
                    Ok(Some(claim)) => {
                        let outcome = execute(&runtime, &claim).await;
                        if finalize(&pool, &runtime, &claim, outcome).await.is_err() {
                            tracing::warn!("payment query finalization deferred");
                        }
                    }
                    Ok(None) => break,
                    Err(_) => {
                        tracing::warn!("payment query claim deferred");
                        break;
                    }
                }
            }
        }
    })
}
