//! Neon Object Storage client for user-uploaded files (profile pictures).
//!
//! The bucket holds the bytes; Postgres holds only the object key
//! (`users.avatar_key`), so files and rows branch together. Reads are
//! anonymous (`public_read` bucket, plain HTTPS URL); every write goes
//! through this authenticated client — browsers never see the credential.
//!
//! Env (injected by `neon deploy` / `neon env pull`):
//! `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`,
//! `AWS_REGION`. When any of key/secret/endpoint is missing, storage is
//! disabled (`None`) and avatar endpoints answer 503 — the rest of the
//! API keeps working (local dev without storage).

use aws_sdk_s3::{
    Client as S3Client,
    config::{BehaviorVersion, Builder as S3ConfigBuilder, Credentials, Region},
};

/// Authenticated Object Storage handle (cloneable pool of connections).
#[derive(Debug, Clone)]
pub struct Storage {
    client: S3Client,
    bucket: String,
    public_base: String,
}

impl Storage {
    /// Build from the standard `AWS_*` env vars, or `None` when storage
    /// is not configured. Never panics on missing/invalid values.
    pub fn from_env(bucket: &str) -> Option<Self> {
        let key = std::env::var("AWS_ACCESS_KEY_ID")
            .ok()
            .filter(|s| !s.trim().is_empty())?;
        let secret = std::env::var("AWS_SECRET_ACCESS_KEY")
            .ok()
            .filter(|s| !s.trim().is_empty())?;
        let endpoint = std::env::var("AWS_ENDPOINT_URL_S3")
            .ok()
            .filter(|s| !s.trim().is_empty())?;
        let region =
            std::env::var("AWS_REGION").unwrap_or_else(|_| "us-east-1".to_owned());
        let conf = S3ConfigBuilder::new()
            .behavior_version(BehaviorVersion::latest())
            .credentials_provider(Credentials::new(key, secret, None, None, "neon-storage"))
            .region(Region::new(region))
            .endpoint_url(endpoint.clone())
            // Required: Neon uses path-style addressing.
            .force_path_style(true)
            .build();
        Some(Self {
            client: S3Client::from_conf(conf),
            bucket: bucket.to_owned(),
            public_base: endpoint,
        })
    }

    /// Anonymous HTTPS URL for an object (bucket is `public_read`).
    pub fn public_url(&self, key: &str) -> String {
        format!(
            "{}/{}/{}",
            self.public_base.trim_end_matches('/'),
            self.bucket,
            key
        )
    }

    /// Upload bytes under `key`, replacing any previous object.
    pub async fn put(&self, key: &str, bytes: &[u8], content_type: &str) -> Result<(), String> {
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .body(bytes.to_vec().into())
            .content_type(content_type)
            .cache_control("public, max-age=86400")
            .send()
            .await
            .map(|_| ())
            .map_err(|e| format!("{e:?}"))
    }

    /// Delete `key`. Missing objects are fine (idempotent cleanup).
    pub async fn delete(&self, key: &str) -> Result<(), String> {
        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .map(|_| ())
            .map_err(|e| format!("{e:?}"))
    }
}
