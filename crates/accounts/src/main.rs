//! `songnest-accounts` binary: load config, connect + migrate, serve.

use songnest_accounts::{AppState, config::Config, db, error::AppError};

#[tokio::main]
async fn main() -> Result<(), AppError> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "songnest_accounts=info".into()),
        )
        .init();

    let config = Config::from_env().map_err(|e| {
        tracing::error!(error = %e, "invalid configuration (see .env.example)");
        e
    })?;
    let pool = db::connect(&config.database_url).await?;
    songnest_accounts::run(AppState { pool, config }).await
}
