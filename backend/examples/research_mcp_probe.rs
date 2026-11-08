//! Explicit anonymous Tavily search/extract acceptance probe; public SEC documentation only.
#[tokio::main]
async fn main() {
    let mode = std::env::args().nth(1);
    let extract = match mode.as_deref() {
        Some("search") => false,
        Some("extract") => true,
        _ => {
            eprintln!("Usage: research_mcp_probe search|extract");
            std::process::exit(2);
        }
    };
    match xiaoq_backend::plugins::financial::probe_tavily(extract).await {
        Ok(result) => println!("{result}"),
        Err(error) => {
            eprintln!("{}", error.code);
            std::process::exit(1);
        }
    }
}
