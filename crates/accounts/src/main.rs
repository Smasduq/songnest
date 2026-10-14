//! `songnest-accounts` binary: load config, connect + migrate, serve.

use songnest_accounts::{AppState, config::Config, db, error::AppError, storage};

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
    let storage = storage::Storage::from_env(&config.avatars_bucket);
    if storage.is_none() {
        tracing::warn!(
            "avatar storage disabled: set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_ENDPOINT_URL_S3"
        );
    }
    let pool = db::connect_config(&config).await?;
    songnest_accounts::run(AppState {
        pool,
        config,
        storage,
    })
    .await
}
