use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::RwLock;

#[cfg(feature = "songnestpy")]
use songnest_extract::{Extractor, SongnestPyExtractor};

/// YouTube backend: yt-dlp subprocess (default) or SongnestPy — yt-dlp
/// running on the embedded CPython interpreter (Chaquopy) inside the
/// Android app, reached over JNI. The phone build uses SongnestPy: there is
/// no subprocess yt-dlp on Android.
#[derive(Clone)]
pub enum Backend {
    YtDlp,
    #[cfg(feature = "songnestpy")]
    SongnestPy(SongnestPyExtractor),
}

impl Backend {
    fn name(&self) -> &'static str {
        match self {
            Backend::YtDlp => "ytdlp",
            #[cfg(feature = "songnestpy")]
            Backend::SongnestPy(_) => "songnestpy",
        }
    }
}

/// Build the on-device backend directly (phone embedder; no env needed).
/// `data_dir` is the app data dir: `<data_dir>/cookies.txt` is handed to
/// yt-dlp when present, anonymous otherwise.
#[cfg(feature = "songnestpy")]
pub fn backend_songnestpy(data_dir: &str) -> anyhow::Result<Backend> {
    Ok(Backend::SongnestPy(SongnestPyExtractor::new(data_dir)))
}

/// Pick the YouTube backend. Desktop only has the yt-dlp subprocess; the
/// phone builds its SongnestPy backend directly (see backend_songnestpy)
/// because the interpreter lives inside the app process.
pub fn backend_from_env() -> anyhow::Result<Backend> {
    let want = std::env::var("SONGNEST_BACKEND").unwrap_or_else(|_| "ytdlp".to_string());
    if want == "ytdlp" {
        return Ok(Backend::YtDlp);
    }
    anyhow::bail!("unknown SONGNEST_BACKEND={want} (only ytdlp on desktop)");
}

#[derive(Deserialize)]
struct DzSearch {
    data: Vec<DzTrack>,
}
#[derive(Deserialize)]
struct DzTrack {
    id: u64,
    title: String,
    duration: u32,
    artist: DzArtist,
    album: DzAlbum,
    #[serde(default)]
    preview: String,
}
#[derive(Deserialize)]
struct DzArtist {
    name: String,
}
#[derive(Deserialize)]
struct DzAlbum {
    title: String,
    cover_big: String,
}

#[derive(Deserialize)]
struct YtList {
    entries: Vec<YtEntry>,
}
#[derive(Deserialize)]
struct YtEntry {
    id: String,
    title: String,
    duration: Option<f64>,
    channel: Option<String>,
}

#[derive(Clone)]
struct AppState {
    db: Db,
    http: reqwest::Client,
    backend: Backend,
    urls: Arc<Mutex<HashMap<String, (String, String, Instant)>>>,
    resolve_lock: Arc<tokio::sync::Mutex<()>>,
    /// max 2 concurrent downloads (anti-bot: look human, not a farm)
    dl_sem: Arc<tokio::sync::Semaphore>,
    /// set when YouTube 429s/bot-checks us; queue + resolves pause meanwhile
    yt_cooldown_until: Arc<Mutex<Option<Instant>>>,
    /// last googlevideo media request: paced player-style, never bursty
    last_media: Arc<tokio::sync::Mutex<Option<Instant>>>,
    /// downloader (yt-dlp binary, JS runtimes, health, updater)
    downloader: DownloaderState,
}

/// Seconds left on the YouTube cooldown, if any.
fn cooled_down(s: &AppState) -> Option<u64> {
    s.yt_cooldown_until
        .lock()
        .unwrap()
        .filter(|t| *t > Instant::now())
        .map(|t| t.duration_since(Instant::now()).as_secs())
}

/// True when backend output smells like throttling/bot-check.
/// 403s land here too: YouTube refuses this way when an IP is throttled
/// (both yt-dlp stderr and direct-fetch errors flow through this).
fn youtube_blocked(text: &str) -> bool {
    text.contains("429")
        || text.contains("403")
        || text.contains("Sign in to confirm")
        || text.contains("bot check")
}

fn score(e: &YtEntry, t: &DzTrack) -> i32 {
    let mut s = 0;
    if let Some(d) = e.duration {
        s -= (d as i32 - t.duration as i32).abs() * 2;
    }
    if e.channel
        .as_deref()
        .map_or(false, |c| c.ends_with("- Topic"))
    {
        s += 20;
    }
    // same-name guard: the artist must actually match, not just the title
    let artist = t.artist.name.to_lowercase();
    if !artist.is_empty() {
        let chan = e.channel.as_deref().unwrap_or("").to_lowercase();
        if chan.starts_with(&artist) {
            s += 30;
        } else if chan.contains(&artist) {
            s += 15;
        } else {
            s -= 25;
        }
        let title = e.title.to_lowercase();
        if title.contains(&artist) {
            s += 10;
        }
    }
    let title = e.title.to_lowercase();
    if title.contains("official audio") {
        s += 10;
    }
    for bad in [
        "live", "cover", "remix", "lyrics", "karaoke", "slowed", "sped up",
    ] {
        if title.contains(bad) {
            s -= 15;
        }
    }
    s
}

// ---- downloader: yt-dlp binary, JS runtimes, health, updates ----
//
// Runtime minimums below are quoted from
// https://github.com/yt-dlp/yt-dlp/wiki/EJS as fetched on 2026-10-04:
//   deno:      "Minimum supported version: `2.3.0`" (enabled by default)
//   node:      "Minimum supported version: `22.0.0`"
//   bun:       "Minimum supported version: `1.2.11`",
//              "Latest supported version: `1.3.14`",
//              "Support for `bun` is deprecated!"
//   quickjs:   "Minimum supported QuickJS version: `2023-12-9`"
//   quickjs-ng: "All versions of QuickJS-NG are supported."
// Wiki priority order (also in --help): deno, node, quickjs, bun.
const DENO_MIN: (u64, u64, u64) = (2, 3, 0);
const NODE_MIN: (u64, u64, u64) = (22, 0, 0);
const BUN_MIN: (u64, u64, u64) = (1, 2, 11);
const BUN_MAX: (u64, u64, u64) = (1, 3, 14);
const QUICKJS_MIN_DATE: (u64, u64, u64) = (2023, 12, 9);

/// Exact binary names probed on PATH (change 8: nothing else is executed).
const RUNTIME_BINS: &[&str] = &["deno", "node", "bun", "qjs", "quickjs-ng"];

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize)]
#[serde(rename_all = "lowercase")]
enum Health {
    Ok,
    RateLimited,
    Outdated,
    Offline,
    #[serde(rename = "js_runtime_missing")]
    JsRuntimeMissing,
    #[default]
    Unknown,
}

#[derive(Clone, Debug, Default, Serialize)]
struct RuntimeInfo {
    name: String,
    version: String,
    supported: bool,
    path: String,
}

#[derive(Clone, Default)]
struct DownloaderInner {
    binary_path: String,
    /// "managed" | "path" | "none"
    binary_source: String,
    version: String,
    latest: Option<String>,
    update_available: bool,
    last_check_at: i64,
    last_update_at: Option<i64>,
    health: Health,
    last_error: String,
    ffmpeg: Option<String>,
    runtimes: Vec<RuntimeInfo>,
    runtime_in_use: Option<String>,
    /// auto | deno | node | bun | quickjs, optionally name:/explicit/path
    runtime_setting: String,
    /// parsed (name, path) from runtime_setting when it carries a path
    setting_path: Option<(String, String)>,
    /// None = unknown (see ejs_note)
    ejs_available: Option<bool>,
    ejs_note: String,
    /// in-flight resolve/download calls; updater waits for 0
    active: u64,
}

#[derive(Clone, Default)]
struct DownloaderState {
    inner: Arc<RwLock<DownloaderInner>>,
}

impl DownloaderState {
    fn read<R>(&self, f: impl FnOnce(&DownloaderInner) -> R) -> R {
        f(&self.inner.read().unwrap())
    }

    /// Hold an in-flight slot (RAII: see ActiveGuard).
    fn hold(&self) -> ActiveGuard {
        self.inner.write().unwrap().active += 1;
        ActiveGuard {
            inner: self.inner.clone(),
        }
    }

    /// (binary, extra args) without the in-flight guard (sync call sites
    /// hold their own guard).
    fn argv(&self) -> anyhow::Result<(String, Vec<String>)> {
        let (bin, name, path) = {
            let d = self.inner.read().unwrap();
            if d.binary_path.is_empty() {
                anyhow::bail!("no yt-dlp binary configured");
            }
            let (name, path) = pick_runtime(
                &d.runtimes,
                &d.runtime_setting,
                d.setting_path.as_ref()
            )
            .unwrap_or_default();
            (d.binary_path.clone(), name, path)
        };
        let mut args = Vec::new();
        if !name.is_empty() {
            args.push("--js-runtimes".to_string());
            args.push(match path {
                Some(p) => format!("{name}:{p}"),
                None => name.clone(),
            });
            self.inner.write().unwrap().runtime_in_use = Some(name);
        } else {
            self.inner.write().unwrap().runtime_in_use = None;
        }
        Ok((bin, args))
    }
}

/// Detect everything about the downloader. Runs at startup (data dir = CWD).
async fn init_downloader() -> DownloaderState {
    let st = DownloaderState::default();
    let (bin, source) = resolve_ytdlp_binary().await;
    let version = if bin.is_empty() {
        String::new()
    } else {
        run_timeout(tokio::process::Command::new(&bin).arg("--version"), 10)
            .await
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .unwrap_or_default()
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let (ejs_available, ejs_note) = probe_ejs(&bin, &source).await;
    let ffmpeg = probe_ffmpeg().await;
    let setting_raw = std::fs::read_to_string("js_runtime.txt")
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let setting_env = std::env::var("SONGNEST_JS_RUNTIME").unwrap_or_default();
    let (setting, setting_path) = parse_runtime_setting(if setting_raw.is_empty() {
        &setting_env
    } else {
        &setting_raw
    });
    let runtimes = detect_runtimes(setting_path.clone()).await;
    {
        let mut d = st.inner.write().unwrap();
        d.binary_path = bin;
        d.binary_source = source;
        d.version = version;
        d.ejs_available = ejs_available;
        d.ejs_note = ejs_note;
        d.ffmpeg = ffmpeg;
        d.runtime_setting = setting;
        d.setting_path = setting_path;
        d.runtimes = runtimes;
        d.health = Health::Unknown;
    }
    st
}

/// RAII guard: the in-flight counter goes back down on drop, so errors,
/// early returns and panics can never leave it stuck above zero.
struct ActiveGuard {
    inner: Arc<RwLock<DownloaderInner>>,
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        if let Ok(mut d) = self.inner.write() {
            d.active = d.active.saturating_sub(1);
        }
    }
}

struct YtDlpCall {
    cmd: tokio::process::Command,
    _guard: ActiveGuard,
}


/// Run a command with a timeout. None on timeout, spawn failure, or non-UTF8 issues.
async fn run_timeout(
    cmd: &mut tokio::process::Command,
    secs: u64,
) -> Option<std::process::Output> {
    tokio::time::timeout(Duration::from_secs(secs), cmd.output())
        .await
        .ok()?
        .ok()
}

/// Parse the first `N.N.N` triple in a --version string.
fn parse_triple(s: &str) -> Option<(u64, u64, u64)> {
    let mut nums = Vec::new();
    let mut cur = String::new();
    for ch in s.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_digit() {
            cur.push(ch);
        } else if ch == '.' && !cur.is_empty() {
            nums.push(cur.parse::<u64>().ok()?);
            cur = String::new();
        } else if !cur.is_empty() {
            nums.push(cur.parse::<u64>().ok()?);
            cur = String::new();
            if nums.len() == 3 {
                break;
            }
        }
    }
    if nums.len() == 3 {
        Some((nums[0], nums[1], nums[2]))
    } else {
        None
    }
}

/// Parse the first `YYYY-MM-DD` date in a version string (QuickJS style).
fn parse_qjs_date(s: &str) -> Option<(u64, u64, u64)> {
    let bytes = s.as_bytes();
    for i in 0..bytes.len().saturating_sub(9) {
        let w = &s[i..i + 10];
        let parts: Vec<&str> = w.split('-').collect();
        if parts.len() == 3
            && parts[0].len() == 4
            && parts[1].len() == 2
            && parts[2].len() == 2
            && parts.iter().all(|p| p.bytes().all(|b| b.is_ascii_digit()))
        {
            return Some((
                parts[0].parse().ok()?,
                parts[1].parse().ok()?,
                parts[2].parse().ok()?,
            ));
        }
    }
    None
}

