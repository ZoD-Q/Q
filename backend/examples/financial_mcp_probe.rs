//! Manual anonymous read of CoinGecko's public BTC reference. No credentials or trades.
#[tokio::main]
async fn main() {
    match xiaoq_backend::plugins::financial::probe_coingecko().await {
        Ok(result) => println!("{}", result),
        Err(error) => {
            eprintln!("{}", error.code);
            std::process::exit(1);
        }
    }
}
