//! Profile pictures (`PUT /me/avatar`, `DELETE /me/avatar`).
//!
//! Bytes live in Neon Object Storage under `avatars/<user_id>/<uuid>.<ext>`
//! (a fresh key per upload, so replaced pictures never serve stale cached
//! copies); Postgres keeps only the key (`users.avatar_key`). The bucket is
//! `public_read`, so `GET /me` can hand out a plain HTTPS `avatar_url` and
//! browsers load it directly — writes always go through here, authenticated,
//! validated, and size-capped.

use axum::{Json, body::Bytes, extract::State, http::StatusCode, response::IntoResponse};
use serde::Serialize;
use uuid::Uuid;

use crate::{
    AppState,
    error::{AppError, AuthError},
    routes::auth::authenticate,
    storage::Storage,
};

#[derive(Debug, Serialize)]
pub struct AvatarView {
    pub avatar_url: String,
}

/// `PUT /me/avatar` → 200 + `{avatar_url}`.
///
/// Body is the raw image (JPEG, PNG, WebP, or GIF, sniffed by magic bytes —
/// the declared `Content-Type` is not trusted). Overwrites any previous
/// picture under a fresh cache-busting key.
pub async fn put_avatar(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    body: Bytes,
) -> Result<Json<AvatarView>, AppError> {
    let user_id = authenticate(&headers, &state.config.jwt_secret)?;
    let storage = state.storage.as_ref().ok_or(AppError::StorageUnavailable)?;
    if body.len() > state.config.avatar_max_bytes {
        return Err(AppError::Auth(AuthError::InvalidInput(
            "avatar is too large",
        )));
    }
    let (content_type, ext) = sniff_image(&body).ok_or(AppError::Auth(AuthError::InvalidInput(
        "avatar must be a JPEG, PNG, WebP, or GIF image",
    )))?;

    let key = format!("avatars/{user_id}/{}.{}", Uuid::new_v4(), ext);
    storage
        .put(&key, &body, content_type)
        .await
        .map_err(AppError::StorageFailed)?;

    // Remember the previous key so its object can be cleaned up.
    let old: Option<Option<String>> =
        sqlx::query_scalar("SELECT avatar_key FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(&state.pool)
            .await?;
    let Some(old_key) = old else {
        // User vanished between auth and write: drop the orphan, fail closed.
        delete_best_effort(storage, &key).await;
        return Err(AppError::Auth(AuthError::Unauthorized));
    };
    sqlx::query("UPDATE users SET avatar_key = $1 WHERE id = $2")
        .bind(&key)
        .bind(user_id)
        .execute(&state.pool)
        .await?;
    if let Some(old_key) = old_key {
        delete_best_effort(storage, &old_key).await;
    }
    Ok(Json(AvatarView {
        avatar_url: storage.public_url(&key),
    }))
}

/// `DELETE /me/avatar` → always 200 (idempotent, like logout).
pub async fn delete_avatar(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    let user_id = authenticate(&headers, &state.config.jwt_secret)?;
    let storage = state.storage.as_ref().ok_or(AppError::StorageUnavailable)?;
    let old: Option<Option<String>> =
        sqlx::query_scalar("SELECT avatar_key FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(&state.pool)
            .await?;
    let Some(old_key) = old else {
        return Err(AppError::Auth(AuthError::Unauthorized));
    };
    sqlx::query("UPDATE users SET avatar_key = NULL WHERE id = $1")
        .bind(user_id)
        .execute(&state.pool)
        .await?;
    if let Some(old_key) = old_key {
        delete_best_effort(storage, &old_key).await;
    }
    Ok((StatusCode::OK, Json(serde_json::json!({ "ok": true }))))
}

/// Identify an image by magic bytes. Returns (content-type, extension).
fn sniff_image(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return Some(("image/jpeg", "jpg"));
    }
    if bytes.len() >= 8 && bytes[..8] == [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
        return Some(("image/png", "png"));
    }
    if bytes.len() >= 12 && bytes[..4] == *b"RIFF" && bytes[8..12] == *b"WEBP" {
        return Some(("image/webp", "webp"));
    }
    if bytes.len() >= 6 && (bytes[..6] == *b"GIF87a" || bytes[..6] == *b"GIF89a") {
        return Some(("image/gif", "gif"));
    }
    None
}

async fn delete_best_effort(storage: &Storage, key: &str) {
    if let Err(e) = storage.delete(key).await {
        tracing::warn!(key, error = %e, "orphaned avatar object");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_supported_images() {
        assert_eq!(
            sniff_image(&[0xFF, 0xD8, 0xFF, 0x00]),
            Some(("image/jpeg", "jpg"))
        );
        assert_eq!(
            sniff_image(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]),
            Some(("image/png", "png"))
        );
        assert_eq!(
            sniff_image(b"RIFF\x00\x00\x00\x00WEBP"),
            Some(("image/webp", "webp"))
        );
        assert_eq!(sniff_image(b"GIF89a..."), Some(("image/gif", "gif")));
        assert_eq!(sniff_image(b"not an image"), None);
        assert_eq!(sniff_image(&[]), None);
    }
}
