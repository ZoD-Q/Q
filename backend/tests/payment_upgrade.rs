//! Upgrade an independently created, already-funded old schema; never use a business database.
use chrono::{Duration, Utc};
use serde_json::{Value, json};
use sqlx::{
    PgPool,
    migrate::{MigrateError, Migrator},
    postgres::PgPoolOptions,
};
use std::borrow::Cow;
use uuid::Uuid;

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn upgrade_preserves_old_paid_orders_evidence_and_balances_and_rejects_binary_downgrade() {
    let url = std::env::var("TEST_DATABASE_URL").expect("dedicated isolated test database");
    let admin = PgPool::connect(&url).await.unwrap();
    let schema = format!("q_upgrade_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await
        .unwrap();
    let path = format!("SET search_path TO {schema}");
    let pool = PgPoolOptions::new()
        .max_connections(3)
        .after_connect(move |c, _| {
            let path = path.clone();
            Box::pin(async move {
                sqlx::query(&path).execute(c).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    let current = sqlx::migrate!();
    let old = Migrator {
        migrations: Cow::Owned(
            current
                .iter()
                .filter(|m| m.version <= 2026110301)
                .cloned()
                .collect(),
        ),
        ignore_missing: false,
        locking: true,
        no_tx: false,
    };
    assert_eq!(old.iter().count(), 9);
    old.run(&pool).await.unwrap();
    let ids = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
    let quote = Uuid::new_v4();
    let payment = Uuid::new_v4();
    let proposal = Uuid::new_v4();
    let credit = Uuid::new_v4();
    let account = Uuid::new_v4();
    let created = Utc::now() - Duration::minutes(1);
    let paid = created + Duration::seconds(30);
    let expiry = Utc::now() + Duration::minutes(5);
    let proof = vec![0x42_u8; 32];
    let mut tx = pool.begin().await.unwrap();
    for (i, id) in ids.iter().enumerate() {
        sqlx::query("INSERT INTO identities(id,handle,password_hash) VALUES($1,$2,'isolated-not-a-real-login')")
            .bind(id).bind(format!("upgrade_fixture_{i}")).execute(&mut *tx).await.unwrap();
        sqlx::query("INSERT INTO profiles(user_id,display_name) VALUES($1,'Upgrade fixture')")
            .bind(id)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    let rate = json!({"rate_cny_per_100_hkd":"90","rate_source":"Isolated legacy fixture","rate_source_url":"https://example.invalid/fixture","rate_source_date":created.format("%Y-%m-%d").to_string(),"rate_at":created,"rate_fetched_at":created,"rate_evidence_sha256":"a".repeat(64)});
    sqlx::query("INSERT INTO payment_quotes(id,user_id,channel,merchant_id,credential_version,credit_minor,base_minor,fee_minor,pay_minor,fee_bps,rate_snapshot,config_fingerprint,created_at,expires_at) VALUES($1,$2,'wechat','fixture','legacy-v1',1000,900,9,909,100,$3,$4,$5,$6)")
        .bind(quote).bind(ids[0]).bind(rate).bind(vec![0x11_u8;32]).bind(created).bind(expiry).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO payment_orders(id,user_id,quote_id,client_request_id,merchant_id,credential_version,merchant_no,provider_trade_no,status,evidence_version,evidence_hash,provider_paid_at,verified_at,may_have_sent_at,checkout_expires_at,resolved,credited_transaction_id,created_at) VALUES($1,$2,$3,$4,'fixture','legacy-v1','legacy-fixture-order','legacy-fixture-trade','credited',1,$5,$6,$6,$7,$8,true,$9,$7)")
        .bind(payment).bind(ids[0]).bind(quote).bind(Uuid::new_v4()).bind(&proof).bind(paid).bind(created).bind(expiry).bind(credit).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO payment_proposals(id,payment_id,maker_id,evidence_version,evidence_hash) VALUES($1,$2,$3,1,$4)")
        .bind(proposal).bind(payment).bind(ids[1]).bind(&proof).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO payment_approvals(id,payment_id,proposal_id,maker_id,checker_id,evidence_version,evidence_hash) VALUES($1,$2,$3,$4,$5,1,$6)")
        .bind(Uuid::new_v4()).bind(payment).bind(proposal).bind(ids[1]).bind(ids[2]).bind(&proof).execute(&mut *tx).await.unwrap();
    let clearing: Uuid =
        sqlx::query_scalar("SELECT id FROM real_hkd_accounts WHERE kind='clearing'")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    sqlx::query(
        "INSERT INTO real_hkd_accounts(id,user_id,kind,balance_minor) VALUES($1,$2,'user',1000)",
    )
    .bind(account)
    .bind(ids[0])
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("INSERT INTO real_hkd_transactions(id,payment_id,source_account_id,destination_account_id,amount_minor,source_balance_after,destination_balance_after) VALUES($1,$2,$3,$4,1000,-1000,1000)")
        .bind(credit).bind(payment).bind(clearing).bind(account).execute(&mut *tx).await.unwrap();
    for (id, delta, balance) in [(clearing, -1000_i64, -1000_i64), (account, 1000, 1000)] {
        sqlx::query("INSERT INTO real_hkd_entries(id,transaction_id,account_id,delta_minor,balance_after_minor) VALUES($1,$2,$3,$4,$5)")
            .bind(Uuid::new_v4()).bind(credit).bind(id).bind(delta).bind(balance).execute(&mut *tx).await.unwrap();
    }
    sqlx::query("UPDATE real_hkd_accounts SET balance_minor=-1000 WHERE id=$1")
        .bind(clearing)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let tables = [
        "identities",
        "profiles",
        "payment_quotes",
        "payment_orders",
        "payment_proposals",
        "payment_approvals",
        "real_hkd_accounts",
        "real_hkd_transactions",
        "real_hkd_entries",
    ];
    let mut before = Vec::new();
    for table in tables {
        let snapshot: Value = sqlx::query_scalar(&format!(
            "SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM {table} t"
        ))
        .fetch_one(&pool)
        .await
        .unwrap();
        before.push(snapshot);
    }
    current.run(&pool).await.unwrap();
    current.run(&pool).await.unwrap();
    for (table, snapshot) in tables.iter().zip(before) {
        let after: Value = sqlx::query_scalar(&format!(
            "SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM {table} t"
        ))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            snapshot, after,
            "migration changed an existing row in {table}"
        );
    }
    let wallet = xiaoq_backend::ledger::real_hkd::wallet(&pool, ids[0])
        .await
        .unwrap();
    assert_eq!(
        (
            wallet.balance_minor,
            wallet.frozen_minor,
            wallet.available_minor
        ),
        (1000, 0, 1000)
    );
    // A clearing account stays negative; new frozen-balance constraints apply to users.
    sqlx::query("UPDATE real_hkd_accounts SET updated_at=clock_timestamp()")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        sqlx::query("UPDATE real_hkd_entries SET delta_minor=1")
            .execute(&pool)
            .await
            .is_err()
    );
    assert!(
        matches!(old.run(&pool).await, Err(MigrateError::VersionMissing(_))),
        "old binaries cannot silently restart after this schema upgrade"
    );
    pool.close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}