/// (name, supported) decision for one probed runtime.
fn classify_runtime(bin: &str, version_out: &str) -> (String, bool) {
    match bin {
        "deno" => (
            "deno".to_string(),
            parse_triple(version_out).is_some_and(|v| v >= DENO_MIN),
        ),
        "node" => (
            "node".to_string(),
            parse_triple(version_out).is_some_and(|v| v >= NODE_MIN),
        ),
        "bun" => (
            "bun".to_string(),
            parse_triple(version_out).is_some_and(|v| v >= BUN_MIN && v <= BUN_MAX),
        ),
        "qjs" => {
            // classic QuickJS prints a date; a quickjs-ng binary answers semver
            if let Some(d) = parse_qjs_date(version_out) {
                ("quickjs".to_string(), d >= QUICKJS_MIN_DATE)
            } else if parse_triple(version_out).is_some() {
                ("quickjs".to_string(), true)
            } else {
                ("quickjs".to_string(), false)
            }
        }
        _ => {
            // "quickjs-ng" binary (or future names): semver or date = supported
            if parse_triple(version_out).is_some() || parse_qjs_date(version_out).is_some() {
                ("quickjs".to_string(), true)
            } else {
                ("quickjs".to_string(), false)
            }
        }
    }
}

/// Probe one binary name with `--version` (8s timeout each).
async fn probe_runtime(bin: &str) -> Option<(String, String)> {
    let out = run_timeout(tokio::process::Command::new(bin).arg("--version"), 8).await?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8(out.stdout).ok()?;
    let version = text.lines().next().unwrap_or("").trim().to_string();
    if version.is_empty() {
        return None;
    }
    Some((bin.to_string(), version))
}

/// Detect runtimes: exact binary names on PATH, or an explicit user path.
async fn detect_runtimes(setting_path: Option<(String, String)>) -> Vec<RuntimeInfo> {
    let mut out = Vec::new();
    if let Some((name, path)) = setting_path {
        // user explicitly set this path: probe exactly it, nothing else extra
        let probed = run_timeout(
            tokio::process::Command::new(&path).arg("--version"),
            8,
        )
        .await;
        if let Some(o) = probed.filter(|o| o.status.success()) {
            let version = String::from_utf8(o.stdout)
                .ok()
                .and_then(|t| t.lines().next().map(|l| l.trim().to_string()))
                .unwrap_or_default();
            let (n, supported) = classify_runtime(&name, &version);
            out.push(RuntimeInfo { name: n, version, supported, path });
        }
        return out;
    }
    for bin in RUNTIME_BINS {
        if let Some((_, version)) = probe_runtime(bin).await {
            let (name, supported) = classify_runtime(bin, &version);
            out.push(RuntimeInfo {
                name,
                version,
                supported,
                path: bin.to_string(),
            });
        }
    }
    out
}

/// Pick (runtime name, explicit path or None) for the --js-runtimes arg.
/// Auto order follows the wiki: deno, node, quickjs, bun.
fn pick_runtime(
    runtimes: &[RuntimeInfo],
    setting: &str,
    setting_path: Option<&(String, String)>,
) -> Option<(String, Option<String>)> {
    let want = setting.split(':').next().unwrap_or("auto");
    let usable = |name: &str| {
        runtimes
            .iter()
            .find(|r| r.name == name && r.supported)
            .map(|_| {
                let explicit = setting_path
                    .filter(|(n, _)| n == name)
                    .map(|(_, p)| p.clone());
                (name.to_string(), explicit)
            })
    };
    if want != "auto" {
        return usable(want);
    }
    ["deno", "node", "quickjs", "bun"]
        .into_iter()
        .find_map(usable)
}

/// Split a `name:/path` runtime setting. Returns (name, Option<(name, path)>).
fn parse_runtime_setting(raw: &str) -> (String, Option<(String, String)>) {
    let raw = raw.trim();
    if raw.is_empty() {
        return ("auto".to_string(), None);
    }
    match raw.split_once(':') {
        Some((name, path)) if !path.is_empty() => {
            (name.to_string(), Some((name.to_string(), path.to_string())))
        }
        _ => (raw.to_string(), None),
    }
}
/// Managed binary location inside the app data dir.
fn managed_bin_path() -> std::path::PathBuf {
    let exe = if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" };
    std::path::Path::new("bin").join(exe)
}

/// Resolve the yt-dlp binary: managed copy -> PATH -> none.
/// Returns (path to exec, source label).
async fn resolve_ytdlp_binary() -> (String, String) {
    let managed = managed_bin_path();
    if managed.exists() {
        return (
            managed.to_string_lossy().into_owned(),
            "managed".to_string(),
        );
    }
    // PATH check without executing anything: an executable file named
    // yt-dlp in any PATH dir (plus .exe on Windows).
    let on_path = std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths).any(|d| {
                #[cfg(windows)]
                if d.join("yt-dlp.exe").is_file() {
                    return true;
                }
                d.join("yt-dlp").is_file()
            })
        })
        .unwrap_or(false);
    if on_path {
        return ("yt-dlp".to_string(), "path".to_string());
    }
    (String::new(), "none".to_string())
}

/// Three-way EJS check. Returns (available, explanation).
/// - managed/standalone binaries bundle yt-dlp-ejs -> true
/// - script installs: probe `import yt_dlp_ejs` with the interpreter from
///   the script's own shebang line (never whatever python3 resolves to)
/// - unidentifiable binaries -> None (unknown), never assumed false:
///   distro packages may ship yt-dlp-ejs separately
async fn probe_ejs(binary: &str, source: &str) -> (Option<bool>, String) {
    if source == "managed" {
        return (
            Some(true),
            "bundled with the official standalone build".to_string(),
        );
    }
    if binary.is_empty() || binary == "yt-dlp" {
        // PATH lookup: find the real file first
        let found = ["yt-dlp", "/usr/bin/yt-dlp", "/usr/local/bin/yt-dlp"]
            .into_iter()
            .find(|p| std::path::Path::new(p).exists());
        match found {
            Some(p) => return probe_ejs_file(p).await,
            None => {
                return (
                    None,
                    "no yt-dlp binary to inspect (PATH lookup failed)".to_string(),
                )
            }
        }
    }
    probe_ejs_file(binary).await
}

async fn probe_ejs_file(path: &str) -> (Option<bool>, String) {
    let bytes = tokio::fs::read(path).await.unwrap_or_default();
    if bytes.is_empty() {
        return (None, "could not read the yt-dlp binary".to_string());
    }
    // ELF / Mach-O / PE = standalone executable -> EJS bundled
    let standalone = bytes.starts_with(b"\x7fELF")
        || bytes.starts_with(b"\xcf\xfa\xed\xfb")
        || bytes.starts_with(b"\xfe\xed\xfa\xce")
        || bytes.starts_with(b"MZ");
    if standalone {
        return (
            Some(true),
            "standalone executable bundles yt-dlp-ejs".to_string(),
        );
    }
    let text = String::from_utf8_lossy(&bytes);
    let first = text.lines().next().unwrap_or("");
    if !(first.starts_with("#!") && first.contains("python")) {
        return (
            None,
            "binary type unrecognized; cannot tell if yt-dlp-ejs is present".to_string(),
        );
    }
    // shebang interpreter, e.g. "#!/usr/bin/python3" (env -S forms included)
    let interp = first
        .trim_start_matches("#!")
        .trim()
        .replace("/usr/bin/env -S ", "")
        .replace("/usr/bin/env ", "");
    let interp = interp.split_whitespace().next().unwrap_or("").to_string();
    if interp.is_empty() {
        return (
            None,
            "shebang interpreter could not be determined".to_string(),
        );
    }
    let ok = run_timeout(
        tokio::process::Command::new(&interp)
            .arg("-c")
            .arg("import yt_dlp_ejs"),
        15,
    )
    .await
    .is_some_and(|o| o.status.success());
    if ok {
        (
            Some(true),
            format!("yt_dlp_ejs importable under {interp}"),
        )
    } else {
        (
            None,
            format!(
                "yt_dlp_ejs not importable under {interp}; distro packages may ship it separately"
            ),
        )
    }
}

async fn probe_ffmpeg() -> Option<String> {
    let out = run_timeout(
        tokio::process::Command::new("ffmpeg").arg("-version"),
        8,
    )
    .await?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout)
        .ok()
        .and_then(|t| t.lines().next().map(|l| l.trim().to_string()))
        .filter(|l| !l.is_empty())
}

/// Single entry point for every yt-dlp invocation. Resolves the configured
/// binary plus the `--js-runtimes` choice, and holds the in-flight guard
/// until the returned call is dropped.
fn ytdlp_command(dl: &DownloaderState) -> anyhow::Result<YtDlpCall> {
    let (bin, args) = dl.argv()?;
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.args(&args);
    Ok(YtDlpCall {
        cmd,
        _guard: dl.hold(),
    })
}

/// Compare date-style versions ("2025.01.26", optional suffix).
/// Numeric components compare numerically, extras lexicographically.
fn cmp_date_version(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    fn parts(s: &str) -> Vec<String> {
        s.split(|c: char| !c.is_ascii_alphanumeric())
            .filter(|p| !p.is_empty())
            .map(|p| p.to_string())
            .collect()
    }
    let (ap, bp) = (parts(a), parts(b));
    for (x, y) in ap.iter().zip(bp.iter()) {
        let ord = match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(xn), Ok(yn)) => xn.cmp(&yn),
            _ => x.cmp(y),
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }
    ap.len().cmp(&bp.len())
}

/// Health classification. Order matters: offline -> rate_limited ->
/// js_runtime_missing -> outdated. Only Outdated may trigger an update.
fn classify_failure(stderr_text: &str, io_failed: bool) -> Health {
    let t = stderr_text.to_lowercase();
    if io_failed
        || t.contains("dns")
        || t.contains("network is unreachable")
        || t.contains("connection refused")
        || t.contains("connection timed out")
        || t.contains("temporary failure")
    {
        return Health::Offline;
    }
    if t.contains("429")
        || t.contains("sign in to confirm")
        || t.contains("bot check")
    {
        return Health::RateLimited;
    }
    if t.contains("js runtime")
        || t.contains("javascript runtime")
        || t.contains("challenge solving")
        || t.contains("could not solve")
        || t.contains("ejs script")
        || t.contains("challenge solver")
    {
        return Health::JsRuntimeMissing;
    }
    Health::Outdated
}

/// Extra yt-dlp args from `SONGNEST_COOKIES` (default `cookies.txt`).
/// Empty when the file doesn't exist: YouTube works until it 429s us.
fn cookie_args() -> Vec<String> {
    let path =
        std::env::var("SONGNEST_COOKIES").unwrap_or_else(|_| "cookies.txt".to_string());
    if std::path::Path::new(&path).exists() {
        vec!["--cookies".to_string(), path]
    } else {
        Vec::new()
    }
}

fn download(dl: &DownloaderState, video_id: &str, out_dir: &str) -> anyhow::Result<String> {
    let template = format!("{out_dir}/%(id)s.%(ext)s");
    let _guard = dl.hold();
    let (bin, js_args) = dl.argv()?;
    let mut args = cookie_args();
    args.extend(js_args);
    args.extend(
        [
            "-f",
            "ba[ext=m4a]/ba",
            "-x",
            "--audio-format",
            "m4a",
            "-o",
            &template,
            &format!("https://youtube.com/watch?v={video_id}"),
        ]
        .into_iter()
        .map(|s| s.to_string()),
    );
    let status = Command::new(&bin).args(&args).status()?;
    anyhow::ensure!(status.success(), "yt-dlp failed");
    Ok(format!("{out_dir}/{video_id}.m4a"))
}

use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::*;
use lofty::probe::Probe;

fn tag_file(path: &str, t: &DzTrack, cover: &[u8]) -> anyhow::Result<()> {
    let mut f = Probe::open(path)?.read()?;
    let tag = match f.primary_tag_mut() {
        Some(tag) => tag,
        None => {
            let ty = f.primary_tag_type();
            f.insert_tag(lofty::tag::Tag::new(ty));
            f.primary_tag_mut().unwrap()
        }
    };
    tag.set_title(t.title.clone());
    tag.set_artist(t.artist.name.clone());
    tag.set_album(t.album.title.clone());
    tag.push_picture(Picture::new_unchecked(
        PictureType::CoverFront,
        Some(MimeType::Jpeg),
        None,
        cover.to_vec(),
    ));
    tag.save_to_path(path, Default::default())?;
    Ok(())
}

