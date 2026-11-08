#![cfg(feature = "plugin-test-fixtures")]

use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use xiaoq_backend::filing_research::{FilingError, FilingFetcher, FilingResponse, FilingRuntime};

const CIK: &str = "0000320193";
const ACCESSION: &str = "0001140361-26-015711";
fn submissions(document: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({"cik":320193,"name":"Apple Inc.","filings":{"recent":{
        "accessionNumber":[ACCESSION],"form":["8-K"],"filingDate":["2026-04-20"],"reportDate":["2026-04-17"],"primaryDocument":[document]}}})).unwrap()
}
struct Fixture {
    directory: Vec<u8>,
    html: Vec<u8>,
    calls: Mutex<Vec<String>>,
    status: u16,
    mime: &'static str,
}
impl Fixture {
    fn new(document: &str, html: String) -> Self {
        Self {
            directory: submissions(document),
            html: html.into_bytes(),
            calls: Mutex::new(vec![]),
            status: 200,
            mime: "text/html",
        }
    }
}
impl FilingFetcher for Fixture {
    fn fetch<'a>(
        &'a self,
        url: &'a str,
        _limit: usize,
    ) -> Pin<Box<dyn Future<Output = Result<FilingResponse, FilingError>> + Send + 'a>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(url.into());
            assert!(
                url.starts_with("https://data.sec.gov/submissions/CIK")
                    || url.starts_with(
                        "https://www.sec.gov/Archives/edgar/data/320193/000114036126015711/"
                    )
            );
            let directory = url.ends_with(".json");
            Ok(FilingResponse {
                status: self.status,
                content_type: if directory {
                    "application/json"
                } else {
                    self.mime
                }
                .into(),
                bytes: if directory {
                    self.directory.clone()
                } else {
                    self.html.clone()
                },
                retry_after: Some("120".into()),
            })
        })
    }
}

#[tokio::test]
async fn verified_source_documents_paginate_with_a_bound_hash_and_preserve_citations() {
    let source = Arc::new(Fixture::new(
        "report.htm",
        format!(
            "<body><h1 id='business'>Business</h1>{}</body>",
            (0..100)
                .map(|n| format!("<p>Actual public text {n}.</p>"))
                .collect::<String>()
        ),
    ));
    let runtime = FilingRuntime::with_fetcher(source.clone());
    let catalog = runtime.catalog("sec:0000320193").await.unwrap();
    assert_eq!(catalog.filings[0].accession, ACCESSION);
    let first = runtime.document(CIK, ACCESSION, 0, None).await.unwrap();
    assert_eq!(first.paragraphs.len(), 80);
    assert_eq!(first.next_offset, Some(80));
    assert_eq!(first.total_paragraphs, 101);
    assert!(!first.truncated);
    assert!(first.paragraphs[2].source_url.ends_with("#business"));
    let next = runtime
        .document(CIK, ACCESSION, 80, first.sha256.as_deref())
        .await
        .unwrap();
    assert_eq!(next.paragraphs[0].id, "p000080");
    assert_eq!(next.next_offset, None);
    assert_eq!(
        runtime
            .document(CIK, ACCESSION, 80, None)
            .await
            .unwrap_err(),
        FilingError::InvalidInput
    );
    assert_eq!(
        runtime
            .document(CIK, ACCESSION, 80, Some(&"b".repeat(64)))
            .await
            .unwrap_err(),
        FilingError::DocumentChanged
    );
    assert_eq!(
        source.calls.lock().unwrap().len(),
        2,
        "cached pages never redownload or reread unrelated sources"
    );
}

#[tokio::test]
async fn pdf_and_unknown_accession_do_not_fetch_or_invent_document_text() {
    let source = Arc::new(Fixture::new("report.pdf", "not requested".into()));
    let runtime = FilingRuntime::with_fetcher(source.clone());
    let unread = runtime.document(CIK, ACCESSION, 0, None).await.unwrap();
    assert_eq!(unread.status, "not_read");
    assert!(unread.sha256.is_none());
    assert!(unread.paragraphs.is_empty());
    assert!(!unread.limitations.is_empty());
    assert_eq!(
        runtime
            .document(CIK, "0001140361-26-000001", 0, None)
            .await
            .unwrap_err(),
        FilingError::NotFound
    );
    assert_eq!(source.calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn upstream_rate_limit_is_shared_and_never_automatically_retried() {
    let mut fixture = Fixture::new("report.htm", "<body>text</body>".into());
    fixture.status = 429;
    let source = Arc::new(fixture);
    let runtime = FilingRuntime::with_fetcher(source.clone());
    assert_eq!(
        runtime.catalog("sec:0000320193").await.unwrap_err(),
        FilingError::RateLimited
    );
    assert_eq!(
        runtime.catalog("sec:0000000001").await.unwrap_err(),
        FilingError::RateLimited
    );
    assert_eq!(source.calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn source_identity_and_content_type_are_verified_before_text_is_accepted() {
    let mut fixture = Fixture::new("report.htm", "<body>text</body>".into());
    fixture.mime = "application/javascript";
    let runtime = FilingRuntime::with_fetcher(Arc::new(fixture));
    assert_eq!(
        runtime.document(CIK, ACCESSION, 0, None).await.unwrap_err(),
        FilingError::InvalidSource
    );
    let source = Arc::new(Fixture::new("report.htm", "<body>text</body>".into()));
    let runtime = FilingRuntime::with_fetcher(source.clone());
    assert_eq!(
        runtime.catalog("sec:0000000001").await.unwrap_err(),
        FilingError::InvalidSource
    );
    assert_eq!(source.calls.lock().unwrap().len(), 1);
}

struct Stalled {
    calls: AtomicUsize,
}
impl FilingFetcher for Stalled {
    fn fetch<'a>(
        &'a self,
        _url: &'a str,
        _limit: usize,
    ) -> Pin<Box<dyn Future<Output = Result<FilingResponse, FilingError>> + Send + 'a>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            std::future::pending().await
        })
    }
}
#[tokio::test]
async fn bounded_admission_rejects_overload_and_cancellation_never_fetches_next_source() {
    let source = Arc::new(Stalled {
        calls: AtomicUsize::new(0),
    });
    let runtime = Arc::new(FilingRuntime::with_fetcher(source.clone()));
    let mut tasks = Vec::new();
    for _ in 0..4 {
        let r = runtime.clone();
        tasks.push(tokio::spawn(async move {
            r.document(CIK, ACCESSION, 0, None).await
        }));
    }
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    assert_eq!(
        runtime.catalog("sec:0000320193").await.unwrap_err(),
        FilingError::RateLimited
    );
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
    for task in tasks {
        task.abort();
        let _ = task.await;
    }
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
}
