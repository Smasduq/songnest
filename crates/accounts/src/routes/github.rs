//! "Login with GitHub" for the GitHub App (user-authorization flow).
//!
//! The GitHub App needs NO repository / organization permissions — only
//! `Account permissions > Email addresses: Read-only` so `/user/emails`
//! returns a private primary email. `GET /user` works with zero permissions
//! via the implicit public-read grant on user-to-server tokens.
//!
//! Flow (frontend drives the redirect, secret never leaves the server):
//! 1. `GET /auth/github/start?redirect_uri=<frontend-callback>`
//!    → `{ authorize_url }`. Frontend stores `state` and redirects there.
//! 2. GitHub redirects back to `redirect_uri?code=…&state=…`.
//! 3. Frontend `POST /auth/github/callback { code, redirect_uri, state? }`
//!    → Songnest `TokenPair` (same shape as email signup/login).
//!
//! Account linking: find by `github_id` first, else by verified primary
//! email. A matching email account gets `github_id` linked onto it so the
//! user can sign in either way. GitHub users have `password_hash = NULL`
//! and cannot use `/auth/login` until they set a password (not implemented).

use axum::{Json, extract::State, response::IntoResponse};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    AppState,
    error::{AppError, AuthError},
    password,
    routes::auth::{TokenPair, issue_pair},
};

#[derive(Debug, Deserialize)]
pub struct StartQuery {
    pub redirect_uri: String,
}

#[derive(Debug, Serialize)]
pub struct StartResponse {
    pub authorize_url: String,
}

/// `GET /auth/github/start` → GitHub authorize URL for the frontend to visit.
pub async fn start(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<StartQuery>,
) -> Result<impl IntoResponse, AppError> {
    let client_id = state.config.github_client_id.clone().ok_or(AppError::Auth(
        AuthError::InvalidInput("github login is not configured"),
    ))?;
    let redirect = validate_redirect(&query.redirect_uri)?;
    let state_param = Uuid::new_v4().to_string().replace('-', "");
    let url = format!(
        "https://github.com/login/oauth/authorize?client_id={}&redirect_uri={}&scope=user%3Aemail&state={}",
        urlencode(&client_id),
        urlencode(&redirect),
        state_param,
    );
    Ok(Json(StartResponse {
        authorize_url: url,
    }))
}

#[derive(Debug, Deserialize)]
pub struct CallbackBody {
    pub code: String,
    pub redirect_uri: String,
}

/// `POST /auth/github/callback` → exchange `code`, find-or-create user,
/// return Songnest tokens.
pub async fn callback(
    State(state): State<AppState>,
    Json(body): Json<CallbackBody>,
) -> Result<Json<TokenPair>, AppError> {
    let (client_id, client_secret) = match (
        state.config.github_client_id.clone(),
        state.config.github_client_secret.clone(),
    ) {
        (Some(id), Some(secret)) => (id, secret),
        _ => {
            return Err(AppError::Auth(AuthError::InvalidInput(
                "github login is not configured",
            )));
        }
    };
    let code = body.code.trim();
    if code.is_empty() || code.len() > 512 {
        return Err(AppError::Auth(AuthError::InvalidInput(
            "invalid github code",
        )));
    }
    let redirect = validate_redirect(&body.redirect_uri)?;

    let http = reqwest::Client::new();
    let token_res: GitHubTokenResponse = http
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
            "redirect_uri": redirect,
        }))
        .send()
        .await
        .map_err(|_| AppError::Auth(AuthError::Unauthorized))?
        .json()
        .await
        .map_err(|_| AppError::Auth(AuthError::Unauthorized))?;
    let access = token_res.access_token.ok_or(AuthError::Unauthorized)?;
    if access.is_empty() {
        return Err(AppError::Auth(AuthError::Unauthorized));
    }

    let gh_user: GitHubUser = http
        .get("https://api.github.com/user")
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "songnest-accounts")
        .bearer_auth(&access)
        .send()
        .await
        .map_err(|_| AppError::Auth(AuthError::Unauthorized))?
        .json()
        .await
        .map_err(|_| AppError::Auth(AuthError::Unauthorized))?;

    let emails: Vec<GitHubEmail> = http
        .get("https://api.github.com/user/emails")
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "songnest-accounts")
        .bearer_auth(&access)
        .send()
        .await
        .map_err(|_| AppError::Auth(AuthError::Unauthorized))?
        .json()
        .await
        .map_err(|_| AppError::Auth(AuthError::Unauthorized))?;
    let email = emails
        .iter()
        .find(|e| e.primary && e.verified)
        .or_else(|| emails.iter().find(|e| e.verified))
        .map(|e| password::normalize_email(&e.email))
        .ok_or(AuthError::Unauthorized)?;
    password::validate_email(&email).map_err(AuthError::InvalidInput)?;

    // 1. Known GitHub ID → that user.
    let by_github: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT id, email FROM users WHERE github_id = $1",
    )
    .bind(gh_user.id)
    .fetch_optional(&state.pool)
    .await?;
    if let Some((id, email)) = by_github {
        // Keep login/email fresh; never overwrite email with a different one.
        sqlx::query(
            "UPDATE users SET github_login = $1 WHERE id = $2",
        )
        .bind(gh_user.login.as_deref())
        .bind(id)
        .execute(&state.pool)
        .await?;
        return Ok(Json(issue_pair(&state, id, &email, None).await?));
    }

    // 2. Matching email (password signup before) → link GitHub ID onto it.
    let by_email: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT id, email FROM users WHERE email = $1",
    )
    .bind(&email)
    .fetch_optional(&state.pool)
    .await?;
    if let Some((id, email)) = by_email {
        sqlx::query(
            "UPDATE users SET github_id = $1, github_login = $2 WHERE id = $3",
        )
        .bind(gh_user.id)
        .bind(gh_user.login.as_deref())
        .bind(id)
        .execute(&state.pool)
        .await?;
        return Ok(Json(issue_pair(&state, id, &email, None).await?));
    }

    // 3. New user — no password.
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users (id, email, password_hash, github_id, github_login) VALUES ($1, $2, NULL, $3, $4)",
    )
    .bind(id)
    .bind(&email)
    .bind(gh_user.id)
    .bind(gh_user.login.as_deref())
    .execute(&state.pool)
    .await?;
    Ok(Json(issue_pair(&state, id, &email, None).await?))
}

/// Only allow http(s) callbacks; GitHub itself enforces the exact match
/// against the app's registered callback URLs. Reject anything else so a
/// rogue `redirect_uri` can't turn the server into an open exchanger.
fn validate_redirect(uri: &str) -> Result<String, AppError> {
    let trimmed = uri.trim();
    if trimmed.len() > 2048 {
        return Err(AppError::Auth(AuthError::InvalidInput(
            "invalid redirect_uri",
        )));
    }
    if trimmed.starts_with("http://localhost:")
        || trimmed.starts_with("http://127.0.0.1:")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("tauri://")
    {
        return Ok(trimmed.to_owned());
    }
    Err(AppError::Auth(AuthError::InvalidInput(
        "invalid redirect_uri",
    )))
}

fn urlencode(s: &str) -> String {
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

#[derive(Debug, Deserialize)]
struct GitHubTokenResponse {
    access_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitHubUser {
    id: i64,
    login: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitHubEmail {
    email: String,
    #[serde(default)]
    primary: bool,
    #[serde(default)]
    verified: bool,
}
