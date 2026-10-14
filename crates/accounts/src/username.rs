//! Public user handles.
//!
//! Rules: 3–30 ASCII characters (`a-z`, `0-9`, `_`, `.`, `-`), starting
//! and ending alphanumeric. Uniqueness is case-insensitive and forever —
//! the `usernames` table keeps history so released handles stay reserved.
//! A small reserved list blocks confusing/service names.

use uuid::Uuid;

use crate::db::Pool;

/// Handles that can never be claimed (case-insensitive).
const RESERVED: &[&str] = &[
    "admin",
    "administrator",
    "api",
    "help",
    "null",
    "root",
    "songnest",
    "support",
    "system",
    "undefined",
];

/// Validate a candidate handle. Returns the trimmed handle on success,
/// or a client-showable reason on failure.
pub fn validate_username(raw: &str) -> Result<String, &'static str> {
    let name = raw.trim();
    if name.len() < 3 || name.len() > 30 {
        return Err("username must be 3–30 characters");
    }
    let bytes = name.as_bytes();
    if !bytes
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'.' || *b == b'-')
    {
        return Err("username may only contain letters, numbers, _ . -");
    }
    let first = bytes[0];
    let last = bytes[bytes.len() - 1];
    if !first.is_ascii_alphanumeric() || !last.is_ascii_alphanumeric() {
        return Err("username must start and end with a letter or number");
    }
    if name.contains("..") {
        return Err("username may not contain consecutive dots");
    }
    if RESERVED.contains(&name.to_ascii_lowercase().as_str()) {
        return Err("username is reserved");
    }
    Ok(name.to_owned())
}

/// Current handle for a user, if any.
pub async fn current_username(
    pool: &Pool,
    user_id: Uuid,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT username FROM usernames WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
}

/// Best-effort claim of `candidate` for `user_id`: validates, skips when
/// the user already has a handle, ignores conflicts. Used to prefill a
/// handle from OAuth providers (e.g. GitHub login) — never fails the
/// login it runs inside.
pub async fn maybe_claim_username(pool: &Pool, user_id: Uuid, candidate: &str) {
    let Ok(name) = validate_username(candidate) else {
        return;
    };
    let current: Result<Option<String>, sqlx::Error> = sqlx::query_scalar(
        "SELECT username FROM usernames WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await;
    if !matches!(current, Ok(None)) {
        return;
    }
    let _ = sqlx::query("INSERT INTO usernames (id, user_id, username) VALUES ($1, $2, $3)")
        .bind(Uuid::new_v4())
        .bind(user_id)
        .bind(&name)
        .execute(pool)
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_normal_handles() {
        for name in ["smasduq", "SmasDuq", "user_1", "a.bc", "x-y-z12", "abc"] {
            assert!(validate_username(name).is_ok(), "{name}");
        }
        // Trimmed, casing preserved for display.
        assert_eq!(validate_username("  SmasDuq ").unwrap(), "SmasDuq");
    }

    #[test]
    fn rejects_bad_shapes() {
        for name in [
            "",
            "ab",
            "a",
            &"a".repeat(31),
            "-abc",
            "abc-",
            ".abc",
            "abc.",
            "_abc",
            "ab cd",
            "ab@cd",
            "héllo",
            "a..b",
        ] {
            assert!(validate_username(name).is_err(), "{name}");
        }
    }

    #[test]
    fn rejects_reserved() {
        for name in ["admin", "Admin", "ADMIN", "songnest", "Root", "support"] {
            assert_eq!(validate_username(name).unwrap_err(), "username is reserved");
        }
    }
}