use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, State},
    http::Request,
    response::IntoResponse,
    routing::{delete, get, post},
};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;
use tower_http::{cors::CorsLayer, services::ServeFile};

type Db = Arc<Mutex<rusqlite::Connection>>;

fn ensure_schema(db: &rusqlite::Connection) -> anyhow::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS tracks (
        id INTEGER PRIMARY KEY, title TEXT, artist TEXT, album TEXT,
        duration INTEGER, video_id TEXT UNIQUE, path TEXT)",
    )?;
    // best-effort migration for existing DBs; fails if column already exists
    let _ = db.execute("ALTER TABLE tracks ADD COLUMN cover_url TEXT", []);
    let _ = db.execute("ALTER TABLE tracks ADD COLUMN deezer_id INTEGER", []);
    // Deezer track -> YouTube video match, searched once then reused
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS yt_match (
        deezer_id INTEGER PRIMARY KEY, video_id TEXT NOT NULL,
        score INTEGER NOT NULL, matched_at INTEGER NOT NULL)",
    )?;
    // download queue: bulk downloads go here, 2 at a time max
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS downloads (
        id INTEGER PRIMARY KEY, deezer_id INTEGER NOT NULL,
        video_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'queued',
        progress INTEGER NOT NULL DEFAULT 0, error TEXT,
        queued_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    )?;
    // liked songs: key is "dz:<id>" or "db:<id>"
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS liked (
        key TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL,
        album TEXT NOT NULL DEFAULT '', cover TEXT NOT NULL DEFAULT '',
        liked_at INTEGER NOT NULL)",
    )?;
    Ok(())
}

/// Cached Deezer->YouTube match. `fresh=true` skips the cache.
fn get_match(db: &Db, deezer_id: u64) -> Option<(String, i32)> {
    db.lock()
        .unwrap()
        .query_row(
            "SELECT video_id, score FROM yt_match WHERE deezer_id = ?1",
            [deezer_id as i64],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok()
}

fn put_match(db: &Db, deezer_id: u64, video_id: &str, score: i32) {
    let _ = db.lock().unwrap().execute(
        "INSERT INTO yt_match (deezer_id, video_id, score, matched_at)
         VALUES (?1, ?2, ?3, strftime('%s','now'))
         ON CONFLICT(deezer_id) DO UPDATE SET
           video_id = excluded.video_id, score = excluded.score,
           matched_at = excluded.matched_at",
        rusqlite::params![deezer_id as i64, video_id, score],
    );
}

/// Match a Deezer track to a YouTube video id (cached). yt-dlp runs
/// `ytsearch5`; SongnestPy searches via on-device yt-dlp and reuses the same scorer.
async fn youtube_match(
    dl: &DownloaderState,
    #[cfg_attr(not(feature = "songnestpy"), allow(unused_variables))] backend: &Backend,
    db: &Db,
    t: &DzTrack,
    fresh: bool,
) -> Option<(String, i32)> {
    if !fresh {
        if let Some(hit) = get_match(db, t.id) {
            return Some(hit);
        }
    }
    #[cfg(feature = "songnestpy")]
    if let Backend::SongnestPy(ex) = backend {
        let hits = ex
            .search_music(&format!("{} {}", t.artist.name, t.title))
            .await
            .ok()?;
        let best = hits
            .iter()
            .map(|c| YtEntry {
                id: c.id.clone(),
                title: c.title.clone(),
                duration: c.duration_secs.map(|d| d as f64),
                channel: c.channel.clone(),
            })
            .max_by_key(|e| score(e, t))?;
        let id = best.id.clone();
        let sc = score(&best, t);
        put_match(db, t.id, &id, sc);
        return Some((id, sc));
    }
    let YtDlpCall { mut cmd, _guard } = ytdlp_command(dl).ok()?;
    let out = cmd
        .args(cookie_args())
        .args([
            "-J",
            "--flat-playlist",
            &format!("ytsearch5:{} {}", t.artist.name, t.title),
        ])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let list: YtList = serde_json::from_slice(&out.stdout).ok()?;
    let best = list.entries.iter().max_by_key(|e| score(e, t))?;
    let id = best.id.clone();
    let sc = score(best, t);
    put_match(db, t.id, &id, sc);
    Some((id, sc))
}

async fn track(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    req: Request<Body>,
) -> impl IntoResponse {
    let path: String =
        s.db.lock()
            .unwrap()
            .query_row("SELECT path FROM tracks WHERE id = ?1", [id], |r| r.get(0))
            .unwrap_or_default();
    ServeFile::new(path).oneshot(req).await.unwrap()
}

fn set_job(db: &Db, id: i64, status: &str, progress: i64, error: Option<&str>) {
    let _ = db.lock().unwrap().execute(
        "UPDATE downloads SET status=?1, progress=?2, error=?3, updated_at=strftime('%s','now') WHERE id=?4",
        rusqlite::params![status, progress, error, id],
    );
}

/// Parse `[download]  34.5% of ...` progress lines.
fn parse_progress(line: &str) -> Option<u8> {
    let after = line.split("[download]").nth(1)?;
    let pct = after.split_whitespace().next()?;
    pct.strip_suffix('%')?
        .parse::<f64>()
        .ok()
        .map(|p| p.clamp(0.0, 100.0) as u8)
}

/// Blocking yt-dlp download with human-like pauses and progress.
/// Err carries stderr tail for throttle detection.
fn download_job(
    dl: &DownloaderState,
    video_id: &str,
    out_dir: &str,
    on_progress: &(dyn Fn(u8) + Send + Sync),
) -> Result<String, String> {
    use std::io::BufRead;
    let template = format!("{out_dir}/%(id)s.%(ext)s");
    let _guard = dl.hold();
    let (bin, js_args) = dl.argv().map_err(|e| e.to_string())?;
    let mut args = cookie_args();
    args.extend(js_args);
    args.extend(
        [
            "--sleep-requests",
            "2",
            "--sleep-interval",
            "3",
            "--max-sleep-interval",
            "10",
            "--newline",
            "--progress",
            "-f",
            "ba[ext=m4a]/ba",
            "-x",
            "--audio-format",
            "m4a",
            "-o",
            &template,
            &format!("https://youtube.com/watch?v={video_id}"),
        ]
        .into_iter()
        .map(|s| s.to_string()),
    );
    let mut child = Command::new(&bin)
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    // drain stdout (discard) so the child never blocks on a full pipe
    let mut sout = child.stdout.take().unwrap();
    let drain = std::thread::spawn(move || {
        std::io::copy(&mut sout, &mut std::io::sink()).ok();
    });
    let serr = child.stderr.take().unwrap();
    for line in std::io::BufReader::new(serr).lines().map_while(Result::ok) {
        if let Some(p) = parse_progress(&line) {
            on_progress(p);
        }
    }
    drain.join().ok();
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let tail: String = String::from_utf8_lossy(&out.stderr)
            .lines()
            .rev()
            .take(5)
            .collect::<Vec<_>>()
            .join("\n");
        return Err(tail);
    }
    on_progress(100);
    Ok(format!("{out_dir}/{video_id}.m4a"))
}

/// Fetch audio bytes directly (no yt-dlp/ffmpeg): resolve via the shared
/// URL cache, then stream bounded 1MB range chunks to `music/<id>.m4a`
/// with progress. No transcoding — the resolved stream is already m4a.
/// Err carries a short message, checked for throttle signals by the caller.
/// Browser-grade headers for googlevideo media requests, copied from a
/// working player session: bare-bones clients get flagged faster.
const MEDIA_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

fn media_request(
    http: &reqwest::Client,
    url: &str,
    range: Option<String>,
) -> reqwest::RequestBuilder {
    let mut rb = http
        .get(url)
        .header(reqwest::header::USER_AGENT, MEDIA_UA)
        .header(
            reqwest::header::ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .header(reqwest::header::ACCEPT_LANGUAGE, "en-us,en;q=0.5")
        .header("Sec-Fetch-Mode", "navigate")
        .header(reqwest::header::ACCEPT_ENCODING, "identity");
    if let Some(r) = range {
        rb = rb.header(reqwest::header::RANGE, r);
    }
    rb
}

/// Sleep until a player-like gap passed since the last media request,
/// then record this one. Serializes googlevideo traffic (1.5s + up to
/// 1.5s jitter) instead of machine-gunning it.
async fn pace_media(s: &AppState) {
    const BASE_MS: u64 = 1500;
    let jitter = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| (d.subsec_nanos() as u64) % 1500)
        .unwrap_or(500);
    let gap = BASE_MS + jitter;
    let mut last = s.last_media.lock().await;
    if let Some(t) = *last {
        let elapsed = t.elapsed().as_millis() as u64;
        if elapsed < gap {
            tokio::time::sleep(Duration::from_millis(gap - elapsed)).await;
        }
    }
    *last = Some(Instant::now());
}

async fn paced_media_get(
    s: &AppState,
    url: &str,
    range: Option<String>,
) -> Result<reqwest::Response, reqwest::Error> {
    pace_media(s).await;
    media_request(&s.http, url, range).send().await
}

/// Backend-agnostic direct fetch: the URL comes from whichever extractor
/// resolved it (yt-dlp `-g` on desktop, SongnestPy resolve on phone).
/// Only the on-device backend downloads this way today, hence the gate.
#[cfg(feature = "songnestpy")]
async fn download_direct(
    s: &AppState,
    video_id: &str,
    out_dir: &str,
    on_progress: &(dyn Fn(u8) + Send + Sync),
) -> Result<String, String> {
    use tokio::io::AsyncWriteExt;
    let mut url = resolve_url(s, video_id, false).await.map_err(|e| e.to_string())?;
    let ext = audio_ext(&cached_mime(s, video_id).unwrap_or_else(|| "audio/mp4".to_string()));
    const CHUNK: u64 = 1024 * 1024;
    std::fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
    let tmp = format!("{out_dir}/{video_id}.{ext}.part");
    let final_path = format!("{out_dir}/{video_id}.{ext}");
    let mut file = tokio::fs::File::create(&tmp).await.map_err(|e| e.to_string())?;
    let mut start: u64 = 0;
    let mut total: u64 = 0;
    // One paced retry max: a second 403 means throttling, not a stale URL.
    // Hammering hot retries is what gets IPs flagged — fail fast into the
    // shared cooldown instead.
    let mut retried = false;
    loop {
        let resp = paced_media_get(
            s,
            &url,
            Some(format!("bytes={start}-{}", start + CHUNK - 1)),
        )
        .await
        .map_err(|e| e.to_string())?;
        let status = resp.status();
        if status == reqwest::StatusCode::FORBIDDEN && !retried {
            retried = true;
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            url = resolve_url(s, video_id, true)
                .await
                .map_err(|e| e.to_string())?;
            continue;
        }
        if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            break; // past EOF
        }
        if !(status.is_success() || status.as_u16() == 206) {
            let _ = tokio::fs::remove_file(&tmp).await;
            let host = url.split('/').nth(2).unwrap_or("?");
            eprintln!("direct download: {status} host={host} start={start}");
            return Err(format!("audio fetch HTTP {status}"));
        }
        if total == 0 {
            // `bytes 0-1048575/4025466` -> total; missing -> unknown (0)
            total = resp
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.rsplit('/').next())
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
        }
        let bytes = resp.bytes().await.map_err(|e| format!("audio fetch failed: {e}"))?;
        if bytes.is_empty() {
            break;
        }
        {
            file.write_all(&bytes).await.map_err(|e| e.to_string())?;
        }
        start += bytes.len() as u64;
        if total > 0 {
            let pct = start
                .saturating_mul(100)
                .checked_div(total)
                .unwrap_or(0)
                .min(100) as u8;
            on_progress(pct);
        }
        if total > 0 && start >= total {
            break;
        }
        if status.as_u16() == 200 {
            break; // server ignored the range: full body in one shot
        }
        // pacing is enforced by the shared media gate (paced_media_get)
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(&tmp, &final_path).map_err(|e| e.to_string())?;
    // empty file = failed fetch wearing a 200
    if std::fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0) == 0 {
        let _ = std::fs::remove_file(&final_path);
        return Err("audio fetch returned empty file".to_string());
    }
    on_progress(100);
    Ok(final_path)
}

