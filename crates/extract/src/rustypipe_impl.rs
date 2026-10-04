//! rustypipe-backed [`Extractor`](crate::Extractor).
//!
//! Client strategy: Android first (no PO token needed), then iOS, TV,
//! Desktop. Web clients need the external rustypipe-botguard binary, which
//! we deliberately do NOT bundle — if only web clients work, resolve fails
//! with a clear error instead of hanging.
//!
//! Stream choice mirrors `ba`: best audio-only stream, preferring m4a/AAC
//! (plays everywhere, taggable) and falling back to the highest-bitrate
//! audio otherwise. The direct URL means no ffmpeg transcode step.
//!
//! Upstream hardening: rustypipe 0.11.4 `util/visitor_data.rs:113` calls
//! `.unwrap()` on `fetch_visitor_data()` instead of propagating `Err`
//! (panics on transient `Http("error decoding response body")` etc.).
//! Every query below therefore runs in a spawned task so a panic surfaces
//! as `JoinError` (converted to `Err`) instead of crashing the caller,
//! with a short retry for transient failures.

use anyhow::Context;
use async_trait::async_trait;
use rustypipe::client::{ClientType, RustyPipe};

use crate::{Candidate, Extractor, Stream};

pub struct RustyPipeExtractor {
    rp: RustyPipe,
}

impl RustyPipeExtractor {
    pub fn new(storage_dir: &str) -> anyhow::Result<Self> {
        let rp = RustyPipe::builder()
            .storage_dir(storage_dir)
            .build()
            .context("rustypipe client init")?;
        Ok(Self { rp })
    }
}

/// Pick the audio stream: best m4a/AAC first (plays everywhere, taggable),
/// else highest-bitrate audio. Mirrors the old `ba` preference.
fn pick_audio(
    player: &rustypipe::model::VideoPlayer,
) -> Option<rustypipe::model::AudioStream> {
    use rustypipe::model::AudioFormat;
    player
        .audio_streams
        .iter()
        .filter(|a| a.format == AudioFormat::M4a)
        .max_by_key(|a| a.bitrate)
        .or_else(|| player.audio_streams.iter().max_by_key(|a| a.bitrate))
        .cloned()
}

/// Pull `expire`/`exp` out of a googlevideo URL for expires_at.
fn url_expiry(url: &str) -> Option<i64> {
    for key in ["expire=", "exp="] {
        if let Some(i) = url.find(key) {
            let rest = &url[i + key.len()..];
            let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(v) = num.parse::<i64>() {
                if v > 1_000_000_000 {
                    return Some(v);
                }
            }
        }
    }
    None
}

const CLIENTS: &[ClientType] = &[
    ClientType::Android,
    ClientType::Ios,
    ClientType::Tv,
    ClientType::Desktop,
];

/// rustypipe 0.11.4 panics (unwrap) on transient visitor-data fetch
/// failures instead of returning Err. Run each query in a spawned task so
/// the panic is captured as a JoinError and converted to Err.
fn panic_detail(err: tokio::task::JoinError) -> String {
    let payload = err.into_panic();
    if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else if let Some(s) = payload.downcast_ref::<&str>() {
        s.to_string()
    } else {
        "unknown panic payload".to_string()
    }
}

async fn player_guarded(
    rp: &RustyPipe,
    video_id: &str,
    client: ClientType,
) -> anyhow::Result<rustypipe::model::VideoPlayer> {
    let rp = rp.clone();
    let id = video_id.to_string();
    let join = tokio::task::spawn(async move { rp.query().player_from_client(&id, client).await });
    match join.await {
        Ok(inner) => inner.map_err(|e| anyhow::anyhow!("{client:?} player failed: {e}")),
        Err(e) if e.is_panic() => {
            anyhow::bail!("{client:?} player panicked (upstream unwrap): {}", panic_detail(e))
        }
        Err(e) => anyhow::bail!("{client:?} player task failed: {e}"),
    }
}

async fn search_guarded(
    rp: &RustyPipe,
    query: &str,
) -> anyhow::Result<rustypipe::model::SearchResult<rustypipe::model::VideoItem>> {
    let rp = rp.clone();
    let q = query.to_string();
    let join =
        tokio::task::spawn(async move { rp.query().search::<rustypipe::model::VideoItem, _>(&q).await });
    match join.await {
        Ok(inner) => inner.context("rustypipe search"),
        Err(e) if e.is_panic() => {
            anyhow::bail!("search panicked (upstream unwrap): {}", panic_detail(e))
        }
        Err(e) => anyhow::bail!("search task failed: {e}"),
    }
}

#[async_trait]
impl Extractor for RustyPipeExtractor {
    async fn search_music(&self, query: &str) -> anyhow::Result<Vec<Candidate>> {
        let mut last_err = String::new();
        for attempt in 1..=3 {
            match search_guarded(&self.rp, query).await {
                Ok(res) => {
                    return Ok(res
                        .items
                        .items
                        .into_iter()
                        .filter(|v| !v.is_live && !v.is_upcoming)
                        .take(5)
                        .map(|v| Candidate {
                            id: v.id,
                            title: v.name,
                            duration_secs: v.duration.map(|d| d as u64),
                            channel: v.channel.map(|c| c.name),
                        })
                        .collect());
                }
                Err(e) => {
                    last_err = e.to_string();
                    if attempt < 3 {
                        tokio::time::sleep(std::time::Duration::from_millis(400 * attempt as u64)).await;
                    }
                }
            }
        }
        anyhow::bail!("rustypipe search failed after 3 attempts: {last_err}")
    }

    async fn resolve(&self, video_id: &str) -> anyhow::Result<Stream> {
        let mut last_err = String::new();
        for client in CLIENTS {
            let mut client_err = String::new();
            for attempt in 1..=2 {
                match player_guarded(&self.rp, video_id, *client).await {
                    Ok(player) => {
                        if let Some(a) = pick_audio(&player) {
                            return Ok(Stream {
                                url: a.url.clone(),
                                mime: a.mime.clone(),
                                bitrate: Some(a.bitrate as u64),
                                expires_at: url_expiry(&a.url),
                                headers: Vec::new(),
                            });
                        }
                        client_err = format!("{client:?} player has no audio stream");
                        break;
                    }
                    Err(e) => {
                        client_err = e.to_string();
                        if attempt < 2 {
                            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                        }
                    }
                }
            }
            last_err = client_err;
        }
        anyhow::bail!("unplayable {video_id}: {last_err}")
    }
}

#[cfg(test)]
mod tests {
    use super::url_expiry;

    #[test]
    fn expiry_parses_googlevideo_params() {
        assert_eq!(
            url_expiry("https://x.googlevideo.com/v?expire=1791028558&x=1"),
            Some(1791028558)
        );
        assert_eq!(
            url_expiry("https://x.googlevideo.com/v?exp=1791028558&x=1"),
            Some(1791028558)
        );
        assert_eq!(url_expiry("https://x.googlevideo.com/v?n=1"), None);
        // tiny numbers are not unix timestamps
        assert_eq!(url_expiry("https://x.example/?expire=42"), None);
    }
}
