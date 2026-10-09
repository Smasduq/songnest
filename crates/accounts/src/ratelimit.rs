//! Fixed-window per-IP rate limiting for the credential endpoints.
//!
//! A tiny in-house limiter (no extra dependencies): each client IP gets
//! `max_requests` tokens per `window`; excess requests get `429` with a
//! `Retry-After` hint. State is a mutex-guarded map pruned on each check,
//! which is plenty for auth-route volumes.
//!
//! NOTE: behind the Caddy reverse proxy the peer IP is loopback for all
//! clients. Per-user throttling is a TODO (see routes::auth).

use std::{
    collections::HashMap,
    future::Future,
    net::IpAddr,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::{Duration, Instant},
};

use axum::{
    body::Body,
    http::{Request, Response, StatusCode},
};
use tower::{Layer, Service};

/// Shared limiter state. Clone it into the layer.
#[derive(Debug, Clone)]
pub struct RateLimiter {
    inner: Arc<Mutex<LimiterState>>,
    max_requests: u32,
    window: Duration,
}

#[derive(Debug, Default)]
struct LimiterState {
    /// Hits per IP inside the current window.
    hits: HashMap<IpAddr, (u32, Instant)>,
}

impl RateLimiter {
    pub fn new(max_requests: u32, window: Duration) -> Self {
        Self {
            inner: Arc::new(Mutex::new(LimiterState::default())),
            max_requests: max_requests.max(1),
            window,
        }
    }

    /// True when the request may proceed (and records the hit).
    /// Lock poisoning degrades to "allow" — availability over strictness.
    fn allow(&self, ip: IpAddr) -> bool {
        let Ok(mut state) = self.inner.lock() else {
            return true;
        };
        let now = Instant::now();
        // Opportunistic prune: drop entries from older windows.
        state
            .hits
            .retain(|_, (_, seen)| now.duration_since(*seen) < self.window);
        let entry = state.hits.entry(ip).or_insert((0, now));
        if now.duration_since(entry.1) >= self.window {
            *entry = (0, now);
        }
        entry.0 += 1;
        entry.1 = now;
        entry.0 <= self.max_requests
    }
}

/// Tower layer applying [`RateLimiter`] by peer IP.
#[derive(Debug, Clone)]
pub struct RateLimitLayer {
    limiter: RateLimiter,
}

impl RateLimitLayer {
    pub fn new(max_requests: u32, window: Duration) -> Self {
        Self {
            limiter: RateLimiter::new(max_requests, window),
        }
    }
}

impl<S> Layer<S> for RateLimitLayer {
    type Service = RateLimitService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        RateLimitService {
            inner,
            limiter: self.limiter.clone(),
        }
    }
}

/// Tower service enforcing the limit. Requests without a peer IP
/// (in-process tests) share a placeholder address.
#[derive(Debug, Clone)]
pub struct RateLimitService<S> {
    inner: S,
    limiter: RateLimiter,
}

impl<S> Service<Request<Body>> for RateLimitService<S>
where
    S: Service<Request<Body>, Response = Response<Body>> + Clone + Send + 'static,
    S::Future: Send + 'static,
{
    type Response = Response<Body>;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Request<Body>) -> Self::Future {
        // `Clone` the inner service so the future owns it.
        let mut inner = self.inner.clone();
        std::mem::swap(&mut self.inner, &mut inner);
        let limiter = self.limiter.clone();
        // Peer IP comes from axum's ConnectInfo; tests have none.
        let ip = req
            .extensions()
            .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
            .map(|c| c.0.ip())
            .unwrap_or(IpAddr::from([127, 0, 0, 1]));
        Box::pin(async move {
            if !limiter.allow(ip) {
                let body = Body::from(r#"{"error":"too many attempts, try again later"}"#);
                return Ok(Response::builder()
                    .status(StatusCode::TOO_MANY_REQUESTS)
                    .header("content-type", "application/json")
                    .header("retry-after", "60")
                    .body(body)
                    .unwrap_or_else(|_| Response::new(Body::empty())));
            }
            inner.call(req).await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_window_allows_then_blocks() {
        let limiter = RateLimiter::new(3, Duration::from_secs(60));
        let ip = IpAddr::from([10, 0, 0, 1]);
        assert!(limiter.allow(ip));
        assert!(limiter.allow(ip));
        assert!(limiter.allow(ip));
        assert!(!limiter.allow(ip));
        // A different IP has its own budget.
        assert!(limiter.allow(IpAddr::from([10, 0, 0, 2])));
    }

    #[test]
    fn window_expiry_resets() {
        let limiter = RateLimiter::new(1, Duration::from_millis(50));
        let ip = IpAddr::from([10, 0, 0, 1]);
        assert!(limiter.allow(ip));
        assert!(!limiter.allow(ip));
        std::thread::sleep(Duration::from_millis(60));
        assert!(limiter.allow(ip));
    }
}
