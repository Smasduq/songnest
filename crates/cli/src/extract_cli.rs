//! Test CLI for the extractor spike (`rp` feature only).
//!
//! - `cli extract <video_id> [--no-botguard]`: resolve one video, print JSON.
//! - `cli search <query...>`: rustypipe search path, print JSON hits.
//! - `cli extract-compare ids.txt`: per video × {rp, rp+botguard, yt-dlp},
//!   record success/time/format/bitrate + first-1MB range fetch, print table.
//!
//! NOTE: `--no-botguard` edits this process's PATH (removing the botguard
//! dir) before building the client. Single-threaded test tool only.

use songnest_extract::{Extractor, RustyPipeExtractor};

fn botguard_dir() -> Option<std::path::PathBuf> {
    let found = std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths).find_map(|d| {
            let c = d.join("rustypipe-botguard");
            if c.is_file() {
                Some(d)
            } else {
                None
            }
        })
    })?;
    found.to_str().map(std::path::PathBuf::from)
}

fn without_botguard() {
    if let Some(dir) = botguard_dir() {
        let dir_s = dir.to_string_lossy().into_owned();
        let filtered: Vec<_> = std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        )
        .filter(|d| d.to_string_lossy() != dir_s)
        .collect();
        // single-threaded test tool: safe to mutate process env here
        unsafe {
            std::env::set_var("PATH", std::env::join_paths(filtered).unwrap());
        }
    }
}

fn storage_dir() -> String {
    let d = std::env::temp_dir().join("songnest-rp-spike");
    let _ = std::fs::create_dir_all(&d);
    d.to_string_lossy().into_owned()
}

pub async fn extract_cli(args: &[String]) -> anyhow::Result<()> {
    match args.get(1).map(|s| s.as_str()) {
        Some("extract") => {
            let id = args.get(2).expect("usage: cli extract <video_id> [--no-botguard]");
            if args.iter().any(|a| a == "--no-botguard") {
                without_botguard();
            }
            let ex = RustyPipeExtractor::new(&storage_dir())?;
            let s = ex.resolve(id).await?;
            println!(
                "{}",
                serde_json::json!({
                    "url": s.url,
                    "mime": s.mime,
                    "bitrate": s.bitrate,
                    "expires_at": s.expires_at,
                    "headers": s.headers,
                })
            );
            Ok(())
        }
        Some("search") => {
            anyhow::ensure!(args.len() >= 3, "usage: cli search <query...>");
            if args.iter().any(|a| a == "--no-botguard") {
                without_botguard();
            }
            let query = args[2..]
                .iter()
                .filter(|a| *a != "--no-botguard")
                .cloned()
                .collect::<Vec<_>>()
                .join(" ");
            let ex = RustyPipeExtractor::new(&storage_dir())?;
            let hits = ex.search_music(&query).await?;
            println!(
                "{}",
                serde_json::json!(hits
                    .iter()
                    .map(|c| serde_json::json!({
                        "id": c.id,
                        "title": c.title,
                        "duration_secs": c.duration_secs,
                        "channel": c.channel,
                    }))
                    .collect::<Vec<_>>())
            );
            Ok(())
        }
        Some("extract-compare") => {
            let file = args.get(2).expect("usage: cli extract-compare <ids.txt>");
            extract_compare(file).await
        }
        _ => unreachable!("extract_cli called for another subcommand"),
    }
}

struct Attempt {
    id: String,
    mode: &'static str,
    ok: bool,
    ms: u128,
    detail: String,
    range_ok: bool,
}

async fn range_probe(
    http: &reqwest::Client,
    url: &str,
    headers: &[(String, String)],
) -> bool {
    let mut req = http.get(url).header("Range", "bytes=0-1048575");
    for (k, v) in headers {
        req = req.header(k, v);
    }
    match req.send().await {
        Ok(r) => {
            let st = r.status();
            if !(st.is_success() || st.as_u16() == 206) {
                return false;
            }
            match r.bytes().await {
                Ok(b) => !b.is_empty(),
                Err(_) => false,
            }
        }
        Err(_) => false,
    }
}

