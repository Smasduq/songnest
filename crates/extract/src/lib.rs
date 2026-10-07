//! Extractor spike: YouTube search/resolve behind a trait.
//!
//! Two backends implement it: the desktop `yt-dlp` subprocess (in
//! `songnest-server`) and SongnestPy — yt-dlp running on the embedded
//! CPython interpreter (Chaquopy) inside the Android app, reached over JNI.
//! Enable the on-device backend with `--features songnestpy` (plus an
//! Android target for the real bridge; other targets get a stub that errors
//! cleanly so desktop builds stay light).

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

#[cfg(feature = "songnestpy")]
pub mod songnestpy;

#[cfg(feature = "songnestpy")]
pub use songnestpy::SongnestPyExtractor;

/// Pull `expire`/`exp` out of a googlevideo URL for expires_at.
pub fn url_expiry(url: &str) -> Option<i64> {
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
