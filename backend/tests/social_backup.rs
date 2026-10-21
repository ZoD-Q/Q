//! Actual pg_dump/pg_restore acceptance using the deployed backup exclusion policy.
//! Requires a disposable TEST_DATABASE_URL whose role may create databases, libpq credentials
//! (e.g. PGPASSWORD for password auth), and pg_dump/pg_restore on PATH or Q_PG_BIN_DIR.
use std::{path::PathBuf, process::Command, str::FromStr};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::Request,
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgConnectOptions};
use tower::ServiceExt;
use uuid::Uuid;
use xiaoq_backend::{AppState, app};

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (u16, Value) {
    let mut request = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    if body.is_some() {
        request = request.header("Content-Type", "application/json");
    }
    let response = app
        .clone()
        .oneshot(
            request
                .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    (
        status,
        if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        },
    )
}

async fn register(app: &Router, handle: &str) -> (String, String) {
    let (status, body) = request(
        app,
        "POST",
        "/v1/auth/register",
        None,
        Some(json!({"handle":handle,"display_name":handle,"password":"SocialBackupTestPassword!"})),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    (
        body["token"].as_str().unwrap().to_owned(),
        body["user"]["id"].as_str().unwrap().to_owned(),
    )
}

fn postgres_tool(name: &str) -> PathBuf {
    std::env::var_os("Q_PG_BIN_DIR").map_or_else(
        || PathBuf::from(name),
        |path| PathBuf::from(path).join(name),
    )
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL, database creation privileges and pg_dump/pg_restore"]
async fn deployed_backup_policy_never_restores_ephemeral_or_report_content() {
    let url = std::env::var("TEST_DATABASE_URL")
        .expect("Set TEST_DATABASE_URL to a disposable test database");
    let options = PgConnectOptions::from_str(&url).unwrap();
    let admin = PgPool::connect_with(options.clone()).await.unwrap();
    let suffix = Uuid::new_v4().simple().to_string();
    let source_name = format!("q_backup_src_{suffix}");
    let restored_name = format!("q_backup_dst_{suffix}");
    for name in [&source_name, &restored_name] {
        sqlx::query(&format!("CREATE DATABASE {name}"))
            .execute(&admin)
            .await
            .unwrap();
    }
    let source = PgPool::connect_with(options.clone().database(&source_name))
        .await
        .unwrap();
    sqlx::migrate!().run(&source).await.unwrap();
    let state = AppState::new(source.clone()).await.unwrap();
    let router = app(state, vec!["http://localhost:8081".parse().unwrap()]);
    let (alice, _) = register(&router, "backup_alice").await;
    let (bob, bob_id) = register(&router, "backup_bob").await;
    let (_, invitation) = request(
        &router,
        "POST",
        "/v1/social/requests",
        Some(&alice),
        Some(json!({"user_id":bob_id,"note":""})),
    )
    .await;
    let result = request(
        &router,
        "POST",
        &format!(
            "/v1/social/requests/{}/respond",
            invitation["id"].as_str().unwrap()
        ),
        Some(&bob),
        Some(json!({"accept":true})),
    )
    .await;
    assert_eq!(result.0, 200, "{}", result.1);
    let (_, snapshot) = request(&router, "GET", "/v1/social/snapshot", Some(&alice), None).await;
    let conversation = snapshot["friends"][0]["conversation_id"].as_str().unwrap();
    let message_path = format!("/v1/social/conversations/{conversation}/messages");
    let ai_path = format!("/v1/ai/conversations/{}", Uuid::new_v4());
    let (ai_status, _) = request(
        &router,
        "POST",
        &ai_path,
        Some(&alice),
        Some(json!({"request_id":Uuid::new_v4(),"expected_revision":0,"title":"Persistent AI history","messages":[{"id":"backup-user","role":"user","content":"AI history survives restoration","status":"complete"}]})),
    ).await;
    assert_eq!(ai_status, 200);
    let (_, normal) = request(&router, "POST", &message_path, Some(&alice), Some(json!({"client_message_id":Uuid::new_v4(),"body":"ordinary history survives","ttl_seconds":null}))).await;
    let (_, unopened) = request(&router, "POST", &message_path, Some(&alice), Some(json!({"client_message_id":Uuid::new_v4(),"body":"unopened temporary content","ttl_seconds":300}))).await;
    let (_, opened) = request(&router, "POST", &message_path, Some(&alice), Some(json!({"client_message_id":Uuid::new_v4(),"body":"opened temporary content","ttl_seconds":300}))).await;
    let opened_id = opened["id"].as_str().unwrap();
    let (status, opened_body) = request(
        &router,
        "POST",
        &format!("/v1/social/messages/{opened_id}/open"),
        Some(&bob),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, 200, "{opened_body}");
    let deadline = opened_body["expires_at"].as_str().unwrap().to_owned();
    let (_, alice_profile) = request(&router, "GET", "/v1/me", Some(&alice), None).await;
    let report_id = Uuid::new_v4();
    let report_request = json!({"client_report_id":report_id,"user_id":alice_profile["id"],"message_id":opened_id,"reason":"explicit evidence consent in isolated test","include_evidence":true});
    let (status, body) = request(
        &router,
        "POST",
        "/v1/social/reports",
        Some(&bob),
        Some(report_request.clone()),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let receipt_expiry: DateTime<Utc> = sqlx::query_scalar(
        "SELECT expires_at FROM social_report_receipts WHERE client_report_id=$1",
    )
    .bind(report_id)
    .fetch_one(&source)
    .await
    .unwrap();
    let payload_count: i64 = sqlx::query_scalar("SELECT count(*) FROM social_ephemeral_payloads")
        .fetch_one(&source)
        .await
        .unwrap();
    let evidence_count: i64 = sqlx::query_scalar("SELECT count(*) FROM social_report_evidence")
        .fetch_one(&source)
        .await
        .unwrap();
    assert_eq!(payload_count, 2);
    assert_eq!(evidence_count, 1);

    let directory = std::env::temp_dir().join(format!("q-social-backup-{suffix}"));
    std::fs::create_dir(&directory).unwrap();
    let dump = directory.join("database.dump");
    let policy = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("deploy/backup-policy.sh");
    // Only trusted positional parameters enter the shell; credentials are inherited via libpq env.
    let output = Command::new("bash").args(["-c", "source \"$1\"; exec \"$2\" --host \"$3\" --port \"$4\" --username \"$5\" --dbname \"$6\" --format=custom --file \"$7\" \"${Q_DUMP_EXCLUDES[@]}\"", "q-backup-test"])
        .arg(&policy).arg(postgres_tool("pg_dump")).arg(options.get_host()).arg(options.get_port().to_string()).arg(options.get_username()).arg(&source_name).arg(&dump)
        .output().expect("Run pg_dump via the shared deployment policy");
    assert!(
        output.status.success(),
        "pg_dump failed; check libpq credentials and Q_PG_BIN_DIR"
    );
    let output = Command::new(postgres_tool("pg_restore"))
        .args([
            "--exit-on-error",
            "--no-owner",
            "--host",
            options.get_host(),
            "--port",
            &options.get_port().to_string(),
            "--username",
            options.get_username(),
            "--dbname",
            &restored_name,
        ])
        .arg(&dump)
        .output()
        .expect("Run pg_restore into an independent test database");
    assert!(
        output.status.success(),
        "pg_restore failed; check PostgreSQL client compatibility"
    );
    let restored = PgPool::connect_with(options.clone().database(&restored_name))
        .await
        .unwrap();
    for table in [
        "social_ephemeral_payloads",
        "social_report_evidence",
        "social_reports",
    ] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&restored)
            .await
            .unwrap();
        assert_eq!(
            count, 0,
            "temporary table {table} must be empty after restore"
        );
    }
    let restored_expiry: DateTime<Utc> = sqlx::query_scalar(
        "SELECT expires_at FROM social_report_receipts WHERE client_report_id=$1",
    )
    .bind(report_id)
    .fetch_one(&restored)
    .await
    .unwrap();
    assert_eq!(restored_expiry, receipt_expiry);
    let restored_deadline: DateTime<Utc> =
        sqlx::query_scalar("SELECT expires_at FROM social_messages WHERE id=$1")
            .bind(Uuid::parse_str(opened_id).unwrap())
            .fetch_one(&restored)
            .await
            .unwrap();
    assert_eq!(
        restored_deadline,
        DateTime::parse_from_rfc3339(&deadline)
            .unwrap()
            .with_timezone(&Utc)
    );
    let restored_router = app(
        AppState::new(restored.clone()).await.unwrap(),
        vec!["http://localhost:8081".parse().unwrap()],
    );
    let (ai_status, ai_history) =
        request(&restored_router, "GET", &ai_path, Some(&alice), None).await;
    assert_eq!(ai_status, 200);
    assert_eq!(
        ai_history["messages"][0]["content"],
        "AI history survives restoration"
    );
    let (other_status, _) = request(&restored_router, "GET", &ai_path, Some(&bob), None).await;
    assert_eq!(other_status, 404);
    for id in [unopened["id"].as_str().unwrap(), opened_id] {
        let (status, body) = request(
            &restored_router,
            "POST",
            &format!("/v1/social/messages/{id}/open"),
            Some(&bob),
            Some(json!({})),
        )
        .await;
        assert_eq!(
            status, 410,
            "restored temporary content must stay unavailable: {body}"
        );
    }
    let (status, history) = request(&restored_router, "GET", &message_path, Some(&bob), None).await;
    assert_eq!(status, 200);
    assert!(
        history["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["id"] == normal["id"]
                && message["body"] == "ordinary history survives")
    );
    assert!(
        history["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["kind"] == "ephemeral")
            .all(|message| message["body"].is_null() && message["expired"] == true)
    );
    let (status, body) = request(
        &restored_router,
        "POST",
        "/v1/social/reports",
        Some(&bob),
        Some(report_request),
    )
    .await;
    assert_eq!(
        status, 410,
        "restored report receipt must not recreate evidence: {body}"
    );

    drop(router);
    drop(restored_router);
    source.close().await;
    restored.close().await;
    for name in [&source_name, &restored_name] {
        sqlx::query(&format!("DROP DATABASE {name}"))
            .execute(&admin)
            .await
            .unwrap();
    }
    admin.close().await;
    std::fs::remove_file(dump).unwrap();
    std::fs::remove_dir(directory).unwrap();
}
