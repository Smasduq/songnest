use serde::Deserialize;
use std::process::Command;

#[derive(Deserialize)]
struct DzSearch {
    data: Vec<DzTrack>,
}
#[derive(Deserialize)]
struct DzTrack {
    title: String,
    duration: u32,
    artist: DzArtist,
    album: DzAlbum,
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

fn download(video_id: &str, out_dir: &str) -> anyhow::Result<String> {
    let template = format!("{out_dir}/%(id)s.%(ext)s");
    let status = Command::new("yt-dlp")
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
    Router,
    body::Body,
    extract::{Path, Query, State},
    http::Request,
    response::IntoResponse,
    routing::get,
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
    Ok(())
}

async fn track(State(s): State<AppState>, Path(id): Path<i64>, req: Request<Body>) -> impl IntoResponse {
    let path: String = s
        .db
        .lock()
        .unwrap()
        .query_row("SELECT path FROM tracks WHERE id = ?1", [id], |r| r.get(0))
        .unwrap_or_default();
    ServeFile::new(path).oneshot(req).await.unwrap()
}

async fn serve() -> anyhow::Result<()> {
    let conn = rusqlite::Connection::open("library.db")?;
    ensure_schema(&conn)?;
    let db: Db = Arc::new(Mutex::new(conn));
    let state = AppState {
        db,
        http: reqwest::Client::new(),
        urls: Arc::new(Mutex::new(HashMap::new())),
    };
    let app = Router::new()
        .route("/", get(index))
        .route("/track/:id", get(track))
        .route("/stream/:id", get(stream))
        .route("/cover/:id", get(cover))
        .route("/player/:id", get(player))
        .route("/s/:id", get(stream_player))
        .route("/d", get(dplayer))
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
        .prepare("SELECT id, title, artist, video_id, COALESCE(cover_url,'') FROM tracks ORDER BY id")
        .map(|mut st| {
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
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
    let db_cover: Option<String> = s
        .db
        .lock()
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

/// Deezer-first stream player: take the song's metadata from Deezer,
/// use its cover_big, resolve the same track's YouTube audio, stream it.
/// Nothing is downloaded or stored.
async fn dplayer(State(s): State<AppState>, Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    let query = q.get("q").cloned().unwrap_or_default();
    if query.trim().is_empty() {
        return axum::response::Html(
            "<form action=\"/d\"><input name=\"q\" placeholder=\"artist title\" size=\"30\"><button>stream from Deezer</button></form>"
                .to_string(),
        )
        .into_response();
    }
    // 1. song metadata + cover from Deezer
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
    let Some(t) = res.data.first() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // 2. same YouTube matching as the download flow, but stream only
    let out = match tokio::process::Command::new("yt-dlp")
        .args([
            "-J",
            "--flat-playlist",
            &format!("ytsearch5:{} {}", t.artist.name, t.title),
        ])
        .output()
        .await
    {
        Ok(o) => o,
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    };
    if !out.status.success() {
        return StatusCode::BAD_GATEWAY.into_response();
    }
    let list: YtList = match serde_json::from_slice(&out.stdout) {
        Ok(l) => l,
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    };
    let Some(best) = list.entries.iter().max_by_key(|e| score(e, t)) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    axum::response::Html(format!(
        r#"\
<h1>{artist} - {title}</h1>
<p>{album} (Deezer match, not downloaded)</p>
<img src="{cover}" width="300">
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
</script>
<p><a href="/">back</a></p>"#,
        artist = esc(&t.artist.name),
        title = esc(&t.title),
        album = esc(&t.album.title),
        cover = esc(&t.album.cover_big),
        vid = esc(&best.id),
    ))
    .into_response()
}

async fn cover(State(s): State<AppState>, Path(id): Path<i64>) -> impl IntoResponse {
    let path: Option<String> = s
        .db
        .lock()
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

#[derive(Clone)]
struct AppState {
    db: Db,
    http: reqwest::Client,
    urls: Arc<Mutex<HashMap<String, (String, Instant)>>>,
}

async fn resolve_url(s: &AppState, id: &str) -> anyhow::Result<String> {
    if let Some((u, at)) = s.urls.lock().unwrap().get(id) {
        if at.elapsed() < Duration::from_secs(3600) {
            return Ok(u.clone());
        }
    }
    let out = tokio::process::Command::new("yt-dlp")
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

    let out = Command::new("yt-dlp")
        .args([
            "-J",
            "--flat-playlist",
            &format!("ytsearch5:{} {}", t.artist.name, t.title),
        ])
        .output()?;
    let list: YtList = serde_json::from_slice(&out.stdout)?;
    let best = list.entries.iter().max_by_key(|e| score(e, t)).unwrap();
    println!(
        "best: https://youtube.com/watch?v={} (score {})",
        best.id,
        score(best, t)
    );

    std::fs::create_dir_all("music")?;
    let path = download(&best.id, "music")?;

    let cover = reqwest::get(&t.album.cover_big).await?.bytes().await?;
    tag_file(&path, t, &cover)?;
    let db = rusqlite::Connection::open("library.db")?;
    ensure_schema(&db)?;

    db.execute(
        "INSERT INTO tracks (title, artist, album, duration, video_id, path, cover_url)
         VALUES (?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(video_id) DO UPDATE SET
           title=excluded.title, artist=excluded.artist, album=excluded.album,
           duration=excluded.duration, path=excluded.path, cover_url=excluded.cover_url",
        (
            &t.title,
            &t.artist.name,
            &t.album.title,
            t.duration,
            &best.id,
            &path,
            &t.album.cover_big,
        ),
    )?;

    Ok(())
}
