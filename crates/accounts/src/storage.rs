//! Neon Object Storage client for user-uploaded files (profile pictures).
//!
//! The bucket holds the bytes; Postgres holds only the object key
//! (`users.avatar_key`), so files and rows branch together. Reads are
//! anonymous (`public_read` bucket, plain HTTPS URL); every write goes
//! through this authenticated client — browsers never see the credential.
//!
//! Writes use AWS Signature V4 over plain HTTPS (`reqwest`), hand-rolled
//! with the crates already in the tree (`hmac`, `sha2`). This keeps the
//! dependency footprint (and the MSRV) small: the official SDK needs a
//! newer Rust than the Vercel builder ships. Only `PutObject` and
//! `DeleteObject` are implemented — reads are unsigned public URLs.
//!
//! Env (injected by `neon deploy` / `neon env pull`):
//! `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`,
//! `AWS_REGION`. When any of key/secret/endpoint is missing, storage is
//! disabled (`None`) and avatar endpoints answer 503 — the rest of the
//! API keeps working (local dev without storage).

use chrono::Utc;

/// Authenticated Object Storage handle (cheap to clone).
#[derive(Debug, Clone)]
pub struct Storage {
    http: reqwest::Client,
    endpoint: String,
    bucket: String,
    access_key: String,
    secret_key: String,
    region: String,
}

impl Storage {
    /// Build from the standard `AWS_*` env vars, or `None` when storage
    /// is not configured. Never panics on missing/invalid values.
    pub fn from_env(bucket: &str) -> Option<Self> {
        let access_key = std::env::var("AWS_ACCESS_KEY_ID")
            .ok()
            .filter(|s| !s.trim().is_empty())?;
        let secret_key = std::env::var("AWS_SECRET_ACCESS_KEY")
            .ok()
            .filter(|s| !s.trim().is_empty())?;
        let endpoint = std::env::var("AWS_ENDPOINT_URL_S3")
            .ok()
            .filter(|s| !s.trim().is_empty())?;
        let region = std::env::var("AWS_REGION").unwrap_or_else(|_| "us-east-1".to_owned());
        Some(Self {
            http: reqwest::Client::new(),
            endpoint: endpoint.trim_end_matches('/').to_owned(),
            bucket: bucket.to_owned(),
            access_key,
            secret_key,
            region,
        })
    }

    /// Anonymous HTTPS URL for an object (bucket is `public_read`).
    /// Path-style addressing, like every other Neon storage access.
    pub fn public_url(&self, key: &str) -> String {
        format!(
            "{}/{}/{}",
            self.endpoint.trim_end_matches('/'),
            self.bucket,
            key
        )
    }

    /// Upload bytes under `key`, replacing any previous object.
    pub async fn put(&self, key: &str, bytes: &[u8], content_type: &str) -> Result<(), String> {
        let url = self.public_url(key);
        let res = self
            .signed("PUT", &url, key, bytes, content_type)?
            .send()
            .await
            .map_err(|e| format!("storage PUT failed: {e}"))?;
        if res.status().is_success() {
            return Ok(());
        }
        Err(format!(
            "storage PUT failed: HTTP {}: {}",
            res.status(),
            res.text()
                .await
                .unwrap_or_default()
                .chars()
                .take(300)
                .collect::<String>()
        ))
    }

    /// Delete `key`. Missing objects are fine (idempotent cleanup).
    pub async fn delete(&self, key: &str) -> Result<(), String> {
        let url = self.public_url(key);
        let res = self
            .signed("DELETE", &url, key, &[], "application/octet-stream")?
            .send()
            .await
            .map_err(|e| format!("storage DELETE failed: {e}"))?;
        if res.status().is_success() || res.status().as_u16() == 404 {
            return Ok(());
        }
        Err(format!(
            "storage DELETE failed: HTTP {}: {}",
            res.status(),
            res.text()
                .await
                .unwrap_or_default()
                .chars()
                .take(300)
                .collect::<String>()
        ))
    }

    /// Build a SigV4-signed request. `key` is the URL path remainder
    /// (`<bucket>/<key>`); our keys are URL-safe by construction.
    fn signed(
        &self,
        method: &str,
        url: &str,
        key: &str,
        body: &[u8],
        content_type: &str,
    ) -> Result<reqwest::RequestBuilder, String> {
        use hmac::{Hmac, Mac};
        use sha2::{Digest, Sha256};

        let now = Utc::now();
        let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
        let date_stamp = now.format("%Y%m%d").to_string();
        let payload_hash = hex::encode(Sha256::digest(body));
        let path = format!("/{}/{}", self.bucket, key);

        let canonical_headers = format!(
            "content-type:{content_type}\nhost:{}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n",
            host_of(&self.endpoint)?
        );
        let signed_headers = "content-type;host;x-amz-content-sha256;x-amz-date";
        let canonical_request =
            format!("{method}\n{path}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
        let scope = format!("{date_stamp}/{}/s3/aws4_request", self.region);
        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
            hex::encode(Sha256::digest(canonical_request.as_bytes()))
        );

        macro_rules! hmac_sha256 {
            ($key:expr, $data:expr) => {{
                let mut mac = Hmac::<Sha256>::new_from_slice($key)
                    .map_err(|_| "storage signing failed".to_owned())?;
                mac.update($data);
                mac.finalize().into_bytes()
            }};
        }
        let date_key = hmac_sha256!(
            format!("AWS4{}", self.secret_key).as_bytes(),
            date_stamp.as_bytes()
        );
        let region_key = hmac_sha256!(&date_key, self.region.as_bytes());
        let service_key = hmac_sha256!(&region_key, b"s3");
        let signing_key = hmac_sha256!(&service_key, b"aws4_request");
        let signature = hex::encode(hmac_sha256!(&signing_key, string_to_sign.as_bytes()));

        let auth = format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            self.access_key
        );
        Ok(self
            .http
            .request(
                reqwest::Method::from_bytes(method.as_bytes())
                    .map_err(|_| "bad method".to_owned())?,
                url,
            )
            .header("Content-Type", content_type)
            .header("Cache-Control", "public, max-age=86400")
            .header("x-amz-content-sha256", payload_hash)
            .header("x-amz-date", amz_date)
            .header("Authorization", auth)
            .body(body.to_vec()))
    }
}

/// Host (no scheme, no path) of an endpoint URL.
fn host_of(endpoint: &str) -> Result<&str, String> {
    let after_scheme = endpoint
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(endpoint);
    Ok(after_scheme.split('/').next().unwrap_or(after_scheme))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_url_is_path_style() {
        let s = Storage {
            http: reqwest::Client::new(),
            endpoint: "https://br-xyz.storage.neon.tech/".to_owned(),
            bucket: "songnest-bucket".to_owned(),
            access_key: String::new(),
            secret_key: String::new(),
            region: "us-east-1".to_owned(),
        };
        assert_eq!(
            s.public_url("avatars/u/k.png"),
            "https://br-xyz.storage.neon.tech/songnest-bucket/avatars/u/k.png"
        );
    }

    #[test]
    fn host_of_strips_scheme_and_path() {
        assert_eq!(
            host_of("https://br-xyz.storage.neon.tech/"),
            Ok("br-xyz.storage.neon.tech")
        );
        assert_eq!(host_of("http://127.0.0.1:9000"), Ok("127.0.0.1:9000"));
    }
}
