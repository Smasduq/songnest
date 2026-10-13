//! GitHub App webhook receiver.

use axum::{
    Json,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;

use crate::AppState;

/// Verify GitHub's signature, acknowledge pings, and accept other events
/// without processing them yet.
pub async fn github_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, StatusCode> {
    let secret = state
        .config
        .github_webhook_secret
        .as_deref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let signature = headers
        .get("x-hub-signature-256")
        .and_then(|value| value.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;

    if !verify_signature(secret, &body, signature) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let event = headers
        .get("x-github-event")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .ok_or(StatusCode::BAD_REQUEST)?;

    if event == "ping" {
        Ok(Json(json!({ "message": "pong" })))
    } else {
        Ok(Json(json!({ "message": "event acknowledged" })))
    }
}

fn verify_signature(secret: &str, body: &[u8], signature: &str) -> bool {
    let Some(signature) = signature.strip_prefix("sha256=") else {
        return false;
    };
    let Ok(signature) = hex::decode(signature) else {
        return false;
    };
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(body);
    mac.verify_slice(&signature).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    use crate::{AppState, config::Config};

    const BODY: &[u8] = br#"{"zen":"Keep it logically awesome."}"#;

    fn state(secret: Option<&str>) -> AppState {
        AppState {
            pool: sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://songnest:test@127.0.0.1/songnest")
                .expect("valid test database URL"),
            config: Config {
                bind: "127.0.0.1:8788".parse().expect("test bind addr"),
                database_url: "postgres://songnest:test@127.0.0.1/songnest".to_owned(),
                jwt_secret: "test-secret-that-is-at-least-32-bytes!!".to_owned(),
                github_webhook_secret: secret.map(str::to_owned),
                access_ttl: Duration::from_secs(900),
                refresh_ttl: Duration::from_secs(3600),
                max_body_bytes: 1024 * 1024,
                cors_origins: Vec::new(),
                auth_per_minute: 10,
            },
        }
    }

    fn signed_headers(secret: &str, event: Option<&str>) -> HeaderMap {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("valid HMAC key");
        mac.update(BODY);
        let signature = format!("sha256={}", hex::encode(mac.finalize().into_bytes()));
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-hub-signature-256",
            signature.parse().expect("valid signature header"),
        );
        if let Some(event) = event {
            headers.insert("x-github-event", event.parse().expect("valid event header"));
        }
        headers
    }

    async fn send(secret: Option<&str>, headers: HeaderMap) -> Result<Json<Value>, StatusCode> {
        github_webhook(State(state(secret)), headers, Bytes::from_static(BODY)).await
    }

    #[test]
    fn verifies_github_signature_over_exact_body() {
        let secret = "test-webhook-secret";
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("valid HMAC key");
        mac.update(BODY);
        let signature = format!("sha256={}", hex::encode(mac.finalize().into_bytes()));

        assert!(verify_signature(secret, BODY, &signature));
        assert!(!verify_signature(
            secret,
            br#"{"zen":"changed"}"#,
            &signature
        ));
        assert!(!verify_signature(secret, BODY, "sha1=invalid"));
        assert!(!verify_signature(secret, BODY, "sha256=not-hex"));
    }

    #[tokio::test]
    async fn acknowledges_signed_ping_and_other_events() {
        let ping = send(
            Some("test-webhook-secret"),
            signed_headers("test-webhook-secret", Some("ping")),
        )
        .await
        .expect("valid ping");
        assert_eq!(ping.0, json!({ "message": "pong" }));

        let push = send(
            Some("test-webhook-secret"),
            signed_headers("test-webhook-secret", Some("push")),
        )
        .await
        .expect("valid event");
        assert_eq!(push.0, json!({ "message": "event acknowledged" }));
    }

    #[tokio::test]
    async fn rejects_unconfigured_or_invalid_webhook_requests() {
        let headers = signed_headers("test-webhook-secret", Some("ping"));
        assert_eq!(
            send(None, headers.clone()).await.unwrap_err(),
            StatusCode::SERVICE_UNAVAILABLE
        );

        let mut bad_signature = headers;
        bad_signature.insert(
            "x-hub-signature-256",
            "sha256=00".parse().expect("valid signature header"),
        );
        assert_eq!(
            send(Some("test-webhook-secret"), bad_signature)
                .await
                .unwrap_err(),
            StatusCode::UNAUTHORIZED
        );

        assert_eq!(
            send(
                Some("test-webhook-secret"),
                signed_headers("test-webhook-secret", None),
            )
            .await
            .unwrap_err(),
            StatusCode::BAD_REQUEST
        );
    }
}
