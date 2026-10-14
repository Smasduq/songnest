use songnest_accounts::{AppState, config::Config, db, router, storage};
use tower::ServiceBuilder;
use vercel_runtime::{Error, axum::VercelLayer};

#[tokio::main]
async fn main() -> Result<(), Error> {
    let config = Config::from_env()?;
    let storage = storage::Storage::from_env(&config.avatars_bucket);
    let pool = db::connect_config(&config).await?;
    let app = ServiceBuilder::new()
        .layer(VercelLayer::new())
        .service(router(AppState {
            pool,
            config,
            storage,
        }));
    vercel_runtime::run(app).await
}
