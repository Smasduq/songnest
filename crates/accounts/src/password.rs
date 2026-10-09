//! Password hashing (argon2id) and credential validation.
//!
//! Plaintext passwords never leave the request handler: they are hashed
//! here and the hash is what reaches the database. Nothing in this module
//! logs its inputs.

use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString, rand_core::OsRng},
};

/// Minimum accepted password length (checked server-side).
pub const MIN_PASSWORD_LEN: usize = 8;
/// Maximum accepted password length (DoS guard for hashing cost).
pub const MAX_PASSWORD_LEN: usize = 256;
/// Maximum email length (RFC 5321 path limit is 254).
pub const MAX_EMAIL_LEN: usize = 254;

/// Normalize an email for storage and lookup: trim + lowercase.
///
/// Note: full RFC email validation is out of scope; we reject only
/// clearly malformed input and rely on normalization for uniqueness.
pub fn normalize_email(raw: &str) -> String {
    raw.trim().to_lowercase()
}

/// Validate a normalized email. Returns a short, user-showable reason.
pub fn validate_email(email: &str) -> Result<(), &'static str> {
    if email.is_empty() || email.len() > MAX_EMAIL_LEN {
        return Err("enter a valid email address");
    }
    if email.contains(' ') {
        return Err("enter a valid email address");
    }
    let (local, domain) = email.split_once('@').ok_or("enter a valid email address")?;
    if local.is_empty() || domain.is_empty() || !domain.contains('.') {
        return Err("enter a valid email address");
    }
    Ok(())
}

/// Validate password length. Returns a short, user-showable reason.
pub fn validate_password(password: &str) -> Result<(), &'static str> {
    if password.len() < MIN_PASSWORD_LEN {
        return Err("password must be at least 8 characters");
    }
    if password.len() > MAX_PASSWORD_LEN {
        return Err("password is too long");
    }
    Ok(())
}

/// Hash with argon2id (default params) and a random salt.
pub fn hash_password(password: &str) -> Result<String, argon2::password_hash::Error> {
    let salt = SaltString::generate(&mut OsRng);
    Ok(Argon2::default()
        .hash_password(password.as_bytes(), &salt)?
        .to_string())
}

/// Verify against a stored PHC string. Mismatches and malformed hashes
/// both report `false` — callers must not distinguish them.
pub fn verify_password(password: &str, hash: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_trims_and_lowercases() {
        assert_eq!(normalize_email("  Alice@Example.COM "), "alice@example.com");
    }

    #[test]
    fn email_validation() {
        assert!(validate_email("a@b.co").is_ok());
        assert!(validate_email("no-at-sign").is_err());
        assert!(validate_email("a@nodot").is_err());
        assert!(validate_email("@b.co").is_err());
        assert!(validate_email("a@").is_err());
        assert!(validate_email("a @b.co").is_err());
        assert!(validate_email("").is_err());
    }

    #[test]
    fn password_policy() {
        assert!(validate_password("short").is_err());
        assert!(validate_password("long-enough-1").is_ok());
        assert!(validate_password(&"x".repeat(257)).is_err());
    }

    #[test]
    fn hash_verify_roundtrip() {
        let hash = hash_password("correct horse 1").expect("hash");
        assert!(hash.starts_with("$argon2id$"));
        assert!(verify_password("correct horse 1", &hash));
        assert!(!verify_password("wrong", &hash));
        assert!(!verify_password("correct horse 1", "not-a-hash"));
    }

    #[test]
    fn salts_differ() {
        let a = hash_password("same").expect("hash");
        let b = hash_password("same").expect("hash");
        assert_ne!(a, b);
    }
}
