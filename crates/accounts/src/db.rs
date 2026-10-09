//! Database access. All SQL lives behind these helpers so the rest of
//! the crate never touches `sqlx` directly — this is the seam where a
//! different backend (e.g. SQLite) could be substituted. Queries use
//! portable syntax (`$N` params aside) and avoid Postgres-only features.

/// Connection pool handle shared by handlers.
pub type Pool = sqlx::PgPool;

/// Connect and run pending migrations.
pub async fn connect(database_url: &str) -> Result<Pool, sqlx::Error> {
    let pool = sqlx::PgPool::connect(database_url).await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}
