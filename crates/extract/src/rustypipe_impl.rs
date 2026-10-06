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

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::Instant;

use anyhow::Context;
use async_trait::async_trait;
use rustypipe::client::{ClientType, RustyPipe};

use crate::{AuthStatus, Candidate, DeviceCode, Extractor, Stream};

#[derive(Clone)]
pub struct RustyPipeExtractor {
    rp: RustyPipe,
    /// Set once a device-code login completes (or a cached session checks
    /// out at startup); cleared on logout. Queries attach auth only then —
    /// anonymous clients must never send half-authenticated requests.
    authed: std::sync::Arc<AtomicBool>,
    pending: std::sync::Arc<Mutex<Option<(rustypipe::client::OauthDeviceCode, Instant)>>>,
}

impl RustyPipeExtractor {
    pub fn new(storage_dir: &str) -> anyhow::Result<Self> {
        let rp = RustyPipe::builder()
            .storage_dir(storage_dir)
            .build()
            .context("rustypipe client init")?;
        Ok(Self {
            rp,
            authed: Default::default(),
            pending: Default::default(),
        })
    }

    fn authed_query(&self) -> rustypipe::client::RustyPipeQuery {
        let q = self.rp.query();
        if self.authed.load(Ordering::Relaxed) {
            q.authenticated()
        } else {
            q
        }
    }

    /// Begin TV device-code login. Show `user_code` to the user with
    /// `verification_url`; poll with `auth_poll()`.
    pub async fn auth_begin(&self) -> anyhow::Result<DeviceCode> {
        let code = self.rp.user_auth_get_code().await?;
        let out = DeviceCode {
            user_code: code.user_code.clone(),
            verification_url: code.verification_url.clone(),
            expires_in: code.expires_in,
            interval: code.interval,
        };
        *self.pending.lock().unwrap() =
            Some((code, Instant::now() + std::time::Duration::from_secs(out.expires_in as u64)));
        Ok(out)
    }

    /// Poll a pending login once. LoggedIn also flips future queries to
    /// authenticated; Expired clears the pending code.
    pub async fn auth_poll(&self) -> anyhow::Result<AuthStatus> {
        // take (don't borrow): the login call awaits and must not hold the lock.
        let entry = self.pending.lock().unwrap().take();
        let Some((code, until)) = entry else {
            return Ok(AuthStatus::Expired);
        };
        if Instant::now() > until {
            return Ok(AuthStatus::Expired);
        }
        match self.rp.user_auth_login(&code).await {
            Ok(true) => {
                self.authed.store(true, Ordering::Relaxed);
                Ok(AuthStatus::LoggedIn)
            }
            Ok(false) => {
                *self.pending.lock().unwrap() = Some((code, until));
                Ok(AuthStatus::Pending)
            }
            Err(e) if e.to_string().contains("expired") => Ok(AuthStatus::Expired),
            Err(e) => {
                *self.pending.lock().unwrap() = Some((code, until));
                Err(anyhow::anyhow!("{e}"))
            }
        }
    }

    pub async fn auth_logout(&self) -> anyhow::Result<()> {
        let r = self.rp.user_auth_logout().await;
        self.authed.store(false, Ordering::Relaxed);
        // already-logged-out is fine
        match r {
            Ok(()) => Ok(()),
            Err(e)
                if e.to_string().contains("not logged in")
                    || e.to_string().contains("invalid_token") =>
            {
                Ok(())
            }
            Err(e) => Err(anyhow::anyhow!("{e}")),
        }
    }

    /// Non-fatal session check for startup: a cached token that still
    /// refreshes flips queries to authenticated.
    pub async fn check_login(&self) -> bool {
        match self.rp.user_auth_check_login().await {
            Ok(()) => {
                self.authed.store(true, Ordering::Relaxed);
                true
            }
            Err(_) => false,
        }
    }

    pub fn is_logged_in(&self) -> bool {
        self.authed.load(Ordering::Relaxed)
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

/// When signed in, TV goes first: it is the only non-web client whose
/// requests actually carry the login (OAuth Bearer token), so its URLs
/// get trusted treatment. Anonymous keeps Android first (no deobfuscation
/// needed and historically the strongest anonymous client).
const CLIENTS_AUTHED: &[ClientType] = &[
    ClientType::Tv,
    ClientType::Android,
    ClientType::Ios,
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
    ex: &RustyPipeExtractor,
    video_id: &str,
    client: ClientType,
) -> anyhow::Result<rustypipe::model::VideoPlayer> {
    let ex = ex.clone();
    let id = video_id.to_string();
    let join =
        tokio::task::spawn(async move { ex.authed_query().player_from_client(&id, client).await });
    match join.await {
        Ok(inner) => inner.map_err(|e| anyhow::anyhow!("{client:?} player failed: {e}")),
        Err(e) if e.is_panic() => {
            anyhow::bail!("{client:?} player panicked (upstream unwrap): {}", panic_detail(e))
        }
        Err(e) => anyhow::bail!("{client:?} player task failed: {e}"),
    }
}

async fn search_guarded(
    ex: &RustyPipeExtractor,
    query: &str,
) -> anyhow::Result<rustypipe::model::SearchResult<rustypipe::model::VideoItem>> {
    let ex = ex.clone();
    let q = query.to_string();
    let join = tokio::task::spawn(
        async move { ex.authed_query().search::<rustypipe::model::VideoItem, _>(&q).await },
    );
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
            match search_guarded(self, query).await {
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
        let clients = if self.is_logged_in() {
            CLIENTS_AUTHED
        } else {
            CLIENTS
        };
        for client in clients {
            let mut client_err = String::new();
            for attempt in 1..=2 {
                match player_guarded(self, video_id, *client).await {
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
