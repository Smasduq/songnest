//! Public handle management: `PUT /me/username`.
//!
//! Handles are validated (`username::validate_username`), unique
//! case-insensitively, and append-only — every change inserts a history
//! row, so released handles stay reserved.

use axum::{Json, extract::State};
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    AppState,
    error::{AppError, AuthError},
    routes::auth::{UserView, authenticate, user_view},
    username::validate_username,
};

#[derive(Debug, Deserialize)]
pub struct UsernameBody {
    pub username: String,
}

fn is_unique_violation(e: &sqlx::Error) -> bool {
    e.as_database_error()
        .and_then(|d| d.code())
        .is_some_and(|code| code == "23505")
}

/// `PUT /me/username` → set (or change) the caller's handle. Returns the
/// updated profile view.
pub async fn set_username(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<UsernameBody>,
) -> Result<Json<UserView>, AppError> {
    let user_id = authenticate(&headers, &state.config.jwt_secret)?;
    let name = validate_username(&body.username).map_err(AuthError::InvalidInput)?;
    if let Err(e) = sqlx::query(
        "INSERT INTO usernames (id, user_id, username) VALUES ($1, $2, $3)",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(&name)
    .execute(&state.pool)
    .await
    {
        if is_unique_violation(&e) {
            return Err(AppError::Auth(AuthError::InvalidInput("username is taken")));
        }
        return Err(AppError::Db(e));
    }
    Ok(Json(user_view(&state, user_id).await?))
}
