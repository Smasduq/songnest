//! "Login with GitHub" for the GitHub App.
//!
//! The GitHub App needs NO repository / organization permissions — only
//! `Account permissions > Email addresses: Read-only` so `/user/emails`
//! returns a private primary email. `GET /user` works with zero permissions
//! via the implicit public-read grant on user-to-server tokens.
//!
//! Two flows (secret never leaves the server, both return the Songnest
//! `TokenPair` shape):
//!
//! Web redirect (browser):
//! 1. `GET /auth/github/start?redirect_uri=<frontend-callback>`
//!    → `{ authorize_url }`. Frontend stores `state` and redirects there.
//! 2. GitHub redirects back to `redirect_uri?code=…&state=…`.
//! 3. Frontend `POST /auth/github/callback { code, redirect_uri }`.
//!    Every registered redirect URL must exactly match what the app sends.
//!
//! Device flow (desktop/mobile, or when callback URLs can't be registered):
//! 1. Frontend `POST /auth/github/device/start` →
//!    `{ user_code, verification_uri, device_code, expires_in, interval }`.
//! 2. User enters `user_code` at `verification_uri` (any browser).
//! 3. Frontend polls `POST /auth/github/device/poll { device_code }` every
//!    `interval` seconds → `202 { "pending": true }` until the user approves,
//!    then `200` + tokens. `410` = expired/denied, stop polling.
//!    Requires ticking **Enable Device Flow** in the app's settings.
//!
//! Account linking: find by `github_id` first, else by verified primary
//! email. A matching email account gets `github_id` linked onto it so the
//! user can sign in either way. GitHub users have `password_hash = NULL`
//! and cannot use `/auth/login` until they set a password (not implemented).

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    AppState,
    error::{AppError, AuthError},
    password,
    routes::{
        auth::{TokenPair, issue_pair},
        oauth_common::{urlencode, validate_redirect},
    },
    username::current_username,
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
    let client_id =
        state
            .config
            .github_client_id
            .clone()
            .ok_or(AppError::Auth(AuthError::InvalidInput(
                "github login is not configured",
            )))?;
    let redirect = validate_redirect(&query.redirect_uri)?;
    let state_param = Uuid::new_v4().to_string().replace('-', "");
    let url = format!(
        "https://github.com/login/oauth/authorize?client_id={}&redirect_uri={}&scope=user%3Aemail&state={}",
        urlencode(&client_id),
        urlencode(&redirect),
        state_param,
    );
    Ok(Json(StartResponse { authorize_url: url }))
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
    let (client_id, client_secret) = github_credentials(&state)?;
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
        .map_err(|_| provider_unreachable())?
        .json()
        .await
        .map_err(|_| provider_unreachable())?;
    let access = match (token_res.access_token, token_res.error) {
        (Some(token), _) if !token.is_empty() => token,
        (_, Some(code)) if code == "incorrect_device_code" || code == "expired_token" => {
            return Err(AppError::Auth(AuthError::InvalidInput(
                "github login expired — start over",
            )));
        }
        _ => {
            return Err(AppError::Auth(AuthError::InvalidInput(
                "github login was denied — start over",
            )));
        }
    };

    let (gh_id, gh_login, email) = github_identity(&http, &access).await?;
    Ok(Json(
        find_or_create_github_user(&state, gh_id, gh_login.as_deref(), &email).await?,
    ))
}

#[derive(Debug, Serialize)]
pub struct DeviceStartResponse {
    pub user_code: String,
    pub verification_uri: String,
    pub device_code: String,
    pub expires_in: u64,
    pub interval: u64,
}

