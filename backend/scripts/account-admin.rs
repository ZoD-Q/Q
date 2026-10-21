//! Restricted local operations. Uses existing DATABASE_URL access; no HTTP listener.
//! Do not put credentials in arguments. Deliberate content reads may contain private data.
use serde_json::{Value, json};
use sqlx::{PgPool, Row, postgres::PgPoolOptions};
use uuid::Uuid;
use xiaoq_backend::account_lifecycle;

fn usage() -> &'static str {
    "Usage: account-admin reports [--after REPORT_UUID] | report UUID [--include-content] | suspend UUID --confirm UUID | reinstate UUID --confirm UUID | delete UUID --confirm UUID | resolve-report UUID --decision dismissed|actioned --confirm UUID\nSet DATABASE_URL using the existing authorized database/SSH environment. Mutations also require Q_ACCOUNT_ADMIN_MUTATIONS=1. No migration or server is started."
}

fn id(value: Option<&String>) -> Result<Uuid, &'static str> {
    value
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or("Provide a valid record UUID.")
}

fn confirmed(args: &[String], expected: Uuid) -> bool {
    args.windows(2)
        .any(|pair| pair[0] == "--confirm" && Uuid::parse_str(&pair[1]).ok() == Some(expected))
}

async fn report(pool: &PgPool, report_id: Uuid, content: bool) -> Result<Value, &'static str> {
    // A single snapshot checks expiry together with every optional private field.
    let row = sqlx::query(
        "SELECT r.id,r.reporter_id,r.reported_id,r.message_id,r.include_evidence,r.created_at,r.expires_at,CASE WHEN $2 THEN r.reason ELSE NULL END AS reason,CASE WHEN $2 AND e.expires_at>clock_timestamp() THEN e.body ELSE NULL END AS evidence,(SELECT action FROM account_operator_audit a WHERE a.report_id=r.id ORDER BY created_at DESC,id DESC LIMIT 1) AS decision FROM social_reports r LEFT JOIN social_report_evidence e ON e.report_id=r.id WHERE r.id=$1 AND r.expires_at>clock_timestamp()",
    ).bind(report_id).bind(content).fetch_optional(pool).await.map_err(|_| "Report read failed.")?
        .ok_or("Report expired or unavailable.")?;
    Ok(json!({
        "id": row.get::<Uuid,_>("id"),
        "reporter_id": row.get::<Uuid,_>("reporter_id"),
        "reported_id": row.get::<Uuid,_>("reported_id"),
        "message_id": row.get::<Option<Uuid>,_>("message_id"),
        "include_evidence": row.get::<bool,_>("include_evidence"),
        "created_at": row.get::<chrono::DateTime<chrono::Utc>,_>("created_at"),
        "expires_at": row.get::<chrono::DateTime<chrono::Utc>,_>("expires_at"),
        "decision": row.get::<Option<String>,_>("decision"),
        "reason": row.get::<Option<String>,_>("reason"),
        "evidence": row.get::<Option<String>,_>("evidence"),
    }))
}

async fn run() -> Result<Value, &'static str> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("");
    let mutation = matches!(
        command,
        "suspend" | "reinstate" | "delete" | "resolve-report"
    );
    if !matches!(
        command,
        "reports" | "report" | "suspend" | "reinstate" | "delete" | "resolve-report"
    ) {
        return Err(usage());
    }
    if mutation && std::env::var("Q_ACCOUNT_ADMIN_MUTATIONS").as_deref() != Ok("1") {
        return Err(
            "Mutations require Q_ACCOUNT_ADMIN_MUTATIONS=1 and explicit UUID confirmation.",
        );
    }
    let target = if command == "reports" {
        if args.len() != 1 && (args.len() != 3 || args[1] != "--after") {
            return Err(usage());
        }
        None
    } else {
        Some(id(args.get(1))?)
    };
    if mutation && !confirmed(&args, target.ok_or(usage())?) {
        return Err("Repeat the exact target UUID with --confirm.");
    }
    match command {
        "suspend" | "reinstate" | "delete" if args.len() != 4 || args[2] != "--confirm" => {
            return Err(usage());
        }
        "resolve-report"
            if args.len() != 6
                || args[2] != "--decision"
                || !matches!(args[3].as_str(), "dismissed" | "actioned")
                || args[4] != "--confirm" =>
        {
            return Err(usage());
        }
        "report" if args.len() != 2 && (args.len() != 3 || args[2] != "--include-content") => {
            return Err(usage());
        }
        _ => {}
    }
    let url = std::env::var("DATABASE_URL").map_err(|_| "DATABASE_URL is not configured.")?;
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .map_err(|_| "Database connection failed.")?;
    let result = match command {
        "reports" => {
            let cursor = if args.len() == 3 {
                let cursor_id = id(args.get(2))?;
                let time: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar(
                    "SELECT created_at FROM social_reports WHERE id=$1 AND expires_at>clock_timestamp()",
                ).bind(cursor_id).fetch_optional(&pool).await.map_err(|_| "Report cursor read failed.")?;
                Some((
                    time.ok_or("Report cursor expired or unavailable; restart the report list.")?,
                    cursor_id,
                ))
            } else {
                None
            };
            let mut ids: Vec<Uuid> = sqlx::query_scalar(
                "SELECT r.id FROM social_reports r WHERE r.expires_at>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM account_operator_audit a WHERE a.report_id=r.id AND a.action IN ('report_dismissed','report_actioned')) AND ($1::timestamptz IS NULL OR (r.created_at,r.id)>($1,$2::uuid)) ORDER BY r.created_at,r.id LIMIT 101",
            ).bind(cursor.map(|(time,_)|time)).bind(cursor.map(|(_,id)|id))
                .fetch_all(&pool).await.map_err(|_| "Report list failed.")?;
            let has_more = ids.len() > 100;
            if has_more {
                ids.truncate(100);
            }
            let next_cursor = has_more.then(|| ids.last().copied()).flatten();
            let mut items = Vec::with_capacity(ids.len());
            for report_id in ids {
                // A report may expire or be erased between the index and detail query.
                if let Ok(value) = report(&pool, report_id, false).await {
                    items.push(value);
                }
            }
            json!({"items":items,"limit":100,"has_more":has_more,"next_cursor":next_cursor})
        }
        "report" => report(&pool, target.ok_or(usage())?, args.len() == 3).await?,
        "suspend" | "reinstate" => {
            account_lifecycle::operator_status(&pool, target.ok_or(usage())?, command == "suspend")
                .await
                .map_err(|error| error.code)?;
            json!({"ok":true})
        }
        "delete" => serde_json::to_value(
            account_lifecycle::operator_delete(&pool, target.ok_or(usage())?)
                .await
                .map_err(|error| error.code)?,
        )
        .map_err(|_| "Result encoding failed.")?,
        "resolve-report" => {
            account_lifecycle::operator_resolve_report(
                &pool,
                target.ok_or(usage())?,
                args[3] == "actioned",
            )
            .await
            .map_err(|error| error.code)?;
            json!({"ok":true})
        }
        _ => return Err(usage()),
    };
    pool.close().await;
    Ok(result)
}

#[tokio::main]
async fn main() {
    match run().await {
        Ok(value) => println!("{value}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
