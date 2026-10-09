//! Liked-songs sync: last-write-wins per track with a monotonic cursor.
//!
//! Model: one row per `(user_id, track_id)` carrying `liked`, the device's
//! `updated_at`, and track metadata. `liked = false` rows are tombstones —
//! they are kept so unlikes propagate to offline devices. Every accepted
//! write takes the next value of the global `sync_version_seq`, so each
//! user's cursor (`max(version)`) advances monotonically.
//!
//! Conflict rule: the incoming change wins iff its `updated_at` is newer;
//! on equal timestamps a like beats an unlike (deterministic, documented).
//! Re-applying an identical change is a no-op (no version bump), which
//! makes batch uploads idempotent and safe to retry.
//!
//! The shape (`user_id`, opaque `track_id`, metadata columns) is chosen so
//! playlists can reuse the same pattern later; nothing playlist-specific
//! is built here.

use axum::{
    Json,
    extract::{Query, State},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{
    AppState,
    error::{AppError, AuthError},
    routes::auth::authenticate,
};

/// Page cap for pull responses (cursor pagination keeps memory bounded).
const PULL_LIMIT: i64 = 500;
/// Batch cap for push requests.
const PUSH_LIMIT: usize = 500;
/// Metadata field cap — likes stay small enough to list offline.
const META_CAP: usize = 500;
/// Track id cap.
const TRACK_ID_CAP: usize = 200;

/// One device-side change.
#[derive(Debug, Clone, Deserialize)]
pub struct LikeChange {
    pub track_id: String,
    pub liked: bool,
    pub updated_at: DateTime<Utc>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub cover: String,
}

/// A stored like row (what pulls return, plus per-row cursor).
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct LikeRecord {
    pub track_id: String,
    pub liked: bool,
    pub updated_at: DateTime<Utc>,
    pub version: i64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub cover: String,
}

#[derive(Debug, Deserialize)]
pub struct PullQuery {
    #[serde(default)]
    pub since: i64,
}

#[derive(Debug, Serialize)]
pub struct PullResponse {
    pub changes: Vec<LikeRecord>,
    pub cursor: i64,
}

#[derive(Debug, Deserialize)]
pub struct PushBody {
    pub changes: Vec<LikeChange>,
}

#[derive(Debug, Serialize)]
pub struct PushResponse {
    pub cursor: i64,
    pub applied: usize,
    pub skipped: usize,
}

/// `GET /sync/likes?since=<cursor>` → changes after the cursor
/// (including tombstones), oldest first, plus the new cursor.
pub async fn pull_likes(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<PullQuery>,
) -> Result<Json<PullResponse>, AppError> {
    let user_id = authenticate(&headers, &state.config.jwt_secret)?;
    let since = query.since.max(0);
    let changes: Vec<LikeRecord> = sqlx::query_as(
        "SELECT track_id, liked, updated_at, version, title, artist, album, cover
         FROM likes WHERE user_id = $1 AND version > $2
         ORDER BY version ASC LIMIT $3",
    )
    .bind(user_id)
    .bind(since)
    .bind(PULL_LIMIT)
    .fetch_all(&state.pool)
    .await?;
    let cursor = current_cursor(&state, user_id, since).await?;
    Ok(Json(PullResponse { changes, cursor }))
}

/// `POST /sync/likes` → apply a batch with last-write-wins.
/// Idempotent: replaying a batch changes nothing (cursor included).
pub async fn push_likes(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<PushBody>,
) -> Result<Json<PushResponse>, AppError> {
    let user_id = authenticate(&headers, &state.config.jwt_secret)?;
    if body.changes.len() > PUSH_LIMIT {
        return Err(AppError::Auth(AuthError::InvalidInput(
            "too many changes in one batch",
        )));
    }
    let mut applied = 0usize;
    let mut skipped = 0usize;
    for change in &body.changes {
        validate_change(change)?;
        if apply_change(&state, user_id, change).await? {
            applied += 1;
        } else {
            skipped += 1;
        }
    }
    let cursor = current_cursor(&state, user_id, 0).await?;
    Ok(Json(PushResponse {
        cursor,
        applied,
        skipped,
    }))
}

/// The caller's cursor: max row version, or `fallback` when no rows exist
/// (keeps a fresh account's cursor at whatever it asked with).
async fn current_cursor(
    state: &AppState,
    user_id: uuid::Uuid,
    fallback: i64,
) -> Result<i64, AppError> {
    let max: Option<i64> = sqlx::query_scalar("SELECT max(version) FROM likes WHERE user_id = $1")
        .bind(user_id)
        .fetch_one(&state.pool)
        .await?;
    Ok(max.unwrap_or(fallback))
}

fn validate_change(change: &LikeChange) -> Result<(), AppError> {
    let id = change.track_id.trim();
    if id.is_empty() || id.len() > TRACK_ID_CAP {
        return Err(AppError::Auth(AuthError::InvalidInput("bad track id")));
    }
    for field in [&change.title, &change.artist, &change.album, &change.cover] {
        if field.len() > META_CAP {
            return Err(AppError::Auth(AuthError::InvalidInput(
                "track metadata too long",
            )));
        }
    }
    Ok(())
}

/// Merge one incoming change against the stored row.
/// Returns true when a write happened (version advanced).
async fn apply_change(
    state: &AppState,
    user_id: uuid::Uuid,
    change: &LikeChange,
) -> Result<bool, AppError> {
    let stored: Option<LikeRecord> = sqlx::query_as(
        "SELECT track_id, liked, updated_at, version, title, artist, album, cover
         FROM likes WHERE user_id = $1 AND track_id = $2",
    )
    .bind(user_id)
    .bind(change.track_id.trim())
    .fetch_optional(&state.pool)
    .await?;

    match stored {
        None => {
            sqlx::query(
                "INSERT INTO likes
                 (user_id, track_id, liked, updated_at, version, title, artist, album, cover)
                 VALUES ($1, $2, $3, $4, nextval('sync_version_seq'), $5, $6, $7, $8)",
            )
            .bind(user_id)
            .bind(change.track_id.trim())
            .bind(change.liked)
            .bind(change.updated_at)
            .bind(change.title.trim())
            .bind(change.artist.trim())
            .bind(change.album.trim())
            .bind(change.cover.trim())
            .execute(&state.pool)
            .await?;
            Ok(true)
        }
        Some(existing) => {
            if !incoming_wins(&existing, change) {
                return Ok(false);
            }
            sqlx::query(
                "UPDATE likes SET liked = $3, updated_at = $4,
                 version = nextval('sync_version_seq'),
                 title = $5, artist = $6, album = $7, cover = $8
                 WHERE user_id = $1 AND track_id = $2",
            )
            .bind(user_id)
            .bind(change.track_id.trim())
            .bind(change.liked)
            .bind(change.updated_at)
            .bind(change.title.trim())
            .bind(change.artist.trim())
            .bind(change.album.trim())
            .bind(change.cover.trim())
            .execute(&state.pool)
            .await?;
            Ok(true)
        }
    }
}

/// Pure merge decision, unit-tested below without a database.
fn incoming_wins(stored: &LikeRecord, incoming: &LikeChange) -> bool {
    if incoming.updated_at != stored.updated_at {
        return incoming.updated_at > stored.updated_at;
    }
    // Equal timestamps: a like beats an unlike (deterministic tie-break);
    // metadata-only differences still apply; identical states are no-ops
    // so retried batches never bump the cursor.
    if incoming.liked != stored.liked {
        return incoming.liked;
    }
    metadata_differs(stored, incoming)
}

fn metadata_differs(stored: &LikeRecord, incoming: &LikeChange) -> bool {
    stored.title != incoming.title.trim()
        || stored.artist != incoming.artist.trim()
        || stored.album != incoming.album.trim()
        || stored.cover != incoming.cover.trim()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn record(liked: bool, secs: i64) -> LikeRecord {
        LikeRecord {
            track_id: "dz:123".to_owned(),
            liked,
            updated_at: Utc.timestamp_opt(secs, 0).unwrap(),
            version: 1,
            title: "T".to_owned(),
            artist: "A".to_owned(),
            album: String::new(),
            cover: String::new(),
        }
    }

    fn change(liked: bool, secs: i64) -> LikeChange {
        LikeChange {
            track_id: "dz:123".to_owned(),
            liked,
            updated_at: Utc.timestamp_opt(secs, 0).unwrap(),
            title: "T".to_owned(),
            artist: "A".to_owned(),
            album: String::new(),
            cover: String::new(),
        }
    }

    #[test]
    fn newer_wins_older_loses() {
        assert!(incoming_wins(&record(true, 100), &change(false, 200)));
        assert!(!incoming_wins(&record(true, 200), &change(false, 100)));
    }

    #[test]
    fn identical_replay_is_noop() {
        assert!(!incoming_wins(&record(true, 100), &change(true, 100)));
        assert!(!incoming_wins(&record(false, 100), &change(false, 100)));
    }

    #[test]
    fn equal_timestamps_like_beats_unlike() {
        assert!(incoming_wins(&record(false, 100), &change(true, 100)));
        assert!(!incoming_wins(&record(true, 100), &change(false, 100)));
    }

    #[test]
    fn metadata_refresh_applies() {
        let mut incoming = change(true, 100);
        incoming.title = "New Title".to_owned();
        assert!(incoming_wins(&record(true, 100), &incoming));
    }
}
