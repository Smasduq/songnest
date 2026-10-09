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
        jwt_secret: "test-secret-that-is-at-least-32-bytes!!".to_owned(),
        access_ttl: Duration::from_secs(900),
        refresh_ttl: Duration::from_secs(3600),
        max_body_bytes: 1024 * 1024,
        cors_origins: vec!["http://localhost:1420".to_owned()],
        auth_per_minute,
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
}

/// Boot the app against the test DB, or return `None` to skip.
async fn boot(auth_per_minute: u64) -> Option<(Client, Config)> {
    let url = std::env::var("TEST_DATABASE_URL").ok()?;
    let config = test_config(url.clone(), auth_per_minute);
    let pool = db::connect(&url).await.ok()?;
    let state = AppState {
        pool,
        config: config.clone(),
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
