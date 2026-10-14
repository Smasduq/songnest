//! End-to-end API tests: signup → login → like on A → fetch on B →
//! unlike → fetch tombstone. Plus rate-limit enforcement.
//!
//! Requires a live Postgres: set `TEST_DATABASE_URL` (a scratch database;
//! tests create uniquely-named users, but run migrations against it).
//! Without it the tests print a note and pass trivially so that plain
//! `cargo test` stays green everywhere:
//!
//! ```sh
//! createdb songnest_test
//! TEST_DATABASE_URL=postgres://songnest:pw@127.0.0.1:5432/songnest_test \
//!   cargo test -p songnest-accounts --test api
//! ```

use std::time::Duration;

use serde_json::{Value, json};
use songnest_accounts::{AppState, config::Config, db, router};

fn test_config(database_url: String, auth_per_minute: u64) -> Config {
    Config {
        bind: "127.0.0.1:0".parse().expect("test bind addr"),
        database_url,
        database_url_unpooled: std::env::var("TEST_DATABASE_URL_UNPOOLED").ok(),
        jwt_secret: "test-secret-that-is-at-least-32-bytes!!".to_owned(),
        github_webhook_secret: Some("test-webhook-secret".to_owned()),
        github_client_id: None,
        github_client_secret: None,
        google_client_id: None,
        google_client_secret: None,
        access_ttl: Duration::from_secs(900),
        refresh_ttl: Duration::from_secs(3600),
        max_body_bytes: 1024 * 1024,
        cors_origins: vec!["http://localhost:1420".to_owned()],
        auth_per_minute,
        avatars_bucket: std::env::var("SONGNEST_AVATARS_BUCKET")
            .unwrap_or_else(|_| "songnest-bucket".to_owned()),
        avatar_max_bytes: 512 * 1024,
    }
}

struct Client {
    http: reqwest::Client,
    base: String,
}

impl Client {
    async fn post(&self, path: &str, body: &Value) -> (u16, Value) {
        let res = self
            .http
            .post(format!("{}{path}", self.base))
            .json(body)
            .send()
            .await
            .expect("request");
        let status = res.status().as_u16();
        let json: Value = res.json().await.unwrap_or(Value::Null);
        (status, json)
    }

    async fn get(&self, path: &str, token: &str) -> (u16, Value) {
        let res = self
            .http
            .get(format!("{}{path}", self.base))
            .bearer_auth(token)
            .send()
            .await
            .expect("request");
        let status = res.status().as_u16();
        let json: Value = res.json().await.unwrap_or(Value::Null);
        (status, json)
    }

    async fn post_authed(&self, path: &str, token: &str, body: &Value) -> (u16, Value) {
        let res = self
            .http
            .post(format!("{}{path}", self.base))
            .bearer_auth(token)
            .json(body)
            .send()
            .await
            .expect("request");
        let status = res.status().as_u16();
        let json: Value = res.json().await.unwrap_or(Value::Null);
        (status, json)
    }

    async fn put_bytes(
        &self,
        path: &str,
        token: Option<&str>,
        content_type: &str,
        bytes: Vec<u8>,
    ) -> (u16, Value) {
        let mut req = self
            .http
            .put(format!("{}{path}", self.base))
            .header("Content-Type", content_type)
            .body(bytes);
        if let Some(token) = token {
            req = req.bearer_auth(token);
        }
        let res = req.send().await.expect("request");
        let status = res.status().as_u16();
        let json: Value = res.json().await.unwrap_or(Value::Null);
        (status, json)
    }

    async fn delete_authed(&self, path: &str, token: &str) -> (u16, Value) {
        let res = self
            .http
            .delete(format!("{}{path}", self.base))
            .bearer_auth(token)
            .send()
            .await
            .expect("request");
        let status = res.status().as_u16();
        let json: Value = res.json().await.unwrap_or(Value::Null);
        (status, json)
    }

    async fn put_authed(&self, path: &str, token: &str, body: &Value) -> (u16, Value) {
        let res = self
            .http
            .put(format!("{}{path}", self.base))
            .bearer_auth(token)
            .json(body)
            .send()
            .await
            .expect("request");
        let status = res.status().as_u16();
        let json: Value = res.json().await.unwrap_or(Value::Null);
        (status, json)
    }
}