async fn run_self(
    http: &reqwest::Client,
    exe: &std::path::Path,
    id: &str,
    extra_env: Option<(&str, &str)>,
    extra_args: &[&str],
) -> Attempt {
    let t0 = std::time::Instant::now();
    let mut cmd = tokio::process::Command::new(exe);
    cmd.arg("extract").arg(id);
    for a in extra_args {
        cmd.arg(a);
    }
    if let Some((k, v)) = extra_env {
        cmd.env(k, v);
    }
    // hide botguard dir from PATH unless this mode wants it
    if extra_args.is_empty() {
        if let Some(dir) = botguard_dir() {
            let filtered: Vec<_> = std::env::split_paths(
                &std::env::var_os("PATH").unwrap_or_default(),
            )
            .filter(|d| d != &dir)
            .collect();
            if let Ok(p) = std::env::join_paths(filtered) {
                cmd.env("PATH", p);
            }
        }
    }
    let out = cmd.output().await;
    let ms = t0.elapsed().as_millis();
    match out {
        Ok(o) if o.status.success() => {
            let v: serde_json::Value =
                serde_json::from_slice(&o.stdout).unwrap_or_default();
            let url = v.get("url").and_then(|u| u.as_str()).unwrap_or("");
            let detail = format!(
                "{} {}kbps",
                v.get("mime").and_then(|m| m.as_str()).unwrap_or("?"),
                v.get("bitrate").and_then(|b| b.as_u64()).unwrap_or(0) / 1000
            );
            let headers: Vec<(String, String)> = v
                .get("headers")
                .and_then(|h| h.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|p| {
                            Some((
                                p.get(0)?.as_str()?.to_string(),
                                p.get(1)?.as_str()?.to_string(),
                            ))
                        })
                        .collect()
                })
                .unwrap_or_default();
            let range_ok = if url.is_empty() {
                false
            } else {
                range_probe(http, url, &headers).await
            };
            Attempt {
                id: id.to_string(),
                mode: if extra_args.is_empty() {
                    "rp"
                } else {
                    "rp+botguard?"
                },
                ok: true,
                ms,
                detail,
                range_ok,
            }
        }
        _ => Attempt {
            id: id.to_string(),
            mode: "rp",
            ok: false,
            ms,
            detail: "resolve failed".to_string(),
            range_ok: false,
        },
    }
}

async fn run_ytdlp(http: &reqwest::Client, id: &str) -> Attempt {
    let t0 = std::time::Instant::now();
    let out = tokio::process::Command::new("yt-dlp")
        .args([
            "-f",
            "ba[ext=m4a]/ba",
            "-g",
            &format!("https://youtube.com/watch?v={id}"),
        ])
        .output()
        .await;
    let ms = t0.elapsed().as_millis();
    match out {
        Ok(o) if o.status.success() => {
            let url = String::from_utf8_lossy(&o.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            let range_ok = range_probe(http, &url, &[]).await;
            Attempt {
                id: id.to_string(),
                mode: "yt-dlp",
                ok: !url.is_empty(),
                ms,
                detail: "m4a/ba".to_string(),
                range_ok,
            }
        }
        _ => Attempt {
            id: id.to_string(),
            mode: "yt-dlp",
            ok: false,
            ms,
            detail: "resolve failed".to_string(),
            range_ok: false,
        },
    }
}

fn median(mut v: Vec<u128>) -> u128 {
    if v.is_empty() {
        return 0;
    }
    v.sort_unstable();
    v[v.len() / 2]
}

async fn extract_compare(file: &str) -> anyhow::Result<()> {
    let ids: Vec<String> = std::fs::read_to_string(file)?
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();
    anyhow::ensure!(!ids.is_empty(), "no video ids in {file}");
    let exe = std::env::current_exe()?;
    let http = reqwest::Client::new();
    let has_botguard = botguard_dir().is_some();
    println!("botguard binary on PATH: {has_botguard}");
    let mut rows: Vec<Attempt> = Vec::new();
    for id in &ids {
        rows.push(run_self(&http, &exe, id, None, &[]).await);
        if has_botguard {
            // botguard mode: leave PATH alone so rustypipe can find it
            rows.push(run_self(&http, &exe, id, None, &["--botguard"]).await);
        }
        rows.push(run_ytdlp(&http, id).await);
    }
    println!(
        "\n{:<14} {:<12} {:<7} {:<10} {:<18} {:<6}",
        "video", "mode", "ok", "ms", "detail", "range1M"
    );
    for r in &rows {
        println!(
            "{:<14} {:<12} {:<7} {:<10} {:<18} {:<6}",
            r.id,
            r.mode,
            if r.ok { "yes" } else { "no" },
            r.ms,
            r.detail,
            if r.range_ok { "yes" } else { "no" }
        );
    }
    for mode in ["rp", "rp+botguard?", "yt-dlp"] {
        let set: Vec<&Attempt> = rows.iter().filter(|r| r.mode == mode).collect();
        if set.is_empty() {
            continue;
        }
        let ok = set.iter().filter(|r| r.ok).count();
        let times: Vec<u128> = set.iter().filter(|r| r.ok).map(|r| r.ms).collect();
        let range = set.iter().filter(|r| r.range_ok).count();
        println!(
            "SUMMARY {mode:<12} success {ok}/{}  median {}ms  range-ok {range}/{}",
            set.len(),
            median(times),
            set.len()
        );
    }
    Ok(())
}