async fn run_job(s: &AppState, job_id: i64, dzid: u64) {
    // 1. Deezer metadata (exact song, exact cover)
    let t: DzTrack = match s
        .http
        .get(format!("https://api.deezer.com/track/{dzid}"))
        .send()
        .await
    {
        Ok(r) => match r.json().await {
            Ok(t) => t,
            Err(_) => {
                set_job(&s.db, job_id, "error", 0, Some("deezer track fetch failed"));
                return;
            }
        },
        Err(_) => {
            set_job(&s.db, job_id, "error", 0, Some("deezer track fetch failed"));
            return;
        }
    };
    // 2. cached match: each song is searched once, even across queue jobs
    let Some((video_id, _)) = youtube_match(&s.downloader, &s.backend, &s.db, &t, false).await else {
        set_job(&s.db, job_id, "error", 0, Some("no YouTube match (throttled?)"));
        return;
    };
    s.db
        .lock()
        .unwrap()
        .execute(
            "UPDATE downloads SET video_id=?1, updated_at=strftime('%s','now') WHERE id=?2",
            rusqlite::params![video_id, job_id],
        )
        .ok();
    // 3. download with progress (yt-dlp subprocess, or direct fetch on songnestpy)
    let dl_result: Result<String, String> = match &s.backend {
        Backend::YtDlp => {
            let db2 = s.db.clone();
            let vid2 = video_id.clone();
            let dl_state = s.downloader.clone();
            tokio::task::spawn_blocking(move || {
                download_job(&dl_state, &vid2, "music", &|p| {
                    let _ = db2.lock().unwrap().execute(
                        "UPDATE downloads SET progress=?1, updated_at=strftime('%s','now') WHERE id=?2",
                        rusqlite::params![p as i64, job_id],
                    );
                })
            })
            .await
            .unwrap_or(Err("download task failed".to_string()))
        }
        #[cfg(feature = "songnestpy")]
        Backend::SongnestPy(_) => {
            let db2 = s.db.clone();
            download_direct(s, &video_id, "music", &|p| {
                let _ = db2.lock().unwrap().execute(
                    "UPDATE downloads SET progress=?1, updated_at=strftime('%s','now') WHERE id=?2",
                    rusqlite::params![p as i64, job_id],
                );
            })
            .await
        }
    };
    let path = match dl_result {
        Ok(p) => p,
        Err(msg) => {
            if youtube_blocked(&msg) {
                *s.yt_cooldown_until.lock().unwrap() =
                    Some(Instant::now() + Duration::from_secs(5 * 60));
            }
            let msg: String = msg.chars().take(300).collect();
            set_job(&s.db, job_id, "error", 0, Some(&msg));
            return;
        }
    };
    // 4. cover + tag + library insert (same pipeline as the CLI)
    let cover = match s.http.get(&t.album.cover_big).send().await {
        Ok(r) => match r.bytes().await {
            Ok(b) => b,
            Err(_) => {
                set_job(&s.db, job_id, "error", 100, Some("cover fetch failed"));
                return;
            }
        },
        Err(_) => {
            set_job(&s.db, job_id, "error", 100, Some("cover fetch failed"));
            return;
        }
    };
    let title = t.title.clone();
    let artist = t.artist.name.clone();
    let album = t.album.title.clone();
    let duration = t.duration;
    let cover_url = t.album.cover_big.clone();
    let dz = t.id as i64;
    // keep the downloaded path (extension depends on backend mime) for the row below
    let lib_path = path.clone();
    let tag_ok = tokio::task::spawn_blocking(move || tag_file(&path, &t, &cover))
        .await
        .map(|r| r.is_ok())
        .unwrap_or(false);
    if !tag_ok {
        set_job(&s.db, job_id, "error", 100, Some("tagging failed"));
        return;
    }
    s.db
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO tracks (title, artist, album, duration, video_id, path, cover_url, deezer_id)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(video_id) DO UPDATE SET
               title=excluded.title, artist=excluded.artist, album=excluded.album,
               duration=excluded.duration, path=excluded.path,
               cover_url=excluded.cover_url, deezer_id=excluded.deezer_id",
            rusqlite::params![
                title, artist, album, duration as i64, video_id, lib_path, cover_url, dz
            ],
        )
        .ok();
    set_job(&s.db, job_id, "done", 100, None);
}

async fn download_worker(s: AppState) {
    loop {
        // atomic claim under one lock: oldest queued job becomes active
        let job: Option<(i64, u64)> = {
            let db = s.db.lock().unwrap();
            let next: Option<(i64, i64)> = db
                .query_row(
                    "SELECT id, deezer_id FROM downloads WHERE status='queued' ORDER BY queued_at LIMIT 1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .ok();
            match next {
                Some((id, dz)) => {
                    db.execute(
                        "UPDATE downloads SET status='active', updated_at=strftime('%s','now') WHERE id=?1",
                        [id],
                    )
                    .ok();
                    Some((id, dz as u64))
                }
                None => None,
            }
        };
        let Some((job_id, dzid)) = job else {
            tokio::time::sleep(Duration::from_secs(2)).await;
            continue;
        };
        // cooling down: put it back, wait it out, don't burn calls
        if let Some(secs) = cooled_down(&s) {
            set_job(&s.db, job_id, "queued", 0, None);
            tokio::time::sleep(Duration::from_secs(secs.min(60).max(5))).await;
            continue;
        }
        let _permit = s.dl_sem.acquire().await.unwrap();
        run_job(&s, job_id, dzid).await;
        // pause between downloads: never machine-gun YouTube
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

/// Enqueue a Deezer track for download. Fast: matching happens in the worker.
async fn enqueue(
    State(s): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let dzid: u64 = match q.get("dz").and_then(|v| v.parse().ok()) {
        Some(id) => id,
        None => return StatusCode::BAD_REQUEST.into_response(),
    };
    let db = s.db.lock().unwrap();
    // already in library?
    let in_lib: bool = db
        .query_row(
            "SELECT 1 FROM tracks WHERE deezer_id = ?1 LIMIT 1",
            [dzid as i64],
            |_| Ok(()),
        )
        .is_ok();
    if in_lib {
        return (StatusCode::CONFLICT, "already in library").into_response();
    }
    // already queued/active?
    let pending: bool = db
        .query_row(
            "SELECT 1 FROM downloads WHERE deezer_id = ?1 AND status IN ('queued','active') LIMIT 1",
            [dzid as i64],
            |_| Ok(()),
        )
        .is_ok();
    if pending {
        return (StatusCode::CONFLICT, "already queued").into_response();
    }
    db.execute(
        "INSERT INTO downloads (deezer_id, queued_at, updated_at)
         VALUES (?1, strftime('%s','now'), strftime('%s','now'))",
        [dzid as i64],
    )
    .ok();
    let id = db.last_insert_rowid();
    Json(serde_json::json!({"job": id})).into_response()
}

async fn downloads_list(State(s): State<AppState>) -> impl IntoResponse {
    let rows: Vec<serde_json::Value> = s
        .db
        .lock()
        .unwrap()
        .prepare("SELECT id, deezer_id, video_id, status, progress, COALESCE(error,'') FROM downloads ORDER BY queued_at DESC LIMIT 50")
        .map(|mut st| {
            st.query_map([], |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, i64>(0)?,
                    "deezer_id": r.get::<_, i64>(1)?,
                    "video_id": r.get::<_, String>(2)?,
                    "status": r.get::<_, String>(3)?,
                    "progress": r.get::<_, i64>(4)?,
                    "error": r.get::<_, String>(5)?,
                }))
            })
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
        })
        .unwrap_or_default();
    Json(rows)
}

async fn queue_page(State(s): State<AppState>) -> impl IntoResponse {
    let rows: Vec<(i64, i64, String, String, i64, String)> = s
        .db
        .lock()
        .unwrap()
        .prepare("SELECT id, deezer_id, video_id, status, progress, COALESCE(error,'') FROM downloads ORDER BY queued_at DESC LIMIT 50")
        .map(|mut st| {
            st.query_map([], |r| {
                Ok((
                    r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?,
                ))
            })
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
        })
        .unwrap_or_default();
    let mut items = String::new();
    for (id, dz, vid, status, prog, err) in &rows {
        items.push_str(&format!(
            "<li>#{id} dz={dz} yt={vid} [{status}] {prog}% {err}</li>",
            id = id,
            dz = dz,
            vid = esc(vid),
            status = esc(status),
            prog = prog,
            err = esc(err),
        ));
    }
    if items.is_empty() {
        items = "<li>(queue empty)</li>".to_string();
    }
    axum::response::Html(format!("<h1>download queue</h1><ul>{items}</ul><p><a href=\"/\">back</a></p>"))
}

/// Suggested songs: Deezer global chart, top 10.
async fn api_suggest(State(s): State<AppState>) -> impl IntoResponse {
    #[derive(Deserialize)]
    struct Chart {
        tracks: DzSearch,
    }
    let Ok(resp) = s.http.get("https://api.deezer.com/chart").send().await
    else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let Ok(chart): Result<Chart, _> = resp.json().await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    Json(
        chart
            .tracks
            .data
            .iter()
            .take(10)
            .map(|t| {
                serde_json::json!({
                    "dz": t.id,
                    "title": t.title,
                    "artist": t.artist.name,
                    "album": t.album.title,
                    "duration": t.duration,
                    "cover": t.album.cover_big,
                })
            })
            .collect::<Vec<_>>(),
    )
    .into_response()
}

#[derive(Deserialize)]
struct LikeBody {
    key: String,
    title: String,
    artist: String,
    #[serde(default)]
    album: String,
    #[serde(default)]
    cover: String,
}

async fn api_likes(State(s): State<AppState>) -> impl IntoResponse {
    let rows: Vec<serde_json::Value> = s
        .db
        .lock()
        .unwrap()
        .prepare("SELECT key, title, artist, album, cover FROM liked ORDER BY liked_at DESC")
        .map(|mut st| {
            st.query_map([], |r| {
                Ok(serde_json::json!({
                    "key": r.get::<_, String>(0)?,
                    "title": r.get::<_, String>(1)?,
                    "artist": r.get::<_, String>(2)?,
                    "album": r.get::<_, String>(3)?,
                    "cover": r.get::<_, String>(4)?,
                }))
            })
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
        })
        .unwrap_or_default();
    Json(rows)
}

async fn api_like(
    State(s): State<AppState>,
    Json(b): Json<LikeBody>,
) -> impl IntoResponse {
    if b.key.trim().is_empty() || b.title.trim().is_empty() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    s.db
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO liked (key, title, artist, album, cover, liked_at)
             VALUES (?1,?2,?3,?4,?5,strftime('%s','now'))
             ON CONFLICT(key) DO UPDATE SET
               title=excluded.title, artist=excluded.artist,
               album=excluded.album, cover=excluded.cover",
            rusqlite::params![b.key, b.title, b.artist, b.album, b.cover],
        )
        .ok();
    Json(serde_json::json!({"liked": true})).into_response()
}

async fn api_unlike(
    State(s): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    match q.get("key") {
        Some(k) => {
            s.db
                .lock()
                .unwrap()
                .execute("DELETE FROM liked WHERE key = ?1", [k])
                .ok();
            Json(serde_json::json!({"liked": false})).into_response()
        }
        None => StatusCode::BAD_REQUEST.into_response(),
    }
}

/// DELETE /api/track/:id — delete a downloaded track: audio file, library
/// row, and its `db:<id>` like (the song is gone, so the like goes too).
/// Queue/match history is left alone (re-download reuses the match).
async fn api_delete_track(
    State(s): State<AppState>,
    Path(id): Path<i64>,
) -> impl IntoResponse {
    let path: Option<String> = s
        .db
        .lock()
        .unwrap()
        .query_row("SELECT path FROM tracks WHERE id = ?1", [id], |r| r.get(0))
        .ok();
    let Some(path) = path else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let _ = std::fs::remove_file(&path);
    {
        let db = s.db.lock().unwrap();
        db.execute("DELETE FROM tracks WHERE id = ?1", [id]).ok();
        db.execute("DELETE FROM liked WHERE key = ?1", [format!("db:{id}")])
            .ok();
    }
    StatusCode::NO_CONTENT.into_response()
}

/// POST /api/auth/device — retired (its OAuth device flow is gone; auth is
/// via cookies.txt). Kept as a route so older frontends fail cleanly.
async fn api_auth_device(State(_s): State<AppState>) -> impl IntoResponse {
    (
        StatusCode::CONFLICT,
        "device sign-in is retired; auth is via cookies.txt",
    )
        .into_response()
}

/// GET /api/auth/status — retired; always 410 Gone.
async fn api_auth_status(State(_s): State<AppState>) -> impl IntoResponse {
    (StatusCode::GONE, "device sign-in is retired").into_response()
}