/// Boot the app against the test DB, or return `None` to skip.
async fn boot(auth_per_minute: u64) -> Option<(Client, Config)> {
    let url = std::env::var("TEST_DATABASE_URL").ok()?;
    let config = test_config(url.clone(), auth_per_minute);
    let pool = db::connect_config(&config).await.ok()?;
    let storage = songnest_accounts::storage::Storage::from_env(&config.avatars_bucket);
    let state = AppState {
        pool,
        config: config.clone(),
        storage,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.ok()?;
    let addr = listener.local_addr().ok()?;
    tokio::spawn(async move {
        let _ = axum::serve(listener, router(state).into_make_service()).await;
    });
    Some((
        Client {
            http: reqwest::Client::new(),
            base: format!("http://{addr}"),
        },
        config,
    ))
}

fn unique_email(tag: &str) -> String {
    format!("{tag}-{}@example.com", uuid::Uuid::new_v4())
}

#[tokio::test]
async fn signup_login_like_unlike_sync_flow() {
    let Some((client, _)) = boot(1000).await else {
        eprintln!("SKIPPED: set TEST_DATABASE_URL to run live-DB tests");
        return;
    };
    let email = unique_email("flow");

    // Signup → 201 with a token pair.
    let (status, signup) = client
        .post(
            "/auth/signup",
            &json!({"email": email, "password": "password-123"}),
        )
        .await;
    assert_eq!(status, 201, "{signup}");
    let access = signup["access_token"].as_str().expect("access token");
    assert!(!signup["refresh_token"].as_str().unwrap_or("").is_empty());

    // Duplicate signup → generic 400 that hides existence.
    let (status, dup) = client
        .post(
            "/auth/signup",
            &json!({"email": email, "password": "password-123"}),
        )
        .await;
    assert_eq!(status, 400, "{dup}");
    assert_eq!(dup["error"], "could not create account");

    // Wrong password → generic 401 (same as unknown email).
    let (status, bad) = client
        .post(
            "/auth/login",
            &json!({"email": email, "password": "nope-nope-nope"}),
        )
        .await;
    assert_eq!(status, 401, "{bad}");

    // Login → /me round-trips the profile.
    let (status, login) = client
        .post(
            "/auth/login",
            &json!({"email": email, "password": "password-123"}),
        )
        .await;
    assert_eq!(status, 200, "{login}");
    let device_b = login["access_token"].as_str().expect("token").to_owned();
    let (status, me) = client.get("/me", &device_b).await;
    assert_eq!(status, 200, "{me}");
    assert_eq!(me["email"], email);

    // Device A likes a track.
    let like = json!({"changes": [{
        "track_id": "dz:555",
        "liked": true,
        "updated_at": "2026-01-01T00:00:00Z",
        "title": "Test Song",
        "artist": "Test Artist",
        "album": "Test Album",
        "cover": "https://example.com/cover.jpg",
    }]});
    let (status, pushed) = client.post_authed("/sync/likes", access, &like).await;
    assert_eq!(status, 200, "{pushed}");
    assert_eq!(pushed["applied"], 1);
    let cursor1 = pushed["cursor"].as_i64().expect("cursor");
    assert!(cursor1 > 0);

    // Device B pulls from scratch → sees the like with metadata.
    let (status, pulled) = client.get("/sync/likes?since=0", &device_b).await;
    assert_eq!(status, 200, "{pulled}");
    assert_eq!(pulled["cursor"], cursor1);
    let changes = pulled["changes"].as_array().expect("changes");
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0]["track_id"], "dz:555");
    assert_eq!(changes[0]["liked"], true);
    assert_eq!(changes[0]["title"], "Test Song");

    // Replaying the same batch is a no-op: cursor does not move.
    let (status, replay) = client.post_authed("/sync/likes", access, &like).await;
    assert_eq!(status, 200, "{replay}");
    assert_eq!(replay["applied"], 0);
    assert_eq!(replay["cursor"], cursor1);

    // Device B unlikes with a newer timestamp → tombstone.
    let unlike = json!({"changes": [{
        "track_id": "dz:555",
        "liked": false,
        "updated_at": "2026-01-02T00:00:00Z",
        "title": "Test Song",
        "artist": "Test Artist",
    }]});
    let (status, unpushed) = client.post_authed("/sync/likes", &device_b, &unlike).await;
    assert_eq!(status, 200, "{unpushed}");
    let cursor2 = unpushed["cursor"].as_i64().expect("cursor");
    assert!(cursor2 > cursor1);

    // Device A pulls with the old cursor → sees only the tombstone.
    let (status, pulled2) = client
        .get(&format!("/sync/likes?since={cursor1}"), access)
        .await;
    assert_eq!(status, 200, "{pulled2}");
    assert_eq!(pulled2["cursor"], cursor2);
    let changes2 = pulled2["changes"].as_array().expect("changes");
    assert_eq!(changes2.len(), 1);
    assert_eq!(changes2[0]["track_id"], "dz:555");
    assert_eq!(changes2[0]["liked"], false);

    // Stale writes lose: an older like does not resurrect the tombstone.
    let (status, stale) = client.post_authed("/sync/likes", access, &like).await;
    assert_eq!(status, 200, "{stale}");
    assert_eq!(stale["applied"], 0);
    assert_eq!(stale["cursor"], cursor2);

    // Logout revokes the refresh token; reuse fails generically.
    let refresh = signup["refresh_token"].as_str().expect("refresh");
    let (status, _) = client
        .post("/auth/logout", &json!({"refresh_token": refresh}))
        .await;
    assert_eq!(status, 200);
    let (status, again) = client
        .post("/auth/refresh", &json!({"refresh_token": refresh}))
        .await;
    assert_eq!(status, 401, "{again}");
}

