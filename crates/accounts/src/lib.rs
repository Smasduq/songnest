//! Songnest accounts and sync API.
//!
//! Handles ONLY user accounts (sign-up / sign-in / tokens) and liked-songs
//! sync. It never touches yt-dlp, audio, or the music library — that stays
//! in `songnest-server`.

pub mod config;
pub mod db;
pub mod error;
pub mod routes;

use axum::{Router, http::HeaderValue, routing::get};
use tower_http::cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;

use crate::config::Config;

/// Shared state for all handlers.
#[derive(Clone)]
pub struct AppState {
    pub pool: db::Pool,
    pub config: Config,
}

/// Build the router. Split from [`run`] so tests can mount it in-process.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(routes::health::health))
        .layer(RequestBodyLimitLayer::new(state.config.max_body_bytes))
        .layer(strict_cors(&state.config))
        .with_state(state)
}

/// Exact-match CORS: only configured origins, common API methods/headers.
/// Everything else (credentials, exposed headers, wildcards) stays off.
fn strict_cors(config: &Config) -> CorsLayer {
    let allowed: Vec<HeaderValue> = config
        .cors_origins
        .iter()
        .filter_map(|o| HeaderValue::from_str(o).ok())
        .collect();
    CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(move |origin: &HeaderValue, _| {
            allowed.iter().any(|a| a.as_bytes() == origin.as_bytes())
        }))
        .allow_methods(AllowMethods::mirror_request())
        .allow_headers(AllowHeaders::mirror_request())
}

/// Serve the API until killed.
pub async fn run(state: AppState) -> Result<(), error::AppError> {
    let app = router(state.clone());
    let listener = tokio::net::TcpListener::bind(state.config.bind).await?;
    tracing::info!("songnest-accounts listening on {}", state.config.bind);
    axum::serve(listener, app).await?;
    Ok(())
}
