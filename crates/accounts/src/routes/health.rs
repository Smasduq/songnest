//! Liveness probe: process is up and the database answers.

use axum::{Json, extract::State};
use serde_json::{Value, json};

use crate::{AppState, error::AppError};

/// `GET /health` → `{"status":"ok"}` when the DB answers, else 500.
pub async fn health(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    sqlx::query("SELECT 1").execute(&state.pool).await?;
    Ok(Json(
        json!({ "status": "ok", "service": "songnest-accounts" }),
    ))
}
