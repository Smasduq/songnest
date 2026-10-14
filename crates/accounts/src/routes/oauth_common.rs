//! Shared helpers for OAuth logins (GitHub + Google).
//!
//! Both providers run the same shape: frontend redirects to the provider,
//! provider returns to `redirect_uri?code=…&state=…`, frontend posts the
//! code to the backend, backend exchanges it server-side (secret never
//! leaves the server) and returns a Songnest token pair.

use crate::error::{AppError, AuthError};

/// Only allow callbacks the app can actually receive: local dev servers,
/// production https origins, and Tauri bundle origins (desktop `tauri://`,
/// Android `http://tauri.localhost`). Providers additionally enforce their
/// own registered-callback match, so this is defense in depth against a
/// rogue `redirect_uri` turning the server into an open code exchanger.
pub fn validate_redirect(uri: &str) -> Result<String, AppError> {
    let trimmed = uri.trim();
    if trimmed.len() > 2048 {
        return Err(AppError::Auth(AuthError::InvalidInput(
            "invalid redirect_uri",
        )));
    }
    if trimmed.starts_with("http://localhost:")
        || trimmed.starts_with("http://127.0.0.1:")
        || trimmed.starts_with("http://tauri.localhost")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("tauri://")
    {
        return Ok(trimmed.to_owned());
    }
    Err(AppError::Auth(AuthError::InvalidInput(
        "invalid redirect_uri",
    )))
}

/// Percent-encode a query parameter value (unreserved set left as-is).
pub fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