/// POST /api/auth/logout — retired; always 410 Gone.
async fn api_auth_logout(State(_s): State<AppState>) -> impl IntoResponse {
    (StatusCode::GONE, "device sign-in is retired").into_response()
}

/// GET /api/cookies — whether a cookies.txt is installed.
async fn api_cookies_status() -> impl IntoResponse {
    let present = std::fs::metadata("cookies.txt")
        .map(|m| m.len() > 0)
        .unwrap_or(false);
    Json(serde_json::json!({ "present": present }))
}

/// POST /api/cookies — install a cookies.txt (same file the desktop reads
/// from its data dir). Body is the raw Netscape-format export: paste it
/// from the browser extension while logged into YouTube. Validated
/// strictly — yt-dlp ignores malformed jars silently, which looks exactly
/// like being throttled.
async fn api_cookies_install(body: String) -> impl IntoResponse {
    if body.len() > 1024 * 1024 {
        return (StatusCode::PAYLOAD_TOO_LARGE, "cookies file too large").into_response();
    }
    let mut lines = body.lines().filter(|l| !l.trim().is_empty());
    let header = lines.next().unwrap_or("");
    let ok_header =
        header.starts_with("# Netscape HTTP Cookie File") || header.starts_with("# HTTP Cookie File");
    let ok_body = body.contains("youtube.com") && body.lines().any(|l| {
        let l = l.trim();
        !l.starts_with('#') && l.split('\t').count() >= 6
    });
    if !(ok_header && ok_body) {
        return (
            StatusCode::BAD_REQUEST,
            "not a Netscape cookie export (need the '# Netscape HTTP Cookie File' header and youtube.com rows)",
        )
            .into_response();
    }
    if std::fs::write("cookies.txt", body).is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not write cookies.txt",
        )
            .into_response();
    }
    Json(serde_json::json!({ "ok": true, "cookies": true })).into_response()
}

/// JSON API for the React frontend.
async fn api_library(State(s): State<AppState>) -> impl IntoResponse {
    let rows: Vec<serde_json::Value> = s
        .db
        .lock()
        .unwrap()
        .prepare("SELECT id, title, artist, album, duration, video_id, COALESCE(cover_url,''), COALESCE(deezer_id,0) FROM tracks ORDER BY id")
        .map(|mut st| {
            st.query_map([], |r| {
                let id: i64 = r.get(0)?;
                Ok(serde_json::json!({
                    "id": id,
                    "title": r.get::<_, String>(1)?,
                    "artist": r.get::<_, String>(2)?,
                    "album": r.get::<_, String>(3)?,
                    "duration": r.get::<_, i64>(4)?,
                    "video_id": r.get::<_, String>(5)?,
                    "cover": r.get::<_, String>(6)?,
                    "deezer_id": r.get::<_, i64>(7)?,
                    "stream": format!("/track/{id}"),
                    "cover_url": format!("/cover/{id}"),
                }))
            })
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
        })
        .unwrap_or_default();
    Json(rows)
}

async fn api_search(
    State(s): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let query = q.get("q").cloned().unwrap_or_default();
    if query.trim().is_empty() {
        return Json(Vec::<serde_json::Value>::new()).into_response();
    }
    let Ok(resp) = s
        .http
        .get("https://api.deezer.com/search")
        .query(&[("q", &query)])
        .send()
        .await
    else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let Ok(res): Result<DzSearch, _> = resp.json().await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    Json(
        res.data
            .iter()
            .take(5)
            .map(|t| {
                serde_json::json!({
                    "dz": t.id,
                    "title": t.title,
                    "artist": t.artist.name,
                    "album": t.album.title,
                    "duration": t.duration,
                    "cover": t.album.cover_big,
                })
            })
            .collect::<Vec<_>>(),
    )
    .into_response()
}

/// Resolve one exact Deezer track to playable audio (cached match first).
async fn api_resolve(
    State(s): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let dzid: u64 = match q.get("dz").and_then(|v| v.parse().ok()) {
        Some(id) => id,
        None => return StatusCode::BAD_REQUEST.into_response(),
    };
    let cooling = cooled_down(&s);
    if cooling.is_some() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "YouTube cooling down — retry shortly",
        )
            .into_response();
    }
    let Ok(resp) = s
        .http
        .get(format!("https://api.deezer.com/track/{dzid}"))
        .send()
        .await
    else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let Ok(t): Result<DzTrack, _> = resp.json().await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let fresh = q.get("fresh").map(|v| v == "1").unwrap_or(false);
    // Full song only: when YouTube has no match we 404 instead of handing
    // out the 30s Deezer preview. Previews don't play in the Android
    // WebView and the app promises full tracks, so never fall back to them.
    match youtube_match(&s.downloader, &s.backend, &s.db, &t, fresh).await {
        Some((video_id, _)) => Json(serde_json::json!({
            "dz": t.id,
            "title": t.title,
            "artist": t.artist.name,
            "album": t.album.title,
            "duration": t.duration,
            "cover": t.album.cover_big,
            "video_id": video_id,
            "stream": format!("/stream/{video_id}"),
        }))
        .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// GET /api/downloader — full downloader status for diagnostics.
async fn api_downloader(State(s): State<AppState>) -> impl IntoResponse {
    let v = s.downloader.read(|d| {
        serde_json::json!({
            "backend": s.backend.name(),
            "binary_source": d.binary_source,
            "path": d.binary_path,
            "version": d.version,
            "latest_known_version": d.latest,
            "update_available": d.update_available,
            "last_check_at": d.last_check_at,
            "last_update_at": d.last_update_at,
            "health": d.health,
            "last_error": d.last_error,
            "ffmpeg": d.ffmpeg,
            "js_runtimes": d.runtimes,
            "js_runtime_in_use": d.runtime_in_use,
            "js_runtime_setting": d.runtime_setting,
            "ejs_available": d.ejs_available,
            "ejs_note": d.ejs_note,
        })
    });
    Json(v)
}

/// POST /api/downloader/recheck — run one health probe now, no update.
async fn api_downloader_recheck(State(s): State<AppState>) -> impl IntoResponse {
    health_check_once(&s).await;
    api_downloader(State(s)).await.into_response()
}

/// POST /api/downloader/update — run the update flow now.
async fn api_downloader_update(State(s): State<AppState>) -> impl IntoResponse {
    if !matches!(s.backend, Backend::YtDlp) {
        return (
            StatusCode::CONFLICT,
            "songnestpy backend: no binary to update",
        )
            .into_response();
    }
    let outcome = run_update(&s).await;
    // refresh health once after the attempt (no further side effects)
    health_check_once(&s).await;
    let _ = outcome;
    api_downloader(State(s)).await.into_response()
}

#[derive(Deserialize)]
struct RuntimeSettingBody {
    setting: String,
}

/// POST /api/downloader/runtime {"setting": "auto|deno|node|bun|quickjs[":/path]"}
async fn api_downloader_runtime(
    State(s): State<AppState>,
    Json(b): Json<RuntimeSettingBody>,
) -> impl IntoResponse {
    let (setting, setting_path) = parse_runtime_setting(&b.setting);
    if setting != "auto"
        && !["deno", "node", "bun", "quickjs"].contains(&setting.as_str())
    {
        return (
            StatusCode::BAD_REQUEST,
            "setting must be auto|deno|node|bun|quickjs",
        )
            .into_response();
    }
    if std::fs::write("js_runtime.txt", &b.setting).is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not persist setting",
        )
            .into_response();
    }
    {
        let mut d = s.downloader.inner.write().unwrap();
        d.runtime_setting = setting;
        d.setting_path = setting_path;
    }
    // re-detect against the new setting (cheap, local probes only)
    let runtimes = {
        let (setting, path) = s
            .downloader
            .read(|d| (d.runtime_setting.clone(), d.setting_path.clone()));
        detect_runtimes(path.map(|(_, p)| {
            (
                setting.split(':').next().unwrap_or("auto").to_string(),
                p,
            )
        }))
        .await
    };
    s.downloader.inner.write().unwrap().runtimes = runtimes;
    api_downloader(State(s)).await.into_response()
}

async fn health(State(s): State<AppState>) -> impl IntoResponse {
    let d = s.downloader.read(|d| {
        (
            d.version.clone(),
            d.latest.clone(),
            d.update_available,
        )
    });
    let (ver, latest, update_available) = d;
    let depth: i64 = s
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM downloads WHERE status IN ('queued','active')",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    // "Signed in" == a cookies.txt is present (songnestpy hands it to
    // yt-dlp); desktop yt-dlp reads its own cookie args the same way.
    #[cfg(feature = "songnestpy")]
    let authed = matches!(&s.backend, Backend::SongnestPy(ex) if ex.is_logged_in());
    #[cfg(not(feature = "songnestpy"))]
    let authed = false;
    Json(serde_json::json!({
        "backend": s.backend.name(),
        "authed": authed,
        "yt_dlp": ver,
        "latest_release": latest,
        "update_available": update_available,
        "queue_depth": depth,
        "cooldown_secs": cooled_down(&s).unwrap_or(0),
    }))
}

