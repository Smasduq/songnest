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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let q = std::env::args().nth(1).expect("usage: cli <query>");
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
    let db = rusqlite::Connection::open("library.db")?;

    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS tracks (
        id INTEGER PRIMARY KEY, title TEXT, artist TEXT, album TEXT,
        duration INTEGER, video_id TEXT UNIQUE, path TEXT)",
    )?;
    db.execute(
        "INSERT OR REPLACE INTO tracks (title, artist, album, duration, video_id, path)
                VALUES (?1,?2,?3,?4,?5,?6)",
        (
            &t.title,
            &t.artist.name,
            &t.album.title,
            t.duration,
            &best.id,
            &path,
        ),
    )?;

    use axum::{
        Router,
        body::Body,
        extract::{Path, State},
        http::Request,
        response::IntoResponse,
        routing::get,
    };
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;
    use tower_http::services::ServeFile;

    type Db = Arc<Mutex<rusqlite::Connection>>;

    async fn track(
        State(db): State<Db>,
        Path(id): Path<i64>,
        req: Request<Body>,
    ) -> impl IntoResponse {
        let path: String = db
            .lock()
            .unwrap()
            .query_row("SELECT path FROM tracks WHERE id = ?1", [id], |r| r.get(0))
            .unwrap_or_default();
        ServeFile::new(path).oneshot(req).await.unwrap()
    }

    async fn serve() -> anyhow::Result<()> {
        let db: Db = Arc::new(Mutex::new(rusqlite::Connection::open("library.db")?));
        let app = Router::new().route("/track/:id", get(track)).with_state(db);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:8787").await?;
        axum::serve(listener, app).await?;
        Ok(())
    }

    Ok(())
}
