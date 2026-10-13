//! Database access. All SQL lives behind these helpers so the rest of
//! the crate never touches `sqlx` directly — this is the seam where a
//! different backend (e.g. SQLite) could be substituted. Queries use
//! portable syntax (`$N` params aside) and avoid Postgres-only features.
//!
//! Neon wiring (see `.agents/skills/neon-postgres`):
//! - App traffic uses the pooled `DATABASE_URL` (`-pooler` hostname).
//!   PgBouncer runs in transaction mode, which does not support prepared
//!   statements, so the pool disables the sqlx statement cache for pooled
//!   URLs (`statement_cache_capacity(0)`).
//! - Schema migrations use the direct `DATABASE_URL_UNPOOLED` URL when set,
//!   falling back to `DATABASE_URL` for local single-DB setups.

use std::str::FromStr as _;

/// Connection pool handle shared by handlers.
pub type Pool = sqlx::PgPool;

/// Connect and run pending migrations.
///
/// Prefer [`connect_config`] in binaries so migrations automatically use
/// `DATABASE_URL_UNPOOLED` when available. This wrapper keeps the
/// single-URL form for tests and callers without a full [`crate::config::Config`].
pub async fn connect(database_url: &str) -> Result<Pool, sqlx::Error> {
    connect_with_urls(database_url, None).await
}

/// Connect using a full [`crate::config::Config`]: pooled URL for the app
/// pool, direct URL for migrations.
pub async fn connect_config(config: &crate::config::Config) -> Result<Pool, sqlx::Error> {
    connect_with_urls(
        &config.database_url,
        config.database_url_unpooled.as_deref(),
    )
    .await
}

/// Core connect: `app_url` serves traffic, `migrate_url` (or `app_url` when
/// `None`) runs `sqlx::migrate!` first.
pub async fn connect_with_urls(
    app_url: &str,
    migrate_url: Option<&str>,
) -> Result<Pool, sqlx::Error> {
    let migrate_url = migrate_url.unwrap_or(app_url);
    // Migrations need session-level guarantees: always run them over the
    // direct connection, never through PgBouncer.
    let migrate_options = sqlx::postgres::PgConnectOptions::from_str(migrate_url)?;
    let migrate_pool = sqlx::postgres::PgPoolOptions::new()
        .connect_with(migrate_options)
        .await?;
    sqlx::migrate!("./migrations").run(&migrate_pool).await?;
    migrate_pool.close().await;

    // App pool: disable prepared-statement caching when talking to Neon's
    // transaction-mode pooler (hostname contains `-pooler`).
    let mut app_options = sqlx::postgres::PgConnectOptions::from_str(app_url)?;
    if app_url.contains("-pooler") {
        app_options = app_options.statement_cache_capacity(0);
    }
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_with(app_options)
        .await?;
    Ok(pool)
}
