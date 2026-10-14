//! "Login with Google" (OAuth 2.0 authorization-code flow).
//!
//! Same shape as GitHub login: frontend redirects to Google, Google returns
//! to `redirect_uri?code=…&state=…`, frontend posts the code here, the
//! server exchanges it (secret never leaves the server) and returns a
//! Songnest `TokenPair`.
//!
//! Requested scopes are `openid email profile` only — non-sensitive, so no
//! Google verification is needed. Account linking mirrors GitHub: find by
//! `google_sub` first, else by verified email, else create passwordless.

use axum::{Json, extract::State, response::IntoResponse};
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

/// `GET /auth/google/start` → Google authorize URL for the frontend to visit.
pub async fn start(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<StartQuery>,
) -> Result<impl IntoResponse, AppError> {
    let client_id =
        state
            .config
            .google_client_id
            .clone()
            .ok_or(AppError::Auth(AuthError::InvalidInput(
                "google login is not configured",
            )))?;
    let redirect = validate_redirect(&query.redirect_uri)?;
    let state_param = Uuid::new_v4().to_string().replace('-', "");
    let url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope=openid%20email%20profile&state={}",
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

/// `POST /auth/google/callback` → exchange `code`, find-or-create user,
/// return Songnest tokens.
pub async fn callback(
    State(state): State<AppState>,
    Json(body): Json<CallbackBody>,
) -> Result<Json<TokenPair>, AppError> {
    let (client_id, client_secret) = match (
        state.config.google_client_id.clone(),
        state.config.google_client_secret.clone(),
    ) {
        (Some(id), Some(secret)) => (id, secret),
        _ => {
            return Err(AppError::Auth(AuthError::InvalidInput(
                "google login is not configured",
            )));
        }
    };
    let code = body.code.trim();
    if code.is_empty() || code.len() > 2048 {
        return Err(AppError::Auth(AuthError::InvalidInput(
            "invalid google code",
        )));
    }
    let redirect = validate_redirect(&body.redirect_uri)?;

    let http = reqwest::Client::new();
    let token_res: GoogleTokenResponse = http
        .post("https://oauth2.googleapis.com/token")
        .json(&serde_json::json!({
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
            "grant_type": "authorization_code",
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

    let info: GoogleUserinfo = http
        .get("https://openidconnect.googleapis.com/v1/userinfo")
        .bearer_auth(&access)
        .send()
        .await
        .map_err(|_| AppError::Auth(AuthError::Unauthorized))?
        .json()
        .await
        .map_err(|_| AppError::Auth(AuthError::Unauthorized))?;
    if !info.email_verified {
        return Err(AppError::Auth(AuthError::Unauthorized));
    }
    let email = password::normalize_email(&info.email);
    password::validate_email(&email).map_err(AuthError::InvalidInput)?;

    // 1. Known Google sub → that user.
    let by_google: Option<(Uuid, String)> =
        sqlx::query_as("SELECT id, email FROM users WHERE google_sub = $1")
            .bind(&info.sub)
            .fetch_optional(&state.pool)
            .await?;
    if let Some((id, email)) = by_google {
        let username = current_username(&state.pool, id).await?;
        return Ok(Json(issue_pair(&state, id, &email, username, None).await?));
    }

    // 2. Matching email → link Google sub onto it.
    let by_email: Option<(Uuid, String)> =
        sqlx::query_as("SELECT id, email FROM users WHERE email = $1")
            .bind(&email)
            .fetch_optional(&state.pool)
            .await?;
    if let Some((id, email)) = by_email {
        sqlx::query("UPDATE users SET google_sub = $1 WHERE id = $2")
            .bind(&info.sub)
            .bind(id)
            .execute(&state.pool)
            .await?;
        let username = current_username(&state.pool, id).await?;
        return Ok(Json(issue_pair(&state, id, &email, username, None).await?));
    }

    // 3. New user — no password.
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users (id, email, password_hash, google_sub) VALUES ($1, $2, NULL, $3)",
    )
    .bind(id)
    .bind(&email)
    .bind(&info.sub)
    .execute(&state.pool)
    .await?;
    Ok(Json(issue_pair(&state, id, &email, None, None).await?))
}

#[derive(Debug, Deserialize)]
struct GoogleTokenResponse {
    access_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GoogleUserinfo {
    sub: String,
    email: String,
    #[serde(default)]
    email_verified: bool,
}
