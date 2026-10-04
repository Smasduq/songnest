//! songnest-cli: thin CLI over songnest-server.
//!
//! - `cli serve [--data-dir DIR]` (env: SONGNEST_DATA_DIR, SONGNEST_BACKEND,
//!   SONGNEST_PORT): run the HTTP server + queue workers.
//! - `cli <query>`: single-shot Deezer search -> download -> tag.
//! - `cli extract|search|extract-compare ...` (`rp` feature): extractor spike.

#[cfg(feature = "rp")]
mod extract_cli;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let arg = args.get(1).expect("usage: cli <query> | serve [--data-dir DIR]");
    #[cfg(feature = "rp")]
    if arg == "extract" || arg == "extract-compare" || arg == "search" {
        return extract_cli::extract_cli(&args).await;
    }
    #[cfg(not(feature = "rp"))]
    if arg == "extract" || arg == "extract-compare" || arg == "search" {
        anyhow::bail!("rebuild with --features rp for the extractor spike");
    }
    if arg == "serve" {
        // desktop mode: keep library.db/music/cookies.txt in the app data dir
        let dir = std::env::var("SONGNEST_DATA_DIR").ok().or_else(|| {
            args.windows(2).find_map(|w| {
                if w[0] == "--data-dir" {
                    Some(w[1].clone())
                } else {
                    None
                }
            })
        });
        let backend = songnest_server::backend_from_env()?;
        return songnest_server::run(dir, backend, songnest_server::port_from_env()).await;
    }
    songnest_server::single_shot(arg).await
}
