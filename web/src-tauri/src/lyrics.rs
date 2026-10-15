//! Lyrics bridge: the SQLite cache + LRCLIB fetch live in
//! `songnest-server` (desktop sidecar AND the Android in-process server,
//! both on 127.0.0.1:8787). This Tauri command is a thin proxy so the
//! frontend has one `get_lyrics` entry point on every platform and the
//! cache stays single-sourced.

fn server_base() -> String {
    std::env::var("SONGNEST_API_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8787".to_string())
}

/// Same Rust lyric path on desktop and Android: both go through the
/// on-device `songnest-server` (sidecar vs in-process), so one cache.
#[tauri::command]
pub async fn get_lyrics(
    track_id: String,
    artist: String,
    title: String,
    album: String,
    duration: f64,
    dz: Option<u64>,
) -> Result<serde_json::Value, String> {
    let base = server_base();
    let mut url = reqwest::Url::parse(&format!("{base}/api/lyrics"))
        .map_err(|e| format!("bad server url: {e}"))?;
    url.query_pairs_mut()
        .append_pair("key", &track_id)
        .append_pair("artist", &artist)
        .append_pair("title", &title)
        .append_pair("album", &album)
        .append_pair("duration", &duration.round().to_string());
    if let Some(dz) = dz {
        url.query_pairs_mut().append_pair("dz", &dz.to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let res = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("lyrics server unreachable: {e}"))?;
    let status = res.status();
    // A 404 from OUR route carries {"error":"lyrics_not_found"} — a bare
    // 404 means this backend predates the route (stale sidecar/build).
    if status == reqwest::StatusCode::NOT_FOUND {
        let ours = res
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| {
                v.get("error")
                    .and_then(|e| e.as_str())
                    .map(|s| s.to_string())
            });
        if ours.as_deref() == Some("lyrics_not_found") {
            return Err("No lyrics found".to_string());
        }
        return Err(
            "lyrics endpoint missing on this server — update/rebuild the app backend and retry"
                .to_string(),
        );
    }
    if status == reqwest::StatusCode::BAD_GATEWAY {
        return Err("lyrics service unavailable — retry later".to_string());
    }
    if !status.is_success() {
        return Err(format!("lyrics: {status}"));
    }
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("lyrics decode: {e}"))
}

/// Persist the user's per-track sync offset (SQLite, via the server).
#[tauri::command]
pub async fn set_lyric_offset(track_id: String, offset_ms: i64) -> Result<serde_json::Value, String> {
    let base = server_base();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let res = client
        .post(format!("{base}/api/lyrics/offset"))
        .json(&serde_json::json!({"key": track_id, "offset_ms": offset_ms}))
        .send()
        .await
        .map_err(|e| format!("lyrics server unreachable: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("offset: {}", res.status()));
    }
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("offset decode: {e}"))
}