#[tokio::test]
async fn username_set_change_history_flow() {
    let Some((client, _)) = boot(1000).await else {
        eprintln!("SKIPPED: set TEST_DATABASE_URL to run live-DB tests");
        return;
    };
    let (status, signup) = client
        .post(
            "/auth/signup",
            &json!({"email": unique_email("handle"), "password": "password-123"}),
        )
        .await;
    assert_eq!(status, 201, "{signup}");
    let access = signup["access_token"].as_str().expect("access token");
    assert!(signup["user"]["username"].is_null());

    // Invalid shapes are rejected with a showable message.
    for bad in [
        "ab",
        "a".repeat(31).as_str(),
        "-lead",
        "trail-",
        "has space",
        "admin",
    ] {
        let (status, _) = client
            .put_authed("/me/username", access, &json!({"username": bad}))
            .await;
        assert_eq!(status, 400, "{bad}");
    }

    // Set → visible via /me.
    let (status, first) = client
        .put_authed("/me/username", access, &json!({"username": "SmasDuq"}))
        .await;
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["username"], "SmasDuq");
    let (status, me) = client.get("/me", access).await;
    assert_eq!(status, 200, "{me}");
    assert_eq!(me["username"], "SmasDuq");

    // Change → new current; old name stays reserved (case-insensitive).
    let (status, second) = client
        .put_authed("/me/username", access, &json!({"username": "smasduq2"}))
        .await;
    assert_eq!(status, 200, "{second}");
    assert_eq!(second["username"], "smasduq2");

    let email2 = unique_email("handle2");
    let (status, signup2) = client
        .post(
            "/auth/signup",
            &json!({"email": email2, "password": "password-123"}),
        )
        .await;
    assert_eq!(status, 201, "{signup2}");
    let access2 = signup2["access_token"].as_str().expect("access token");
    for taken in ["smasduq", "SMASDUQ", "smasduq2"] {
        let (status, dup) = client
            .put_authed("/me/username", access2, &json!({"username": taken}))
            .await;
        assert_eq!(status, 400, "{dup}");
        assert_eq!(dup["error"], "username is taken");
    }

    // Unauthenticated writes are rejected.
    let res = client
        .http
        .put(format!("{}/me/username", client.base))
        .json(&json!({"username": "nobody"}))
        .send()
        .await
        .expect("request");
    assert_eq!(res.status().as_u16(), 401);
}

