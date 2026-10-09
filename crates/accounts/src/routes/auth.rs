//! Account endpoints: signup, login, refresh, logout, me.
//!
//! TODO (out of scope for now): email verification and password reset.
//! The schema already isolates credentials (`users.password_hash`), so a
//! `email_verified_at` column + token table can be added without migration
//! pain. Endpoints would be `POST /auth/verify` and
//! `POST /auth/password-reset` / `POST /auth/password-reset/confirm`.

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    AppState,
    error::{AppError, AuthError},
    password, tokens,
};

/// A stored refresh token (hashes only — raw values never hit the DB).
#[derive(Debug, sqlx::FromRow)]
struct RefreshRow {
    id: Uuid,
    user_id: Uuid,
    expires_at: DateTime<Utc>,
    revoked_at: Option<DateTime<Utc>>,
}

/// Dummy argon2id hash used to equalize login timing when the email is
/// unknown (hash of "songnest-dummy", default params). Never stored.
const DUMMY_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$c29uZ25lc3QtZHVtbXktc2FsdA$8Xv9v1qK6m9YQn1Q2b3V4X5Y6Z7a8B9c0D1E2F3A4";

#[derive(Debug, Deserialize)]
pub struct Credentials {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct RefreshBody {
    pub refresh_token: String,
}

#[derive(Debug, Serialize)]
pub struct UserView {
    pub id: Uuid,
    pub email: String,
}

#[derive(Debug, Serialize)]
pub struct TokenPair {
    pub user: UserView,
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
}

/// `POST /auth/signup` → 201 + tokens, or a generic 400.
pub async fn signup(
    State(state): State<AppState>,
    Json(body): Json<Credentials>,
) -> Result<impl IntoResponse, AppError> {
    let email = password::normalize_email(&body.email);
    password::validate_email(&email).map_err(AuthError::InvalidInput)?;
    password::validate_password(&body.password).map_err(AuthError::InvalidInput)?;
    let hash =
        password::hash_password(&body.password).map_err(|_| AppError::Auth(AuthError::Token))?;

    let id = Uuid::new_v4();
    let inserted = sqlx::query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(&email)
        .bind(&hash)
        .execute(&state.pool)
        .await;
    if let Err(e) = inserted {
        // Unique violation on email → generic duplicate error (must not
        // reveal that the address is registered). Anything else → 500.
        if is_unique_violation(&e) {
            return Err(AppError::Auth(AuthError::Duplicate));
        }
        return Err(AppError::Db(e));
    }

    let pair = issue_pair(&state, id, &email, None).await?;
    Ok((StatusCode::CREATED, Json(pair)))
}

/// `POST /auth/login` → 200 + tokens, or generic 401.
pub async fn login(
    State(state): State<AppState>,
    Json(body): Json<Credentials>,
) -> Result<Json<TokenPair>, AppError> {
    let email = password::normalize_email(&body.email);
    password::validate_email(&email).map_err(AuthError::InvalidInput)?;

    let row: Option<(Uuid, String, String)> =
        sqlx::query_as("SELECT id, email, password_hash FROM users WHERE email = $1")
            .bind(&email)
            .fetch_optional(&state.pool)
            .await?;

    match row {
        Some((id, email, hash)) if password::verify_password(&body.password, &hash) => {
            Ok(Json(issue_pair(&state, id, &email, None).await?))
        }
        _ => {
            // Unknown email: still run a verification to avoid leaking
            // existence through timing, then fail generically.
            if row.is_none() {
                let _ = password::verify_password(&body.password, DUMMY_HASH);
            }
            Err(AppError::Auth(AuthError::Unauthorized))
        }
    }
}

/// `POST /auth/refresh` → rotated pair, or generic 401.
///
/// Rotation: the presented token is revoked and the replacement names it
/// as its rotation parent. Presenting an already-rotated token inside a
/// short grace window is treated as a client retry (the first response was
/// lost): rotation moves forward instead of failing. Past the window it
/// means theft — the whole chain is revoked.
pub async fn refresh(
    State(state): State<AppState>,
    Json(body): Json<RefreshBody>,
) -> Result<Json<TokenPair>, AppError> {
    /// Retry grace: a rotated token reused inside this window re-rotates.
    const REUSE_GRACE: chrono::TimeDelta = chrono::TimeDelta::seconds(60);

    let hash = tokens::hash_refresh(body.refresh_token.trim());
    let row: Option<RefreshRow> = sqlx::query_as(
        "SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1",
    )
    .bind(&hash)
    .fetch_optional(&state.pool)
    .await?;

    let Some(token) = row else {
        return Err(AppError::Auth(AuthError::Unauthorized));
    };
    let RefreshRow {
        id: token_id,
        user_id,
        expires_at,
        revoked_at,
    } = token;
    if expires_at < Utc::now() {
        return Err(AppError::Auth(AuthError::Unauthorized));
    }

    // Revoked tokens: logout/manual revoke → plain 401. Rotated tokens →
    // retry (in grace) or theft (past grace).
    let rotate_from = if let Some(revoked_at) = revoked_at {
        match rotation_child(&state, token_id).await? {
            None => return Err(AppError::Auth(AuthError::Unauthorized)),
            Some(child) if Utc::now() - revoked_at <= REUSE_GRACE => {
                revoke_one(&state, child).await?;
                child
            }
            Some(_) => {
                revoke_all(&state, user_id).await?;
                return Err(AppError::Auth(AuthError::Unauthorized));
            }
        }
    } else {
        token_id
    };

    let email: Option<String> = sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?;
    let Some(email) = email else {
        return Err(AppError::Auth(AuthError::Unauthorized));
    };

    let pair = issue_pair(&state, user_id, &email, Some(rotate_from)).await?;
    revoke_one(&state, rotate_from).await?;
    Ok(Json(pair))
}

/// `POST /auth/logout` → always 200 (unknown tokens fail silently so
/// logout can't be used to probe token validity).
pub async fn logout(
    State(state): State<AppState>,
    Json(body): Json<RefreshBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    let hash = tokens::hash_refresh(body.refresh_token.trim());
    sqlx::query("UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1")
        .bind(&hash)
        .execute(&state.pool)
        .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Authenticated user id, extracted from `Authorization: Bearer <jwt>`.
///
/// A plain helper (not a `FromRequestParts` impl) so every failure maps to
/// the same generic 401 without trait plumbing.
pub fn authenticate(headers: &axum::http::HeaderMap, jwt_secret: &str) -> Result<Uuid, AppError> {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or(AppError::Auth(AuthError::Unauthorized))?;
    Ok(tokens::verify_access(jwt_secret, token)?.user_id)
}

/// `GET /me` → the caller's profile.
pub async fn me(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Result<Json<UserView>, AppError> {
    let user_id = authenticate(&headers, &state.config.jwt_secret)?;
    let row: Option<(Uuid, String)> = sqlx::query_as("SELECT id, email FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?;
    match row {
        Some((id, email)) => Ok(Json(UserView { id, email })),
        None => Err(AppError::Auth(AuthError::Unauthorized)),
    }
}

/// Mint an access token + persistent refresh token for a user.
/// `rotated_from` links the new token to the one it replaces.
async fn issue_pair(
    state: &AppState,
    user_id: Uuid,
    email: &str,
    rotated_from: Option<Uuid>,
) -> Result<TokenPair, AppError> {
    let access = tokens::mint_access(&state.config.jwt_secret, user_id, state.config.access_ttl)?;
    let refresh_raw = tokens::generate_refresh();
    let refresh_hash = tokens::hash_refresh(&refresh_raw);
    let expires_at = Utc::now() + state.config.refresh_ttl;
    sqlx::query(
        "INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, rotated_from)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(&refresh_hash)
    .bind(expires_at)
    .bind(rotated_from)
    .execute(&state.pool)
    .await?;
    Ok(TokenPair {
        user: UserView {
            id: user_id,
            email: email.to_owned(),
        },
        access_token: access,
        refresh_token: refresh_raw,
        expires_in: state.config.access_ttl.as_secs(),
    })
}

/// The rotation child of `token_id`, if it was replaced by rotation.
async fn rotation_child(state: &AppState, token_id: Uuid) -> Result<Option<Uuid>, AppError> {
    sqlx::query_scalar("SELECT id FROM refresh_tokens WHERE rotated_from = $1 LIMIT 1")
        .bind(token_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(AppError::Db)
}

/// Revoke a single refresh token.
async fn revoke_one(state: &AppState, token_id: Uuid) -> Result<(), AppError> {
    sqlx::query("UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1")
        .bind(token_id)
        .execute(&state.pool)
        .await?;
    Ok(())
}

/// Revoke every refresh token of a user (theft response / password change).
async fn revoke_all(state: &AppState, user_id: Uuid) -> Result<(), AppError> {
    sqlx::query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1")
        .bind(user_id)
        .execute(&state.pool)
        .await?;
    Ok(())
}

fn is_unique_violation(e: &sqlx::Error) -> bool {
    e.as_database_error()
        .and_then(|d| d.code())
        .is_some_and(|code| code == "23505")
}
