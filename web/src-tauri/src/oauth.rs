//! OAuth loopback callback server for native builds (Tauri desktop + mobile).
//!
//! Google's "Desktop"-type OAuth clients only accept loopback redirect
//! URIs (`http://127.0.0.1:<port>/…`), and the webview origins of Tauri
//! bundles (`tauri://localhost`, `http://tauri.localhost`) are rejected
//! by Google *and* unreachable from the system browser — so the normal
//! redirect flow cannot work in the app. Instead the frontend:
//!
//! 1. calls `oauth_loopback_begin` → gets a free loopback port,
//! 2. asks the accounts API for an authorize URL with
//!    `redirect_uri=http://127.0.0.1:<port>/callback`,
//! 3. opens that URL in the system browser (Google blocks webviews),
//! 4. awaits `oauth_loopback_wait`, which resolves when Google redirects
//!    the browser to the loopback address with `?code=…&state=…`.
//!
//! The browser landing page tells the user to return to Songnest. Only
//! loopback is ever bound — nothing is exposed to the LAN.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Overall budget for one login attempt (frontend waits slightly less).
const LISTEN_BUDGET_SECS: u64 = 320;
/// Max HTTP request head we will read (the callback is a short GET).
const MAX_HEAD_BYTES: usize = 16 * 1024;

/// One-shot receiver for the pending login, if any.
pub type OAuthSlot = Mutex<Option<tokio::sync::oneshot::Receiver<OAuthCallback>>>;

#[derive(Debug, Clone, Serialize)]
pub struct OAuthCallback {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

/// Bind a loopback listener for one OAuth callback. Returns the port.
/// Any previous pending login is discarded.
#[tauri::command]
pub async fn oauth_loopback_begin(
    slot: tauri::State<'_, OAuthSlot>,
) -> Result<u16, String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Couldn't start login on this device ({e})"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Couldn't start login on this device ({e})"))?
        .port();
    let (tx, rx) = tokio::sync::oneshot::channel();
    *slot.lock().map_err(|_| "Login is busy — try again.".to_owned())? = Some(rx);
    tauri::async_runtime::spawn(serve_one(listener, tx));
    Ok(port)
}

/// Wait for the provider callback. Resolves with the code (or provider
/// error); times out so an abandoned browser tab cannot hang login.
#[tauri::command]
pub async fn oauth_loopback_wait(
    slot: tauri::State<'_, OAuthSlot>,
    timeout_secs: Option<u64>,
) -> Result<OAuthCallback, String> {
    let rx = slot
        .lock()
        .map_err(|_| "Login is busy — try again.".to_owned())?
        .take()
        .ok_or_else(|| "Login wasn't started — try again.".to_owned())?;
    let budget = Duration::from_secs(timeout_secs.unwrap_or(300).clamp(10, 600));
    tokio::time::timeout(budget, rx)
        .await
        .map_err(|_| "Login timed out — try again.".to_owned())?
        .map_err(|_| "Login was interrupted — try again.".to_owned())
}

async fn serve_one(
    listener: tokio::net::TcpListener,
    tx: tokio::sync::oneshot::Sender<OAuthCallback>,
) {
    let outcome = tokio::time::timeout(Duration::from_secs(LISTEN_BUDGET_SECS), async {
        loop {
            let (stream, _) = listener.accept().await.map_err(|_| ())?;
            match read_callback(stream).await {
                // Valid callback (code or provider error): answer and stop.
                Ok(Some(result)) => return Ok::<OAuthCallback, ()>(result),
                // Valid HTTP hit for some other path: answer 404, keep waiting.
                Ok(None) => {}
                // Malformed/failed connection: ignore, keep waiting.
                Err(()) => {}
            }
        }
    })
    .await;
    let result = match outcome {
        Ok(Ok(result)) => result,
        _ => OAuthCallback {
            code: None,
            state: None,
            error: Some("access_denied".to_owned()),
        },
    };
    let _ = tx.send(result);
}

/// Read one connection. Returns `Ok(Some(cb))` for a `/callback` hit
/// (after replying), `Ok(None)` for other paths (after a 404 reply),
/// `Err(())` for anything unreadable.
async fn read_callback(
    mut stream: tokio::net::TcpStream,
) -> Result<Option<OAuthCallback>, ()> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let n = stream.read(&mut chunk).await.map_err(|_| ())?;
        if n == 0 {
            return Err(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > MAX_HEAD_BYTES {
            return Err(());
        }
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let head = String::from_utf8_lossy(&buf);
    let request_line = head.lines().next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    if parts.next() != Some("GET") {
        return Err(());
    }
    let target = parts.next().unwrap_or("/");
    let (path, query) = match target.find('?') {
        Some(i) => (&target[..i], &target[i + 1..]),
        None => (target, ""),
    };
    if path != "/callback" {
        respond(&mut stream, 404, "Not found.").await;
        return Ok(None);
    }
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for pair in query.split('&') {
        let (k, v) = match pair.find('=') {
            Some(i) => (&pair[..i], &pair[i + 1..]),
            None => continue,
        };
        match k {
            "code" => code = Some(percent_decode(v)),
            "state" => state = Some(percent_decode(v)),
            "error" => error = Some(percent_decode(v)),
            _ => {}
        }
    }
    let result = OAuthCallback { code, state, error };
    let done = result.code.is_some() || result.error.is_some();
    respond(
        &mut stream,
        200,
        "<html><body style=\"font-family:sans-serif;padding:2em\">\
         <h2>Songnest login complete</h2>\
         <p>You can close this tab and return to Songnest.</p>\
         </body></html>",
    )
    .await;
    Ok(done.then_some(result))
}

async fn respond(stream: &mut tokio::net::TcpStream, status: u16, body: &str) {
    let reason = if status == 200 { "OK" } else { "Not Found" };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body.as_bytes()).await;
    let _ = stream.shutdown().await;
}

fn percent_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push((h << 4 | l) as char);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(' ');
        } else {
            out.push(bytes[i] as char);
        }
        i += 1;
    }
    out
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_query_values() {
        assert_eq!(percent_decode("abc%20def+ghi%2F"), "abc def ghi/");
        assert_eq!(percent_decode("%ZZ"), "%ZZ");
        assert_eq!(percent_decode("4%2F0A%2Bxyz"), "4/0A+xyz");
    }
}
