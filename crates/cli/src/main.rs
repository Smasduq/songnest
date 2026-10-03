use serde::Deserialize;
use std::process::Command;

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
    urls: Arc<Mutex<HashMap<String, (String, Instant)>>>,
    resolve_lock: Arc<tokio::sync::Mutex<()>>,
    /// max 2 concurrent downloads (anti-bot: look human, not a farm)
    dl_sem: Arc<tokio::sync::Semaphore>,
    /// set when YouTube 429s/bot-checks us; queue + resolves pause meanwhile
    yt_cooldown_until: Arc<Mutex<Option<Instant>>>,
    /// latest yt-dlp release seen (once-per-startup GitHub check)
    ytdlp_latest: Arc<Mutex<Option<String>>>,
}

/// Seconds left on the YouTube cooldown, if any.
fn cooled_down(s: &AppState) -> Option<u64> {
    s.yt_cooldown_until
        .lock()
        .unwrap()
        .filter(|t| *t > Instant::now())
        .map(|t| t.duration_since(Instant::now()).as_secs())
}

/// True when yt-dlp output smells like throttling/bot-check.
fn youtube_blocked(text: &str) -> bool {
    text.contains("429") || text.contains("Sign in to confirm") || text.contains("bot check")
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

fn download(video_id: &str, out_dir: &str) -> anyhow::Result<String> {
    let template = format!("{out_dir}/%(id)s.%(ext)s");
    let status = Command::new("yt-dlp")
        .args(cookie_args())
        .args([
            "-f",
            "ba[ext=m4a]/ba",
            "-x",
            "--audio-format",
            "m4a",
            "-o",
            &template,
            &format!("https://youtube.com/watch?v={video_id}"),
        ])
        .status()?;
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
    routing::{get, post},
};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;
use tower_http::services::ServeFile;

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

/// Run `ytsearch5` for a Deezer track and return the best video id + score.
/// Returns None when YouTube yields nothing (throttled or truly absent).
async fn youtube_match(
    db: &Db,
    t: &DzTrack,
    fresh: bool,
) -> Option<(String, i32)> {
    if !fresh {
        if let Some(hit) = get_match(db, t.id) {
            return Some(hit);
        }
    }
    let out = tokio::process::Command::new("yt-dlp")
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
fn download_job(video_id: &str, out_dir: &str, on_progress: &dyn Fn(u8)) -> Result<String, String> {
    use std::io::BufRead;
    let template = format!("{out_dir}/%(id)s.%(ext)s");
    let mut child = Command::new("yt-dlp")
        .args(cookie_args())
        .args([
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
        ])
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
    let Some((video_id, _)) = youtube_match(&s.db, &t, false).await else {
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
    // 3. blocking download with progress (sleeps included)
    let db2 = s.db.clone();
    let vid2 = video_id.clone();
    let dl = tokio::task::spawn_blocking(move || {
        download_job(&vid2, "music", &|p| {
            let _ = db2.lock().unwrap().execute(
                "UPDATE downloads SET progress=?1, updated_at=strftime('%s','now') WHERE id=?2",
                rusqlite::params![p as i64, job_id],
            );
        })
    })
    .await;
    let path = match dl {
        Ok(Ok(p)) => p,
        Ok(Err(stderr_tail)) => {
            if youtube_blocked(&stderr_tail) {
                *s.yt_cooldown_until.lock().unwrap() =
                    Some(Instant::now() + Duration::from_secs(5 * 60));
            }
            let msg: String = stderr_tail.chars().take(300).collect();
            set_job(&s.db, job_id, "error", 0, Some(&msg));
            return;
        }
        Err(_) => {
            set_job(&s.db, job_id, "error", 0, Some("download task failed"));
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
    let tag_ok = tokio::task::spawn_blocking(move || tag_file(&path, &t, &cover))
        .await
        .map(|r| r.is_ok())
        .unwrap_or(false);
    if !tag_ok {
        set_job(&s.db, job_id, "error", 100, Some("tagging failed"));
        return;
    }
    // path moved into the closure; re-derive it for the library row
    let lib_path = format!("music/{video_id}.m4a");
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

async fn health(State(s): State<AppState>) -> impl IntoResponse {
    let ver = tokio::process::Command::new("yt-dlp")
        .arg("--version")
        .output()
        .await
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .unwrap_or_default()
        .trim()
        .to_string();
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
    let latest = s.ytdlp_latest.lock().unwrap().clone();
    let update_available = match &latest {
        Some(l) => !l.contains(&ver) && !ver.is_empty(),
        None => false,
    };
    Json(serde_json::json!({
        "yt_dlp": ver,
        "latest_release": latest,
        "update_available": update_available,
        "queue_depth": depth,
        "cooldown_secs": cooled_down(&s).unwrap_or(0),
    }))
}

async fn serve() -> anyhow::Result<()> {
    let conn = rusqlite::Connection::open("library.db")?;
    ensure_schema(&conn)?;
    let db: Db = Arc::new(Mutex::new(conn));
    let state = AppState {
        db,
        http: reqwest::Client::new(),
        urls: Arc::new(Mutex::new(HashMap::new())),
        resolve_lock: Arc::new(tokio::sync::Mutex::new(())),
        dl_sem: Arc::new(tokio::sync::Semaphore::new(2)),
        yt_cooldown_until: Arc::new(Mutex::new(None)),
        ytdlp_latest: Arc::new(Mutex::new(None)),
    };
    // two queue workers = max 2 concurrent downloads, ever
    tokio::spawn(download_worker(state.clone()));
    tokio::spawn(download_worker(state.clone()));
    // once-per-startup yt-dlp freshness check (best effort)
    tokio::spawn({
        let st = state.clone();
        async move {
            if let Ok(r) = st
                .http
                .get("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest")
                .header("User-Agent", "songnest")
                .send()
                .await
            {
                if let Ok(j) = r.json::<serde_json::Value>().await {
                    if let Some(tag) = j.get("tag_name").and_then(|v| v.as_str()) {
                        *st.ytdlp_latest.lock().unwrap() = Some(tag.to_string());
                    }
                }
            }
        }
    });
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
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8787").await?;
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
async fn deezer_cover_for_youtube(http: &reqwest::Client, video_id: &str) -> Option<String> {
    let out = tokio::process::Command::new("yt-dlp")
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
    let res: DzSearch = http
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
        None => deezer_cover_for_youtube(&s.http, &id).await,
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
        youtube_match(&s.db, &t, fresh).await.map(|(v, _)| v)
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

async fn resolve_url(s: &AppState, id: &str) -> anyhow::Result<String> {
    let cached = |s: &AppState| {
        s.urls
            .lock()
            .unwrap()
            .get(id)
            .filter(|(_, at)| at.elapsed() < Duration::from_secs(3600))
            .map(|(u, _)| u.clone())
    };
    if let Some(u) = cached(s) {
        return Ok(u);
    }
    // cooling down: don't burn calls, fail fast (stream() -> 502)
    if cooled_down(s).is_some() {
        anyhow::bail!("youtube cooling down");
    }
    let _guard = s.resolve_lock.lock().await; // one resolver at a time
    if let Some(u) = cached(s) {
        return Ok(u); // someone else may have finished while we waited
    }

    let out = tokio::process::Command::new("yt-dlp")
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
    s.urls
        .lock()
        .unwrap()
        .insert(id.to_string(), (url.clone(), Instant::now()));
    Ok(url)
}

async fn stream(State(s): State<AppState>, Path(id): Path<String>, req: Request<Body>) -> Response {
    let local = format!("music/{id}.m4a");
    if std::path::Path::new(&local).exists() {
        return ServeFile::new(local)
            .oneshot(req)
            .await
            .unwrap()
            .map(Body::new);
    }
    let Ok(url) = resolve_url(&s, &id).await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let mut rb = s.http.get(&url);
    if let Some(r) = req.headers().get(header::RANGE) {
        rb = rb.header(header::RANGE, r);
    }
    let Ok(up) = rb.send().await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };

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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let arg = std::env::args().nth(1).expect("usage: cli <query> | serve");
    if arg == "serve" {
        return serve().await;
    }
    let q = arg;

    let res: DzSearch = reqwest::Client::new()
        .get("https://api.deezer.com/search")
        .query(&[("q", &q)])
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

    // cached Deezer->YouTube match: each song is searched once
    let Some((best_id, best_score)) = youtube_match(&db, t, false).await
    else {
        // yt-dlp exits 0 with entries:[] when YouTube throttles search
        anyhow::bail!(
            "YouTube search returned no candidates (throttled?) — retry later or add cookies.txt"
        );
    };
    println!("best: https://youtube.com/watch?v={best_id} (score {best_score})");

    std::fs::create_dir_all("music")?;
    let path = download(&best_id, "music")?;

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
