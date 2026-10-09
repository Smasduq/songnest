//! Tokens: short-lived JWT access tokens + opaque rotating refresh tokens.
//!
//! Refresh tokens are random 256-bit values. Only their SHA-256 hash is
//! stored; the raw value is shown to the client once. Raw tokens and
//! secrets are never logged.

use std::time::Duration;

use chrono::Utc;
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation, decode, encode};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{AppError, AuthError};

/// JWT claims for access tokens. Minimal: subject + expiry.
#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: Uuid,
    exp: i64,
}

/// A successfully verified access token.
#[derive(Debug)]
pub struct AccessToken {
    pub user_id: Uuid,
}

/// Mint a short-lived access-token JWT for `user_id`.
pub fn mint_access(secret: &str, user_id: Uuid, ttl: Duration) -> Result<String, AppError> {
    let exp = Utc::now() + ttl;
    let claims = Claims {
        sub: user_id,
        exp: exp.timestamp(),
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|_| AppError::Auth(AuthError::Token))
}

/// Verify a presented access token. Every failure maps to the same error.
pub fn verify_access(secret: &str, token: &str) -> Result<AccessToken, AppError> {
    let mut validation = Validation::default();
    validation.validate_exp = true;
    validation.leeway = 0;
    validation.required_spec_claims.insert("exp".to_owned());
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map_err(|_| AppError::Auth(AuthError::Unauthorized))?;
    Ok(AccessToken {
        user_id: data.claims.sub,
    })
}

/// Generate a fresh opaque refresh token (base64url, 256 bits).
pub fn generate_refresh() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64_url(&bytes)
}

/// Hash a refresh token for storage/lookup. SHA-256 (not password hashing:
/// the token already has 256 bits of entropy; this keeps lookups cheap).
pub fn hash_refresh(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    hex::encode(digest)
}

fn base64_url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len() * 4 / 3 + 4);
    let (chunks, rem) = bytes.as_chunks::<3>();
    for c in chunks {
        let n = u32::from_be_bytes([0, c[0], c[1], c[2]]);
        for shift in [18, 12, 6, 0] {
            out.push(ALPHABET[((n >> shift) & 63) as usize] as char);
        }
    }
    if !rem.is_empty() {
        let mut buf = [0u8; 3];
        buf[..rem.len()].copy_from_slice(rem);
        let n = u32::from_be_bytes([0, buf[0], buf[1], buf[2]]);
        for shift in [18, 12] {
            out.push(ALPHABET[((n >> shift) & 63) as usize] as char);
        }
        if rem.len() == 2 {
            out.push(ALPHABET[((n >> 6) & 63) as usize] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "test-secret-that-is-long-enough-for-hs256";

    #[test]
    fn access_roundtrip() {
        let id = Uuid::now_v7();
        let token = mint_access(SECRET, id, Duration::from_secs(60)).expect("mint");
        let got = verify_access(SECRET, &token).expect("verify");
        assert_eq!(got.user_id, id);
    }

    #[test]
    fn wrong_secret_rejected() {
        let id = Uuid::now_v7();
        let token = mint_access(SECRET, id, Duration::from_secs(60)).expect("mint");
        assert!(verify_access("another-secret-value-here-xyz", &token).is_err());
    }

    #[test]
    fn expired_rejected() {
        let id = Uuid::now_v7();
        let token = mint_access(SECRET, id, Duration::from_secs(0)).expect("mint");
        // exp == now fails once a second ticks over; force the past instead.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        assert!(verify_access(SECRET, &token).is_err());
    }

    #[test]
    fn garbage_rejected() {
        assert!(verify_access(SECRET, "not.a.token").is_err());
        assert!(verify_access(SECRET, "").is_err());
    }

    #[test]
    fn refresh_hash_stable_and_hiding() {
        let t = generate_refresh();
        assert_eq!(hash_refresh(&t), hash_refresh(&t));
        assert_ne!(hash_refresh(&t), hash_refresh(&generate_refresh()));
        assert!(!hash_refresh(&t).contains(&t[..8]));
    }
}
