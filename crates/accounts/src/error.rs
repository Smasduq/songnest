//! Typed errors. Request paths never panic and never leak secrets:
//! every error maps to a generic, safe HTTP response.

use axum::{Json, http::StatusCode, response::IntoResponse};
use serde_json::json;

/// Top-level application error.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("configuration error: {0}")]
    Config(#[from] ConfigError),
    #[error("database unavailable")]
    Db(#[from] sqlx::Error),
    #[error("failed to bind or serve")]
    Io(#[from] std::io::Error),
    #[error("auth failure")]
    Auth(#[from] AuthError),
}

/// Startup configuration failures. Displayed only in server logs,
/// never returned to API clients.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("missing required environment variable {var}")]
    Missing { var: String },
    #[error("invalid value for {var}: {reason}")]
    Invalid { var: String, reason: String },
}

/// Authentication / input failures.
///
/// Security rule: messages sent to clients must never reveal whether an
/// email is registered. `Unauthorized` covers wrong password, unknown
/// email, bad/expired tokens alike. `Duplicate` deliberately does not say
/// the email is taken. Only pure *format* problems (`InvalidInput`) get
/// specific messages — those say nothing about stored data.
#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("invalid credentials or token")]
    Unauthorized,
    #[error("could not create account")]
    Duplicate,
    #[error("{0}")]
    InvalidInput(&'static str),
    #[error("token failure")]
    Token,
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        // Log the full error server-side; clients get a safe message.
        // (Auth failures are routine — log at debug to avoid noise.)
        match &self {
            AppError::Auth(_) => tracing::debug!(error = %self, "auth request failed"),
            _ => tracing::error!(error = %self, "request failed"),
        }
        let (status, message) = match &self {
            AppError::Config(_) | AppError::Db(_) | AppError::Io(_) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error")
            }
            AppError::Auth(AuthError::Unauthorized) => {
                (StatusCode::UNAUTHORIZED, "invalid email or password")
            }
            AppError::Auth(AuthError::Duplicate) => {
                (StatusCode::BAD_REQUEST, "could not create account")
            }
            AppError::Auth(AuthError::InvalidInput(msg)) => (StatusCode::BAD_REQUEST, *msg),
            AppError::Auth(AuthError::Token) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error")
            }
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}