/// Wait for zero in-flight calls, up to 10 minutes. False = timed out
/// (updater skips the cycle and tries again in 24h).
async fn wait_idle(dl: &DownloaderState) -> bool {
    let start = Instant::now();
    loop {
        let n = dl.read(|d| d.active);
        if n == 0 {
            return true;
        }
        if start.elapsed() > Duration::from_secs(600) {
            return false;
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

/// Verify downloaded bytes against a SHA2-256SUMS-style listing.
/// Refuses (Err) on missing entry or mismatch.
fn verify_checksum(
    bytes: &[u8],
    sums_text: &str,
    asset_name: &str,
) -> Result<(), String> {
    let expect = sums_text.lines().find_map(|l| {
        let mut it = l.split_whitespace();
        let (hash, name) = (it.next()?, it.next()?);
        (name.trim_start_matches('*') == asset_name).then(|| hash.to_string())
    });
    match expect {
        None => Err("checksum file has no entry for the asset; refusing to install".to_string()),
        Some(expect) => {
            use sha2::{Digest, Sha256};
            let mut h = Sha256::new();
            h.update(bytes);
            if hex::encode(h.finalize()) == expect.to_lowercase() {
                Ok(())
            } else {
                Err("checksum mismatch; refusing to install".to_string())
            }
        }
    }
}

/// Atomically swap tmp into dest (keeping .bak), with rollback.
/// `probe` answers whether a file is a working binary.
fn swap_binary(
    tmp: &std::path::Path,
    dest: &std::path::Path,
    probe: &dyn Fn(&std::path::Path) -> bool,
) -> Result<(), String> {
    if !probe(tmp) {
        let _ = std::fs::remove_file(tmp);
        return Err("downloaded binary failed --version; discarded".to_string());
    }
    let had_previous = dest.exists();
    let bak = dest.with_extension("bak");
    if had_previous {
        let _ = std::fs::remove_file(&bak);
        if std::fs::rename(dest, &bak).is_err() {
            let _ = std::fs::remove_file(tmp);
            return Err("could not stage previous binary".to_string());
        }
    }
    if std::fs::rename(tmp, dest).is_err() {
        if had_previous {
            let _ = std::fs::rename(&bak, dest);
        }
        return Err("install rename failed; previous copy restored".to_string());
    }
    if !probe(dest) {
        let _ = std::fs::remove_file(dest);
        if had_previous {
            let _ = std::fs::rename(&bak, dest);
        }
        return Err("installed binary failed --version; rolled back".to_string());
    }
    Ok(())
}

fn install_path() -> std::path::PathBuf {
    managed_bin_path()
}

/// Download + verify + atomically install a managed yt-dlp copy.
/// Returns a human-readable outcome. Never touches PATH installs.
async fn run_update(s: &AppState) -> String {
    let http = &s.http;
    let dl = &s.downloader;
    let rel: serde_json::Value = match tokio::time::timeout(
        Duration::from_secs(15),
        http
            .get("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest")
            .header("User-Agent", "songnest")
            .send(),
    )
    .await
    {
        Ok(Ok(r)) => match r.json().await {
            Ok(j) => j,
            Err(e) => return format!("release metadata unreadable: {e}"),
        },
        _ => {
            return "offline or GitHub unreachable".to_string();
        }
    };
    let assets = rel
        .get("assets")
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();
    let by_name = |n: &str| {
        assets.iter().find_map(|a| {
            (a.get("name").and_then(|v| v.as_str()) == Some(n))
                .then(|| a.get("browser_download_url").and_then(|u| u.as_str()))
                .flatten()
                .map(|u| u.to_string())
        })
    };
    // asset names verified against the live release asset list
    let want_asset = if cfg!(windows) {
        "yt-dlp.exe"
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "yt-dlp_macos"
        } else {
            "yt-dlp_macos_legacy"
        }
    } else if cfg!(target_arch = "aarch64") {
        "yt-dlp_linux_aarch64"
    } else {
        "yt-dlp_linux"
    };
    let Some(asset_url) = by_name(want_asset) else {
        return format!("release has no asset named {want_asset}");
    };
    let Some(sums_url) = by_name("SHA2-256SUMS") else {
        return "release is missing SHA2-256SUMS; refusing to install".to_string();
    };
    async fn get_bytes(http: &reqwest::Client, url: &str) -> Option<Vec<u8>> {
        let resp = tokio::time::timeout(
            Duration::from_secs(300),
            http.get(url).header("User-Agent", "songnest").send(),
        )
        .await
        .ok()?
        .ok()?;
        let resp = resp.error_for_status().ok()?;
        resp.bytes().await.ok().map(|b| b.to_vec())
    }
    let (sums, bytes) = tokio::join!(
        get_bytes(http, &sums_url),
        get_bytes(http, &asset_url)
    );
    let (Some(sums), Some(bytes)) = (sums, bytes) else {
        return "download failed".to_string();
    };
    let sums = String::from_utf8_lossy(&sums);
    if let Err(e) = verify_checksum(&bytes, &sums, want_asset) {
        return e;
    }
    let dest = install_path();
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // never swap under running jobs
    if !wait_idle(dl).await {
        return "downloads in progress; update skipped, will retry in 24h".to_string();
    }
    let tmp = dest.with_extension("new");
    if std::fs::write(&tmp, &bytes).is_err() {
        return "could not write temp file".to_string();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
    }
    // Windows: cannot overwrite a running exe -> rename aside first
    #[cfg(windows)]
    {
        if dest.exists() {
            let _ = std::fs::rename(&dest, dest.with_extension("old"));
        }
    }
    let probe = |p: &std::path::Path| {
        std::process::Command::new(p)
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    };
    if let Err(e) = swap_binary(&tmp, &dest, &probe) {
        return e;
    }
    // re-detect against the fresh binary
    let fresh = init_downloader().await;
    let (version, ejs, note) = fresh.read(|d| {
        (
            d.version.clone(),
            d.ejs_available,
            d.ejs_note.clone(),
        )
    });
    {
        let mut d = dl.inner.write().unwrap();
        d.binary_path = dest.to_string_lossy().into_owned();
        d.binary_source = "managed".to_string();
        d.version = version;
        d.ejs_available = ejs;
        d.ejs_note = note;
        d.latest = None;
        d.update_available = false;
        d.last_check_at = now_unix();
        d.last_update_at = Some(now_unix());
        d.health = Health::Unknown;
        d.last_error.clear();
    }
    "updated to the managed copy".to_string()
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// One update-check cycle: compare installed vs latest, update when a
/// managed copy exists and something newer is out.
async fn update_cycle(s: &AppState) {
    let (has_managed, current) = s.downloader.read(|d| {
        (
            d.binary_source == "managed" && !d.binary_path.is_empty(),
            d.version.clone(),
        )
    });
    let latest: Option<String> = fetch_latest_tag(&s.http).await;
    {
        let mut d = s.downloader.inner.write().unwrap();
        d.latest = latest.clone();
        d.last_check_at = now_unix();
        d.update_available = match (&latest, current.is_empty()) {
            (Some(l), false) => {
                cmp_date_version(l.trim_start_matches(|c: char| !c.is_ascii_alphanumeric()), &current)
                    == std::cmp::Ordering::Greater
            }
            _ => false,
        };
    }
    if has_managed && s.downloader.read(|d| d.update_available) {
        let outcome = run_update(s).await;
        s.downloader.inner.write().unwrap().last_error = outcome;
    }
}

async fn fetch_latest_tag(http: &reqwest::Client) -> Option<String> {
    let r = tokio::time::timeout(
        Duration::from_secs(15),
        http
            .get("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest")
            .header("User-Agent", "songnest")
            .send(),
    )
    .await
    .ok()?
    .ok()?;
    let j: serde_json::Value = r.json().await.ok()?;
    j.get("tag_name")
        .and_then(|v| v.as_str())
        .map(|t| t.to_string())
}

/// Health probe: resolve the stable test video, classify the failure.
/// Order: offline -> rate_limited -> js_runtime_missing -> outdated.
/// Only Outdated triggers an update attempt (then exactly one re-check).
/// Backend-agnostic health probe: fetch a playable URL for the stable test
/// video. yt-dlp runs `-g`; SongnestPy resolves on-device.
async fn probe_fetch(s: &AppState) -> anyhow::Result<String> {
    match &s.backend {
        Backend::YtDlp => {
            let YtDlpCall { mut cmd, _guard } = ytdlp_command(&s.downloader)?;
            let out = cmd
                .args(cookie_args())
                .args(["-g", "https://youtube.com/watch?v=jNQXAC9IVRw"])
                .output()
                .await?;
            anyhow::ensure!(out.status.success(), "yt-dlp probe failed");
            let url = String::from_utf8(out.stdout)?
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            anyhow::ensure!(!url.is_empty(), "yt-dlp probe returned empty url");
            Ok(url)
        }
        #[cfg(feature = "songnestpy")]
        Backend::SongnestPy(ex) => {
            let st = ex
                .resolve("jNQXAC9IVRw")
                .await
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            anyhow::ensure!(!st.url.is_empty(), "songnestpy probe returned empty url");
            Ok(st.url)
        }
    }
}

async fn health_check(s: &AppState) {
    // fast path: no runtime at all and none configured (yt-dlp only —
    // songnestpy runs yt-dlp on-device and needs no JS runtime)
    let runtimes_empty = matches!(s.backend, Backend::YtDlp)
        && s.downloader.read(|d| {
            d.runtimes.iter().all(|r| !r.supported)
        });
    let probe = tokio::time::timeout(Duration::from_secs(60), probe_fetch(s)).await;
    let (health, err) = match probe {
        Err(_) => (Health::Offline, "probe timed out (offline?)".to_string()),
        Ok(Err(e)) => {
            let msg = e.to_string();
            if msg.contains("no yt-dlp binary") {
                (Health::Outdated, msg)
            } else if youtube_blocked(&msg) {
                (Health::RateLimited, msg)
            } else if matches!(s.backend, Backend::YtDlp) {
                (classify_failure(&msg, false), msg)
            } else {
                (Health::Offline, msg)
            }
        }
        Ok(Ok(_)) => (Health::Ok, String::new()),
    };
    // no supported runtime + failing probe that smells like it -> that state
    let health = if runtimes_empty && health != Health::Ok {
        Health::JsRuntimeMissing
    } else {
        health
    };
    {
        let mut d = s.downloader.inner.write().unwrap();
        d.health = health;
        d.last_error = err;
    }
    if health == Health::Outdated {
        let outcome = run_update(s).await;
        {
            let mut d = s.downloader.inner.write().unwrap();
            if !outcome.starts_with("updated") && !outcome.starts_with("offline") {
                d.last_error = outcome;
            }
        }
        // exactly one re-check after the attempt
        health_check_once(s).await;
    }
}

/// Single health probe without update side effects (used for re-check).
async fn health_check_once(s: &AppState) {
    let probe = tokio::time::timeout(Duration::from_secs(60), probe_fetch(s)).await;
    let (health, err) = match probe {
        Err(_) => (Health::Offline, "probe timed out (offline?)".to_string()),
        Ok(Err(e)) => {
            let msg = e.to_string();
            if youtube_blocked(&msg) {
                (Health::RateLimited, msg)
            } else if matches!(s.backend, Backend::YtDlp) {
                (classify_failure(&msg, false), msg)
            } else {
                (Health::Offline, msg)
            }
        }
        Ok(Ok(_)) => (Health::Ok, String::new()),
    };
    let mut d = s.downloader.inner.write().unwrap();
    d.health = health;
    d.last_error = err;
}

async fn run_downloader_tasks(s: AppState) {
    // startup: check, then health
    // (self-update only makes sense for the yt-dlp binary backend)
    if matches!(s.backend, Backend::YtDlp) {
        update_cycle(&s).await;
    }
    health_check(&s).await;
    // 24h loop
    loop {
        tokio::time::sleep(Duration::from_secs(24 * 3600)).await;
        if matches!(s.backend, Backend::YtDlp) {
            update_cycle(&s).await;
        }
        health_check(&s).await;
    }
}

/// Port for the HTTP server. SONGNEST_PORT overrides the default 8787
/// (lets two backends run side by side for comparison).
pub fn port_from_env() -> u16 {
    std::env::var("SONGNEST_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8787)
}

/// Run the full server: library DB, queue workers, downloader tasks, HTTP
/// routes. `data_dir` (library.db/music/cookies.txt/backend caches) becomes
/// the process cwd first — same as `serve --data-dir`. Callable from the
/// CLI or embedded (Tauri mobile runs this in-process on localhost).
pub async fn run(
    data_dir: Option<String>,
    backend: Backend,
    port: u16,
) -> anyhow::Result<()> {
    if let Some(dir) = data_dir {
        std::fs::create_dir_all(&dir)?;
        std::env::set_current_dir(&dir)?;
        eprintln!("songnest data dir: {dir}");
    }
    serve(backend, port).await
}

async fn serve(backend: Backend, port: u16) -> anyhow::Result<()> {
    let conn = rusqlite::Connection::open("library.db")?;
    ensure_schema(&conn)?;
    let db: Db = Arc::new(Mutex::new(conn));
    let downloader = init_downloader().await;
    // cwd is the data dir here (run() chdirs first): backend caches land
    // next to library.db.
    eprintln!("songnest backend: {}", backend.name());
    let state = AppState {
        db,
        http: reqwest::Client::new(),
        backend,
        urls: Arc::new(Mutex::new(HashMap::new())),
        resolve_lock: Arc::new(tokio::sync::Mutex::new(())),
        dl_sem: Arc::new(tokio::sync::Semaphore::new(2)),
        yt_cooldown_until: Arc::new(Mutex::new(None)),
        last_media: Arc::new(tokio::sync::Mutex::new(None)),
        downloader,
    };
    // two queue workers = max 2 concurrent downloads, ever
    tokio::spawn(download_worker(state.clone()));
    tokio::spawn(download_worker(state.clone()));
    // cookies.txt (when pushed to the data dir) flips yt-dlp to
    // authenticated requests — log it so logcat shows the mode.
    #[cfg(feature = "songnestpy")]
    if let Backend::SongnestPy(ex) = &state.backend {
        if ex.is_logged_in() {
            eprintln!("songnest: cookies.txt active, yt-dlp runs authenticated");
        }
    }
    // downloader updater loop + health checks are spawned by run_downloader_tasks()
    tokio::spawn(run_downloader_tasks(state.clone()));
    let app = Router::new()
        .route("/", get(index))
        .route("/track/:id", get(track))
        .route("/stream/:id", get(stream))
        .route("/cover/:id", get(cover))
        .route("/player/:id", get(player))
        .route("/s/:id", get(stream_player))
        .route("/d", get(dplayer))
        .route("/dplay", get(dplay))
        .route("/queue", get(queue_page))
        .route("/api/enqueue", post(enqueue))
        .route("/api/downloads", get(downloads_list))
        .route("/api/health", get(health))
        .route("/api/downloader", get(api_downloader))
        .route("/api/downloader/update", post(api_downloader_update))
        .route("/api/downloader/recheck", post(api_downloader_recheck))
        .route("/api/downloader/runtime", post(api_downloader_runtime))
        .route("/api/suggest", get(api_suggest))
        .route("/api/likes", get(api_likes))
        .route("/api/like", post(api_like).delete(api_unlike))
        .route("/api/track/:id", delete(api_delete_track))
        .route("/api/auth/device", post(api_auth_device))
        .route("/api/auth/status", get(api_auth_status))
        .route("/api/auth/logout", post(api_auth_logout))
        .route("/api/cookies", get(api_cookies_status).post(api_cookies_install))
        .route("/api/library", get(api_library))
        .route("/api/search", get(api_search))
        .route("/api/resolve", get(api_resolve))
        .layer(CorsLayer::very_permissive())
        .with_state(state);
    // LAN binding so phones on the same WiFi can reach the API/QrReader
    // (localhost-only would refuse them). Loopback still works locally.
    eprintln!("songnest listening on 0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

async fn index(State(s): State<AppState>) -> impl IntoResponse {
    let rows: Vec<(i64, String, String, String, String)> = s
        .db
        .lock()
        .unwrap()
        .prepare(
            "SELECT id, title, artist, video_id, COALESCE(cover_url,'') FROM tracks ORDER BY id",
        )
        .map(|mut st| {
            st.query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
        })
        .unwrap_or_default();
    let mut items = String::new();
    for (id, title, artist, _vid, cover) in &rows {
        // Deezer cover only: embedded art first, stored Deezer CDN url as fallback
        let fallback = if cover.is_empty() {
            "this.style.display='none'".to_string()
        } else {
            format!("this.src='{}'", esc(cover))
        };
        items.push_str(&format!(
            "<li><img src=\"/cover/{id}\" width=\"64\" height=\"64\" style=\"vertical-align:middle\" \
             onerror=\"{fallback}\"> \
             <a href=\"/player/{id}\">{artist} - {title}</a></li>",
            id = id,
            fallback = fallback,
            artist = esc(artist),
            title = esc(title),
        ));
    }
    if items.is_empty() {
        items = "<li>(empty library)</li>".to_string();
    }
    axum::response::Html(format!(
        "<h1>songnest</h1>\
         <form action=\"/d\"><input name=\"q\" placeholder=\"artist title\" size=\"30\"><button>stream from Deezer</button></form>\
         <ul>{items}</ul>\
         <p>Undownloaded test: <a href=\"/s/jNQXAC9IVRw\">/s/jNQXAC9IVRw</a> (19s, remote proxy)</p>"
    ))
}

async fn player(State(s): State<AppState>, Path(id): Path<i64>) -> impl IntoResponse {
    let row: Option<(String, String, String, String, String)> = s
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT title, artist, album, video_id, COALESCE(cover_url,'') FROM tracks WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .ok();
    let Some((title, artist, album, vid, cover)) = row else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Deezer cover only: embedded art first, stored Deezer CDN url as fallback
    let fallback = if cover.is_empty() {
        "this.style.display='none'".to_string()
    } else {
        format!("this.src='{}'", esc(&cover))
    };
    axum::response::Html(format!(
        r#"\
<h1>{artist} - {title}</h1>
<p>{album} (db id {id}, yt {vid})</p>
<img src="/cover/{id}" width="300" onerror="{fallback}">
<br><br>
<audio controls preload="metadata" src="/track/{id}" style="width:300px"></audio>
<br>
<button onclick="document.querySelector('audio').currentTime=0">seek 0%</button>
<button onclick="let a=document.querySelector('audio');a.currentTime=a.duration*0.5">seek 50%</button>
<button onclick="let a=document.querySelector('audio');a.currentTime=Math.max(0,a.duration-5)">seek end-5s</button>
<pre id="log"></pre>
<script>
const a=document.querySelector('audio'),l=document.getElementById('log');
for(const e of ['seeking','seeked','timeupdate','loadedmetadata','error'])
  a.addEventListener(e,()=>l.textContent+=e+' t='+a.currentTime.toFixed(1)+'/'+(isNaN(a.duration)?'?':a.duration.toFixed(1))+'\n');
</script>
<p><a href="/">back</a></p>"#,
        artist = esc(&artist),
        title = esc(&title),
        album = esc(&album),
        vid = esc(&vid),
        id = id,
        fallback = fallback,
    ))
    .into_response()
}

/// Best-effort Deezer cover for a bare YouTube id: yt title -> Deezer search.
/// Returns None when the video has no Deezer match (e.g. non-music videos).
async fn deezer_cover_for_youtube(s: &AppState, video_id: &str) -> Option<String> {
    let YtDlpCall { mut cmd, _guard } = ytdlp_command(&s.downloader).ok()?;
    let out = cmd
        .args(cookie_args())
        .args([
            "--get-title",
            "--no-playlist",
            &format!("https://youtube.com/watch?v={video_id}"),
        ])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let title = String::from_utf8(out.stdout)
        .ok()?
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if title.is_empty() {
        return None;
    }
    let res: DzSearch = s.http
        .get("https://api.deezer.com/search")
        .query(&[("q", &title)])
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    Some(res.data.first()?.album.cover_big.clone())
}

async fn stream_player(State(s): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    let vid = esc(&id);
    // 1. song metadata first: exact Deezer cover stored at download time
    let db_cover: Option<String> =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT cover_url FROM tracks WHERE video_id = ?1",
                [&id],
                |r| r.get(0),
            )
            .ok()
            .flatten();
    // 2. fallback: YouTube title -> Deezer search
    let cover = match db_cover.filter(|c| !c.is_empty()) {
        Some(c) => Some(c),
        None => deezer_cover_for_youtube(&s, &id).await,
    };
    let img = match cover {
        Some(url) => format!("<img src=\"{}\" width=\"300\">", esc(&url)),
        None => "<div style=\"width:300px;height:300px;background:#222;color:#fff;display:flex;align-items:center;justify-content:center\">no Deezer cover</div>".to_string(),
    };
    axum::response::Html(format!(
        r#"\
<h1>stream {vid}</h1>
{img}
<br><br>
<audio controls preload="metadata" src="/stream/{vid}" style="width:300px"></audio>
<br>
<button onclick="document.querySelector('audio').currentTime=0">seek 0%</button>
<button onclick="let a=document.querySelector('audio');a.currentTime=(a.duration||10)*0.5">seek 50%</button>
<pre id="log"></pre>
<script>
const a=document.querySelector('audio'),l=document.getElementById('log');
for(const e of ['seeking','seeked','timeupdate','loadedmetadata','error'])
  a.addEventListener(e,()=>l.textContent+=e+' t='+a.currentTime.toFixed(1)+'/'+(isNaN(a.duration)?'?':a.duration.toFixed(1))+'\n');
</script>"#,
        vid = vid,
        img = img,
    ))
}

/// Deezer-first search: same-name songs need a human pick, so list the
/// top candidates with their exact metadata instead of auto-playing #1.
async fn dplayer(
    State(s): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let query = q.get("q").cloned().unwrap_or_default();
    if query.trim().is_empty() {
        return axum::response::Html(
            "<form action=\"/d\"><input name=\"q\" placeholder=\"artist title\" size=\"30\"><button>stream from Deezer</button></form>"
                .to_string(),
        )
        .into_response();
    }
    let Ok(resp) = s
        .http
        .get("https://api.deezer.com/search")
        .query(&[("q", &query)])
        .send()
        .await
    else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let Ok(res): Result<DzSearch, _> = resp.json().await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    if res.data.is_empty() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let mut items = String::new();
    for t in res.data.iter().take(5) {
        items.push_str(&format!(
            "<li><img src=\"{cover}\" width=\"64\" height=\"64\" style=\"vertical-align:middle\"> \
             <a href=\"/dplay?dz={id}\">{artist} - {title}</a> \
             <small>{album} ({dur}s)</small></li>",
            id = t.id,
            cover = esc(&t.album.cover_big),
            artist = esc(&t.artist.name),
            title = esc(&t.title),
            album = esc(&t.album.title),
            dur = t.duration,
        ));
    }
    axum::response::Html(format!(
        "<h1>pick the song for \"{q}\"</h1><ul>{items}</ul><p><a href=\"/\">back</a></p>",
        q = esc(&query),
        items = items,
    ))
    .into_response()
}

/// Play one exact Deezer track: its metadata + cover, YouTube audio
/// matched with artist-aware scoring. Nothing is downloaded or stored.
async fn dplay(
    State(s): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let dzid: u64 = match q.get("dz").and_then(|v| v.parse().ok()) {
        Some(id) => id,
        None => return StatusCode::BAD_REQUEST.into_response(),
    };
    let Ok(resp) = s
        .http
        .get(format!("https://api.deezer.com/track/{dzid}"))
        .send()
        .await
    else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let Ok(t): Result<DzTrack, _> = resp.json().await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    // Cached match first (`?fresh=1` forces a new YouTube search).
    // Cooling down -> preview with a cooldown note, no burnt calls.
    // No match (or YouTube unreachable) -> 30s preview fallback.
    let fresh = q.get("fresh").map(|v| v == "1").unwrap_or(false);
    let cooling = cooled_down(&s);
    let vid: Option<String> = if cooling.is_some() {
        None
    } else {
        youtube_match(&s.downloader, &s.backend, &s.db, &t, fresh).await.map(|(v, _)| v)
    };
    let (audio_src, note) = match (vid, cooling) {
        (Some(v), _) => (
            format!("/stream/{v}"),
            "Deezer match, not downloaded".to_string(),
        ),
        (None, Some(secs)) => (
            t.preview.clone(),
            format!("YouTube cooling down ({secs}s) — 30s preview meanwhile"),
        ),
        (None, None) => (
            t.preview.clone(),
            "30-second preview — full track not found on YouTube".to_string(),
        ),
    };
    if audio_src.is_empty() {
        return StatusCode::NOT_FOUND.into_response();
    }
    axum::response::Html(format!(
        r#"\
<h1>{artist} - {title}</h1>
<p>{album} ({note})</p>
<img src="{cover}" width="300">
<br><br>
<audio controls preload="metadata" src="{audio_src}" style="width:300px"></audio>
<br>
<button onclick="document.querySelector('audio').currentTime=0">seek 0%</button>
<button onclick="let a=document.querySelector('audio');a.currentTime=(a.duration||10)*0.5">seek 50%</button>
<pre id="log"></pre>
<script>
const a=document.querySelector('audio'),l=document.getElementById('log');
for(const e of ['seeking','seeked','timeupdate','loadedmetadata','error'])
  a.addEventListener(e,()=>l.textContent+=e+' t='+a.currentTime.toFixed(1)+'/'+(isNaN(a.duration)?'?':a.duration.toFixed(1))+'\n');
</script>
<p><a href="/">back</a></p>"#,
        artist = esc(&t.artist.name),
        title = esc(&t.title),
        album = esc(&t.album.title),
        cover = esc(&t.album.cover_big),
        audio_src = esc(&audio_src),
        note = esc(&note),
    ))
    .into_response()
}

async fn cover(State(s): State<AppState>, Path(id): Path<i64>) -> impl IntoResponse {
    let path: Option<String> =
        s.db.lock()
            .unwrap()
            .query_row("SELECT path FROM tracks WHERE id = ?1", [id], |r| r.get(0))
            .ok();
    let Some(path) = path else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let data = tokio::task::spawn_blocking(move || {
        let f = Probe::open(&path).ok()?.read().ok()?;
        let tag = f.primary_tag()?;
        let pic = tag.pictures().first()?;
        let mime = match pic.mime_type() {
            Some(MimeType::Jpeg) | None => "image/jpeg",
            Some(MimeType::Png) => "image/png",
            Some(MimeType::Gif) => "image/gif",
            Some(MimeType::Bmp) => "image/bmp",
            _ => "image/jpeg",
        };
        Some((mime.to_string(), pic.data().to_vec()))
    })
    .await
    .ok()
    .flatten();
    let Some((mime, bytes)) = data else {
        return StatusCode::NOT_FOUND.into_response();
    };
    ([(header::CONTENT_TYPE, mime)], bytes).into_response()
}

use axum::http::{StatusCode, header};
use axum::response::Response;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// File extension for a resolved audio mime. yt-dlp always yields m4a
/// (transcoded); SongnestPy yields m4a (AAC) or webm (opus) depending on
/// what the client offers.
#[cfg(feature = "songnestpy")]
fn audio_ext(mime: &str) -> &'static str {
    if mime.contains("mp4") {
        "m4a"
    } else {
        "webm"
    }
}

/// Resolved stream: playable URL + mime. yt-dlp prints a `-g` URL (always
/// m4a); SongnestPy resolves on-device (m4a or opus/webm, no transcode).
struct FetchedStream {
    url: String,
    mime: String,
}

async fn fetch_stream(s: &AppState, id: &str) -> anyhow::Result<FetchedStream> {
    match &s.backend {
        Backend::YtDlp => {
            let YtDlpCall { mut cmd, _guard } = ytdlp_command(&s.downloader)?;
            let out = cmd
                .args(cookie_args())
                .args([
                    "-f",
                    "ba[ext=m4a]/ba",
                    "-g",
                    &format!("https://youtube.com/watch?v={id}"),
                ])
                .output()
                .await?;
            anyhow::ensure!(out.status.success(), "yt-dlp failed");
            let url = String::from_utf8(out.stdout)?
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            anyhow::ensure!(!url.is_empty(), "yt-dlp returned empty url");
            Ok(FetchedStream {
                url,
                mime: "audio/mp4".to_string(),
            })
        }
        #[cfg(feature = "songnestpy")]
        Backend::SongnestPy(ex) => {
            let st = ex.resolve(id).await.map_err(|e| anyhow::anyhow!("{e}"))?;
            anyhow::ensure!(!st.url.is_empty(), "songnestpy returned empty url");
            Ok(FetchedStream {
                url: st.url,
                mime: st.mime,
            })
        }
    }
}

async fn resolve_url(s: &AppState, id: &str, fresh: bool) -> anyhow::Result<String> {
    let cached = |s: &AppState| {
        s.urls
            .lock()
            .unwrap()
            .get(id)
            .filter(|(_, _, at)| at.elapsed() < Duration::from_secs(3600))
            .map(|(u, _, _)| u.clone())
    };
    if !fresh {
        if let Some(u) = cached(s) {
            return Ok(u);
        }
    }
    // cooling down: don't burn calls, fail fast (stream() -> 502)
    if cooled_down(s).is_some() {
        anyhow::bail!("youtube cooling down");
    }
    let _guard = s.resolve_lock.lock().await; // one resolver at a time
    if let Some(u) = cached(s) {
        return Ok(u); // someone else may have finished while we waited
    }

    let FetchedStream { url, mime } = fetch_stream(s, id).await?;
    s.urls
        .lock()
        .unwrap()
        .insert(id.to_string(), (url.clone(), mime, Instant::now()));
    Ok(url)
}

/// Mime of the cached resolve, if any (set by resolve_url).
#[cfg(feature = "songnestpy")]
fn cached_mime(s: &AppState, id: &str) -> Option<String> {
    s.urls
        .lock()
        .unwrap()
        .get(id)
        .map(|(_, m, _)| m.clone())
}

async fn stream(State(s): State<AppState>, Path(id): Path<String>, req: Request<Body>) -> Response {
    // downloaded file first (extension depends on backend mime), else proxy
    for ext in ["m4a", "webm"] {
        let local = format!("music/{id}.{ext}");
        if std::path::Path::new(&local).exists() {
            return ServeFile::new(local)
                .oneshot(req)
                .await
                .unwrap()
                .map(Body::new);
        }
    }
    let Ok(url) = resolve_url(&s, &id, false).await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let range = req
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string());
    let mut up = match paced_media_get(&s, &url, range.clone()).await {
        Ok(up) => up,
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    };
    // YouTube 403s dead/flagged media URLs: drop the cached URL, resolve
    // once more, retry once. (Per-URL issue — not a global cooldown.)
    if up.status() == StatusCode::FORBIDDEN {
        s.urls.lock().unwrap().remove(&id);
        if let Ok(fresh_url) = resolve_url(&s, &id, true).await {
            if let Ok(retry) = paced_media_get(&s, &fresh_url, range).await {
                up = retry;
            }
        }
    }

    let mut out = Response::builder().status(up.status());
    for h in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
    ] {
        if let Some(v) = up.headers().get(&h) {
            out = out.header(&h, v);
        }
    }
    out.body(Body::from_stream(up.bytes_stream())).unwrap()
}

/// Single-shot CLI download: Deezer search -> cached YouTube match ->
/// yt-dlp download -> cover -> tag -> library insert. Always yt-dlp (dev
/// tool); serve honors the backend flag instead.
pub async fn single_shot(query: &str) -> anyhow::Result<()> {
    let res: DzSearch = reqwest::Client::new()
        .get("https://api.deezer.com/search")
        .query(&[("q", &query)])
        .send()
        .await?
        .json()
        .await?;
    let t = res.data.first().expect("no results");
    println!(
        "{} - {} [{}] ({}s)",
        t.artist.name, t.title, t.album.title, t.duration
    );
    // same-name transparency: show what else Deezer found
    for other in res.data.iter().skip(1).take(3) {
        println!(
            "  also: {} - {} [{}] ({}s)",
            other.artist.name, other.title, other.album.title, other.duration
        );
    }

    let conn = rusqlite::Connection::open("library.db")?;
    ensure_schema(&conn)?;
    let db: Db = Arc::new(Mutex::new(conn));
    let dl = init_downloader().await;

    // cached Deezer->YouTube match: each song is searched once
    let Some((best_id, best_score)) = youtube_match(&dl, &Backend::YtDlp, &db, t, false).await
    else {
        // yt-dlp exits 0 with entries:[] when YouTube throttles search
        anyhow::bail!(
            "YouTube search returned no candidates (throttled?) — retry later or add cookies.txt"
        );
    };
    println!("best: https://youtube.com/watch?v={best_id} (score {best_score})");

    std::fs::create_dir_all("music")?;
    let path = download(&dl, &best_id, "music")?;

    let cover = reqwest::get(&t.album.cover_big).await?.bytes().await?;
    tag_file(&path, t, &cover)?;

    db.lock().unwrap().execute(
        "INSERT INTO tracks (title, artist, album, duration, video_id, path, cover_url, deezer_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(video_id) DO UPDATE SET
           title=excluded.title, artist=excluded.artist, album=excluded.album,
           duration=excluded.duration, path=excluded.path,
           cover_url=excluded.cover_url, deezer_id=excluded.deezer_id",
        (
            &t.title,
            &t.artist.name,
            &t.album.title,
            t.duration,
            &best_id,
            &path,
            &t.album.cover_big,
            t.id as i64,
        ),
    )?;

    Ok(())
}

#[cfg(test)]
mod downloader_tests {
    use super::*;
    use std::cmp::Ordering;

    #[test]
    fn date_versions_compare_numerically() {
        assert_eq!(cmp_date_version("2025.01.26", "2025.01.26"), Ordering::Equal);
        assert_eq!(cmp_date_version("2026.08.19", "2025.01.26"), Ordering::Greater);
        assert_eq!(cmp_date_version("2025.01.9", "2025.01.26"), Ordering::Less);
        assert_eq!(cmp_date_version("2026.08.19", "2026.08.19.1"), Ordering::Less);
    }

    #[test]
    fn version_triples_parse() {
        assert_eq!(parse_triple("deno 2.9.6 (stable)"), Some((2, 9, 6)));
        assert_eq!(parse_triple("v26.8.2"), Some((26, 8, 2)));
        assert_eq!(parse_triple("1.3.14"), Some((1, 3, 14)));
        assert_eq!(parse_triple("nope"), None);
        assert_eq!(parse_qjs_date("QuickJS v2025-04-26"), Some((2025, 4, 26)));
        assert_eq!(parse_qjs_date("qjs 1.0"), None);
    }

    #[test]
    fn runtime_support_decisions() {
        assert_eq!(classify_runtime("deno", "deno 2.9.6").1, true);
        assert_eq!(classify_runtime("deno", "deno 2.2.0").1, false);
        assert_eq!(classify_runtime("node", "v26.8.2").1, true);
        assert_eq!(classify_runtime("node", "v20.0.0").1, false);
        assert_eq!(classify_runtime("bun", "1.3.0").1, true);
        assert_eq!(classify_runtime("bun", "1.4.0").1, false); // past wiki max
        assert_eq!(classify_runtime("bun", "1.2.0").1, false); // below wiki min
        assert_eq!(classify_runtime("qjs", "QuickJS v2025-04-26").1, true);
        assert_eq!(classify_runtime("qjs", "QuickJS v2020-01-01").1, false);
    }

    #[test]
    fn runtime_pick_order_and_setting() {
        let mk = |name: &str, supported: bool| RuntimeInfo {
            name: name.to_string(),
            version: "x".to_string(),
            supported,
            path: name.to_string(),
        };
        let all = vec![mk("bun", true), mk("quickjs", true), mk("node", true), mk("deno", true)];
        // auto follows wiki order regardless of probe order
        assert_eq!(
            pick_runtime(&all, "auto", None).map(|v| v.0),
            Some("deno".to_string())
        );
        let no_deno: Vec<RuntimeInfo> =
            all.into_iter().filter(|r| r.name != "deno").collect();
        assert_eq!(
            pick_runtime(&no_deno, "auto", None).map(|v| v.0),
            Some("node".to_string())
        );
        // explicit setting respected, unsupported explicit choice = None
        assert!(pick_runtime(&no_deno, "deno", None).is_none());
        let only_bun = vec![mk("bun", true)];
        assert_eq!(
            pick_runtime(&only_bun, "bun", None).map(|v| v.0),
            Some("bun".to_string())
        );
        // unsupported runtimes never picked
        let old = vec![mk("deno", false)];
        assert!(pick_runtime(&old, "auto", None).is_none());
    }

    #[test]
    fn checksum_match_mismatch_missing() {
        let data = b"fake-binary-bytes";
        let good = {
            use sha2::{Digest, Sha256};
            let mut h = Sha256::new();
            h.update(data);
            hex::encode(h.finalize())
        };
        let sums = format!("{good}  yt-dlp_linux\ndeadbeef  other\n");
        assert!(verify_checksum(data, &sums, "yt-dlp_linux").is_ok());
        assert!(verify_checksum(b"tampered", &sums, "yt-dlp_linux").is_err());
        assert!(verify_checksum(data, &sums, "yt-dlp.exe").is_err());
        assert!(verify_checksum(data, "", "yt-dlp_linux").is_err());
    }

    #[test]
    fn swap_rejects_bad_binary_and_keeps_old() {
        let dir = std::env::temp_dir().join(format!("songnest-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("yt-dlp");
        let tmp = dir.join("yt-dlp.new");
        std::fs::write(&dest, b"old-good").unwrap();
        std::fs::write(&tmp, b"new-bad").unwrap();
        let bad_probe = |_: &std::path::Path| false;
        assert!(swap_binary(&tmp, &dest, &bad_probe).is_err());
        // tmp discarded, live copy untouched
        assert_eq!(std::fs::read(&dest).unwrap(), b"old-good");
        assert!(!tmp.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn swap_installs_and_rolls_back() {
        let dir = std::env::temp_dir().join(format!("songnest-test2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("yt-dlp");
        // fresh install (no previous copy)
        let tmp = dir.join("yt-dlp.new");
        std::fs::write(&tmp, b"v2").unwrap();
        let good_probe = |_: &std::path::Path| true;
        assert!(swap_binary(&tmp, &dest, &good_probe).is_ok());
        assert_eq!(std::fs::read(&dest).unwrap(), b"v2");
        // post-install probe fails -> previous copy restored
        let tmp2 = dir.join("yt-dlp.new");
        std::fs::write(&tmp2, b"v3").unwrap();
        let flaky = {
            let n = std::cell::Cell::new(0);
            move |_: &std::path::Path| {
                n.set(n.get() + 1);
                n.get() > 1 // tmp passes, dest fails
            }
        };
        assert!(swap_binary(&tmp2, &dest, &flaky).is_err());
        assert_eq!(std::fs::read(&dest).unwrap(), b"v2");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn guard_always_releases() {
        let dl = DownloaderState::default();
        assert_eq!(dl.read(|d| d.active), 0);
        {
            let _g1 = dl.hold();
            assert_eq!(dl.read(|d| d.active), 1);
            {
                let _g2 = dl.hold();
                assert_eq!(dl.read(|d| d.active), 2);
            }
            assert_eq!(dl.read(|d| d.active), 1);
        }
        assert_eq!(dl.read(|d| d.active), 0);
    }

    #[test]
    fn failure_classification_order() {
        // offline wins over everything
        assert_eq!(
            classify_failure("HTTP Error 429 plus DNS failure", true),
            Health::Offline
        );
        assert_eq!(
            classify_failure("nodename nor servname provided", true),
            Health::Offline
        );
        // rate limit next
        assert_eq!(
            classify_failure("ERROR: HTTP Error 429 Too Many Requests", false),
            Health::RateLimited
        );
        assert_eq!(
            classify_failure("Sign in to confirm you're not a bot", false),
            Health::RateLimited
        );
        // then JS runtime
        assert_eq!(
            classify_failure("No JS runtime available for challenge solving", false),
            Health::JsRuntimeMissing
        );
        assert_eq!(
            classify_failure("could not solve the challenge", false),
            Health::JsRuntimeMissing
        );
        // everything else is outdated
        assert_eq!(
            classify_failure("ERROR: Unsupported URL", false),
            Health::Outdated
        );
        assert_eq!(classify_failure("", false), Health::Outdated);
    }
}