/// `POST /auth/github/device/start` → code for the user to enter at
/// `verification_uri`. No callback URL involved.
pub async fn device_start(State(state): State<AppState>) -> Result<impl IntoResponse, AppError> {
    let (client_id, _) = github_credentials(&state)?;
    let res: GitHubDeviceCodeResponse = reqwest::Client::new()
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "client_id": client_id,
            "scope": "user:email",
        }))
        .send()
        .await
        .map_err(|_| provider_unreachable())?
        .json()
        .await
        .map_err(|_| provider_unreachable())?;
    if res.device_code.is_empty() || res.user_code.is_empty() {
        // Device flow not enabled on the app, or GitHub error.
        return Err(AppError::Auth(AuthError::InvalidInput(
            "github device login is not enabled for this app",
        )));
    }
    Ok(Json(DeviceStartResponse {
        user_code: res.user_code,
        verification_uri: res
            .verification_uri
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| "https://github.com/login/device".to_owned()),
        device_code: res.device_code,
        expires_in: res.expires_in,
        interval: res.interval.max(5),
    }))
}

#[derive(Debug, Deserialize)]
pub struct DevicePollBody {
    pub device_code: String,
}

/// `POST /auth/github/device/poll` → `202 { pending: true }` while the user
/// hasn't approved yet, `200` + tokens once approved, `410` when the code
/// expired or access was denied (stop polling).
pub async fn device_poll(
    State(state): State<AppState>,
    Json(body): Json<DevicePollBody>,
) -> Result<impl IntoResponse, AppError> {
    let (client_id, _) = github_credentials(&state)?;
    let device_code = body.device_code.trim();
    if device_code.is_empty() || device_code.len() > 512 {
        return Err(AppError::Auth(AuthError::InvalidInput(
            "invalid device code",
        )));
    }

    let res: GitHubDeviceTokenResponse = reqwest::Client::new()
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "client_id": client_id,
            "device_code": device_code,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        }))
        .send()
        .await
        .map_err(|_| provider_unreachable())?
        .json()
        .await
        .map_err(|_| provider_unreachable())?;

    if let Some(access) = res.access_token.filter(|t| !t.is_empty()) {
        let http = reqwest::Client::new();
        let (gh_id, gh_login, email) = github_identity(&http, &access).await?;
        let pair = find_or_create_github_user(&state, gh_id, gh_login.as_deref(), &email).await?;
        return Ok((StatusCode::OK, Json(serde_json::to_value(pair).unwrap())).into_response());
    }
    match res.error.as_deref() {
        // Not approved yet — keep polling.
        Some("authorization_pending") | Some("slow_down") => Ok((
            StatusCode::ACCEPTED,
            Json(serde_json::json!({ "pending": true })),
        )
            .into_response()),
        // Dead code — stop polling.
        _ => Err(AppError::Auth(AuthError::InvalidInput(
            "github login expired or was denied — start over",
        ))),
    }
}

fn github_credentials(state: &AppState) -> Result<(String, String), AppError> {
    match (
        state.config.github_client_id.clone(),
        state.config.github_client_secret.clone(),
    ) {
        (Some(id), Some(secret)) => Ok((id, secret)),
        _ => Err(AppError::Auth(AuthError::InvalidInput(
            "github login is not configured",
        ))),
    }
}

/// Fetch the GitHub user id, login, and verified primary email for a
/// user-to-server token.
///
/// Failures are reported as bad-request (not generic 401): these describe
/// the provider interaction, never our stored credentials, so a specific
/// message is safe and debuggable.
async fn github_identity(
    http: &reqwest::Client,
    access: &str,
) -> Result<(i64, Option<String>, String), AppError> {
    let user_res = http
        .get("https://api.github.com/user")
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "songnest-accounts")
        .bearer_auth(access)
        .send()
        .await
        .map_err(|_| provider_unreachable())?;
    if !user_res.status().is_success() {
        return Err(provider_unreachable());
    }
    let gh_user: GitHubUser = user_res.json().await.map_err(|_| provider_unreachable())?;

    let emails_res = http
        .get("https://api.github.com/user/emails")
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "songnest-accounts")
        .bearer_auth(access)
        .send()
        .await
        .map_err(|_| provider_unreachable())?;
    if !emails_res.status().is_success() {
        // Almost always a missing app permission: the token can only read
        // emails when Account > Email addresses is Read-only.
        return Err(AppError::Auth(AuthError::InvalidInput(
            "github app can't read emails — set Account > Email addresses to Read-only",
        )));
    }
    let emails: Vec<GitHubEmail> = emails_res
        .json()
        .await
        .map_err(|_| provider_unreachable())?;
    let email = emails
        .iter()
        .find(|e| e.primary && e.verified)
        .or_else(|| emails.iter().find(|e| e.verified))
        .map(|e| password::normalize_email(&e.email))
        .ok_or_else(|| {
            AppError::Auth(AuthError::InvalidInput(
                "no verified email on your github account — verify one and try again",
            ))
        })?;
    password::validate_email(&email).map_err(AuthError::InvalidInput)?;
    Ok((gh_user.id, gh_user.login, email))
}

