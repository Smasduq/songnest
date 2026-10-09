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

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        // Log the full error server-side; clients get a generic message.
        tracing::error!(error = %self, "request failed");
        let (status, message) = match &self {
            AppError::Config(_) | AppError::Db(_) | AppError::Io(_) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error")
            }
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}