#[tokio::test]
async fn email_change_flow() {
    let Some((client, _)) = boot(1000).await else {
        eprintln!("SKIPPED: set TEST_DATABASE_URL to run live-DB tests");
        return;
    };
    let (status, signup) = client
        .post(
            "/auth/signup",
            &json!({"email": unique_email("chg"), "password": "password-123"}),
        )
        .await;
    assert_eq!(status, 201, "{signup}");
    let access = signup["access_token"].as_str().expect("access token");

    // Invalid and taken addresses fail showably.
    let (status, bad) = client
        .put_authed("/me/email", access, &json!({"email": "not-an-email"}))
        .await;
    assert_eq!(status, 400, "{bad}");

    let other = unique_email("other");
    let (status, _) = client
        .post(
            "/auth/signup",
            &json!({"email": other, "password": "password-123"}),
        )
        .await;
    assert_eq!(status, 201);
    let (status, taken) = client
        .put_authed("/me/email", access, &json!({"email": other}))
        .await;
    assert_eq!(status, 400, "{taken}");
    assert_eq!(taken["error"], "email is already in use");

    // Change → visible via /me, and password login follows the new email.
    let fresh = unique_email("fresh");
    let (status, changed) = client
        .put_authed("/me/email", access, &json!({"email": fresh}))
        .await;
    assert_eq!(status, 200, "{changed}");
    assert_eq!(changed["email"], fresh);
    let (status, login) = client
        .post(
            "/auth/login",
            &json!({"email": fresh, "password": "password-123"}),
        )
        .await;
    assert_eq!(status, 200, "{login}");
}

#[tokio::test]
async fn auth_endpoints_are_rate_limited() {
    let Some((client, _)) = boot(3).await else {
        eprintln!("SKIPPED: set TEST_DATABASE_URL to run live-DB tests");
        return;
    };
    let mut limited = false;
    for i in 0..8 {
        let (status, _) = client
            .post(
                "/auth/signup",
                &json!({"email": unique_email(&format!("rl{i}")), "password": "password-123"}),
            )
            .await;
        if status == 429 {
            limited = true;
            break;
        }
    }
    assert!(
        limited,
        "expected a 429 within 8 rapid signups at limit 3/min"
    );
}

/// Minimal PNG (magic bytes + filler — the API sniffs magic, it does not
/// decode images) and an obvious non-image.
fn png_bytes() -> Vec<u8> {
    let mut v = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    v.extend_from_slice(&[0u8; 64]);
    v
}

fn gif_bytes() -> Vec<u8> {
    let mut v = b"GIF89a".to_vec();
    v.extend_from_slice(&[0u8; 64]);
    v
}

#[tokio::test]
async fn avatar_upload_view_replace_delete_flow() {
    let Some((client, _)) = boot(1000).await else {
        eprintln!("SKIPPED: set TEST_DATABASE_URL to run live-DB tests");
        return;
    };
    let email = unique_email("avatar");

    let (status, signup) = client
        .post(
            "/auth/signup",
            &json!({"email": email, "password": "password-123"}),
        )
        .await;
    assert_eq!(status, 201, "{signup}");
    let access = signup["access_token"].as_str().expect("access token");

    // Without storage configured the endpoints answer 503 — skip, don't fail.
    let (status, first) = client
        .put_bytes("/me/avatar", Some(access), "image/png", png_bytes())
        .await;
    if status == 503 {
        eprintln!("SKIPPED: avatar storage not configured (AWS_* unset)");
        return;
    }
    assert_eq!(status, 200, "{first}");
    let url1 = first["avatar_url"].as_str().expect("avatar_url");
    assert!(url1.contains("avatars/"), "{url1}");

    // Unauthenticated uploads are rejected.
    let (status, _) = client
        .put_bytes("/me/avatar", None, "image/png", png_bytes())
        .await;
    assert_eq!(status, 401);

    // Non-images are rejected with a showable 400.
    let (status, bad) = client
        .put_bytes("/me/avatar", Some(access), "text/plain", b"hello".to_vec())
        .await;
    assert_eq!(status, 400, "{bad}");

    // /me exposes the picture.
    let (status, me) = client.get("/me", access).await;
    assert_eq!(status, 200, "{me}");
    assert_eq!(me["avatar_url"], url1);

    // Replacing yields a fresh cache-busting URL…
    let (status, second) = client
        .put_bytes("/me/avatar", Some(access), "image/gif", gif_bytes())
        .await;
    assert_eq!(status, 200, "{second}");
    let url2 = second["avatar_url"].as_str().expect("avatar_url");
    assert_ne!(url1, url2);

    // …and deleting clears it.
    let (status, _) = client.delete_authed("/me/avatar", access).await;
    assert_eq!(status, 200);
    let (status, me) = client.get("/me", access).await;
    assert_eq!(status, 200, "{me}");
    assert!(me["avatar_url"].is_null(), "{me}");
}