/// OAuth failures are client-visible 400s (never the generic password
/// 401): they describe the provider call, not stored credentials.
fn provider_unreachable() -> AppError {
    AppError::Auth(AuthError::InvalidInput("couldn't reach github — try again"))
}

/// Find by `github_id`, else link onto a matching email, else create a
/// passwordless user. Prefills the GitHub login as handle when free.
/// Shared by the redirect and device flows.
async fn find_or_create_github_user(
    state: &AppState,
    gh_id: i64,
    gh_login: Option<&str>,
    email: &str,
) -> Result<TokenPair, AppError> {
    // 1. Known GitHub ID → that user.
    let by_github: Option<(Uuid, String)> =
        sqlx::query_as("SELECT id, email FROM users WHERE github_id = $1")
            .bind(gh_id)
            .fetch_optional(&state.pool)
            .await?;
    if let Some((id, email)) = by_github {
        // Keep login fresh; never overwrite email with a different one.
        sqlx::query("UPDATE users SET github_login = $1 WHERE id = $2")
            .bind(gh_login)
            .bind(id)
            .execute(&state.pool)
            .await?;
        return finish_github_login(state, id, &email, gh_login).await;
    }

    // 2. Matching email (password signup before) → link GitHub ID onto it.
    let by_email: Option<(Uuid, String)> =
        sqlx::query_as("SELECT id, email FROM users WHERE email = $1")
            .bind(email)
            .fetch_optional(&state.pool)
            .await?;
    if let Some((id, email)) = by_email {
        sqlx::query("UPDATE users SET github_id = $1, github_login = $2 WHERE id = $3")
            .bind(gh_id)
            .bind(gh_login)
            .bind(id)
            .execute(&state.pool)
            .await?;
        return finish_github_login(state, id, &email, gh_login).await;
    }

    // 3. New user — no password.
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users (id, email, password_hash, github_id, github_login) VALUES ($1, $2, NULL, $3, $4)",
    )
    .bind(id)
    .bind(email)
    .bind(gh_id)
    .bind(gh_login)
    .execute(&state.pool)
    .await?;
    finish_github_login(state, id, email, gh_login).await
}

/// Prefill the GitHub login as handle (best effort) and mint the pair.
async fn finish_github_login(
    state: &AppState,
    id: Uuid,
    email: &str,
    gh_login: Option<&str>,
) -> Result<TokenPair, AppError> {
    if let Some(login) = gh_login {
        crate::username::maybe_claim_username(&state.pool, id, login).await;
    }
    let username = current_username(&state.pool, id).await?;
    issue_pair(state, id, email, username, None).await
}

#[derive(Debug, Deserialize)]
struct GitHubTokenResponse {
    access_token: Option<String>,
    #[serde(default)]
    error: Option<String>,
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

#[derive(Debug, Deserialize)]
struct GitHubDeviceCodeResponse {
    #[serde(default)]
    device_code: String,
    #[serde(default)]
    user_code: String,
    #[serde(default)]
    verification_uri: Option<String>,
    #[serde(default)]
    expires_in: u64,
    #[serde(default)]
    interval: u64,
}

#[derive(Debug, Deserialize)]
struct GitHubDeviceTokenResponse {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    error: Option<String>,
}
