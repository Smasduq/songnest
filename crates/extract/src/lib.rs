//! Extractor spike: YouTube search/resolve/download behind a trait.
//!
//! The production paths still use yt-dlp; this crate only ADDS an
//! alternative for experiments (notably: running on Android/iOS where no
//! Python/yt-dlp exists). Enable with `--features rustypipe`.

use async_trait::async_trait;

/// One search hit, shaped for the existing scorer.
#[derive(Clone, Debug)]
pub struct Candidate {
    pub id: String,
    pub title: String,
    pub duration_secs: Option<u64>,
    pub channel: Option<String>,
}

/// A resolved playable stream.
#[derive(Clone, Debug)]
pub struct Stream {
    pub url: String,
    pub mime: String,
    pub bitrate: Option<u64>,
    /// unix expiry if the URL carries one, else None
    pub expires_at: Option<i64>,
    /// extra request headers the player must send (usually empty)
    pub headers: Vec<(String, String)>,
}

#[async_trait]
pub trait Extractor: Send + Sync {
    async fn search_music(&self, query: &str) -> anyhow::Result<Vec<Candidate>>;
    async fn resolve(&self, video_id: &str) -> anyhow::Result<Stream>;
}

/// Device-code login (TV-style: user types the code at google.com/device).
/// No passwords involved; the token stays in the extractor's storage dir.
#[derive(Clone, Debug, serde::Serialize)]
pub struct DeviceCode {
    pub user_code: String,
    pub verification_url: String,
    pub expires_in: u32,
    pub interval: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthStatus {
    LoggedIn,
    Pending,
    Expired,
}

#[cfg(feature = "rustypipe")]
pub mod rustypipe_impl;

#[cfg(feature = "rustypipe")]
pub use rustypipe_impl::RustyPipeExtractor;

/// Re-exported so callers can pick per-client resolve order.
#[cfg(feature = "rustypipe")]
pub use rustypipe::client::{ClientType, RustyPipe};
