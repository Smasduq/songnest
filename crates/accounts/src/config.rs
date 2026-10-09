//! Configuration, exclusively from environment variables.
//!
//! Never commit secrets: see `.env.example` for the full list.

use std::net::SocketAddr;
use std::time::Duration;

use crate::error::{AppError, ConfigError};

/// Development defaults. Production MUST override secrets and origins.
const DEFAULT_BIND: &str = "127.0.0.1:8788";
const DEFAULT_ACCESS_TTL_SECS: u64 = 15 * 60;
const DEFAULT_REFRESH_TTL_SECS: u64 = 60 * 60 * 24 * 30;
const DEFAULT_MAX_BODY_BYTES: usize = 1024 * 1024;
const DEFAULT_AUTH_PER_MINUTE: u64 = 10;
/// Dev origins: Vite dev server + Tauri dev + Tauri prod protocol.
const DEFAULT_CORS_ORIGINS: &str =
    "http://localhost:1420,http://127.0.0.1:1420,tauri://localhost,http://tauri.localhost";

#[derive(Debug, Clone)]
pub struct Config {
    /// Address to bind (bind loopback in production; Caddy terminates TLS).
    pub bind: SocketAddr,
    /// Postgres URL, e.g. `postgres://songnest:…@127.0.0.1:5432/songnest`.
    pub database_url: String,
    /// HMAC secret for access-token JWTs. No default — must be set.
    pub jwt_secret: String,
    /// Access-token lifetime.
    pub access_ttl: Duration,
    /// Refresh-token lifetime.
    pub refresh_ttl: Duration,
    /// Max JSON body size in bytes (sync batches stay small).
    pub max_body_bytes: usize,
    /// Allowed `Origin` values for CORS (exact match, no wildcards).
    pub cors_origins: Vec<String>,
    /// Max auth requests per minute per IP.
    pub auth_per_minute: u64,
}

impl Config {
    pub fn from_env() -> Result<Self, AppError> {
        Ok(Self {
            bind: parse_env("SONGNEST_ACCOUNTS_BIND", DEFAULT_BIND)?,
            database_url: require_env("DATABASE_URL")?,
            jwt_secret: require_env("SONGNEST_JWT_SECRET")?,
            access_ttl: Duration::from_secs(parse_env(
                "SONGNEST_ACCESS_TTL_SECS",
                &DEFAULT_ACCESS_TTL_SECS.to_string(),
            )?),
            refresh_ttl: Duration::from_secs(parse_env(
                "SONGNEST_REFRESH_TTL_SECS",
                &DEFAULT_REFRESH_TTL_SECS.to_string(),
            )?),
            max_body_bytes: parse_env(
                "SONGNEST_MAX_BODY_BYTES",
                &DEFAULT_MAX_BODY_BYTES.to_string(),
            )?,
            cors_origins: parse_origins(&env_or("SONGNEST_CORS_ORIGINS", DEFAULT_CORS_ORIGINS)),
            auth_per_minute: parse_env(
                "SONGNEST_AUTH_PER_MINUTE",
                &DEFAULT_AUTH_PER_MINUTE.to_string(),
            )?,
        })
    }
}

/// Split a comma-separated origin list, trimming whitespace and empties.
pub fn parse_origins(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_owned())
}

fn require_env(key: &str) -> Result<String, AppError> {
    let value = std::env::var(key).map_err(|_| {
        AppError::from(ConfigError::Missing {
            var: key.to_owned(),
        })
    })?;
    if value.trim().is_empty() {
        return Err(AppError::from(ConfigError::Missing {
            var: key.to_owned(),
        }));
    }
    Ok(value)
}

fn parse_env<T>(key: &str, default: &str) -> Result<T, AppError>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    let raw = env_or(key, default);
    raw.parse::<T>().map_err(|e| {
        AppError::from(ConfigError::Invalid {
            var: key.to_owned(),
            reason: e.to_string(),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_split_and_trim() {
        assert_eq!(
            parse_origins(" https://a.example , ,http://localhost:1420,"),
            vec!["https://a.example", "http://localhost:1420"]
        );
        assert!(parse_origins("").is_empty());
    }

    #[test]
    fn missing_required_env_errors() {
        // Required vars must be absent for this assertion; save/restore them.
        let saved_db = std::env::var("DATABASE_URL").ok();
        let saved_jwt = std::env::var("SONGNEST_JWT_SECRET").ok();
        // SAFETY: single-threaded test process mutation; restored below.
        unsafe {
            std::env::remove_var("DATABASE_URL");
            std::env::remove_var("SONGNEST_JWT_SECRET");
        }
        let err = Config::from_env().unwrap_err().to_string();
        unsafe {
            if let Some(v) = saved_db {
                std::env::set_var("DATABASE_URL", v);
            }
            if let Some(v) = saved_jwt {
                std::env::set_var("SONGNEST_JWT_SECRET", v);
            }
        }
        assert!(err.contains("DATABASE_URL"), "unexpected error: {err}");
    }
}
