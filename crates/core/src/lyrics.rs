//! Time-synced lyrics via LRCLIB (https://lrclib.net), no API key.
//!
//! Pure functions live here so every embedder (desktop sidecar, Android
//! in-process server, Tauri command) shares them. SQLite caching lives in
//! `songnest-server`, which calls [`fetch_lyrics`] after a cache miss.

use serde::Deserialize;

pub const USER_AGENT: &str = "Songnest v0.1.0 (songnest.smasduq.xyz)";
pub const LRCLIB_BASE: &str = "https://lrclib.net";

/// One synced line. `text` may be empty: gaps mark instrumental breaks.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LyricLine {
    pub ms: u32,
    pub text: String,
}

/// Fetch result. `synced` is `None` when LRCLIB only has plain lyrics.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Lyrics {
    pub synced: Option<Vec<LyricLine>>,
    pub plain: Option<String>,
    pub instrumental: bool,
}

#[derive(Debug, Deserialize)]
struct LrclibGet {
    #[serde(default)]
    #[serde(rename = "syncedLyrics")]
    synced_lyrics: Option<String>,
    #[serde(default)]
    #[serde(rename = "plainLyrics")]
    plain_lyrics: Option<String>,
    #[serde(default)]
    instrumental: bool,
    #[serde(default)]
    duration: Option<f64>,
}

#[cfg(test)]
fn lyrics_from_response(r: LrclibGet) -> Option<Lyrics> {
    if r.instrumental {
        return Some(Lyrics {
            synced: None,
            plain: None,
            instrumental: true,
        });
    }
    let synced = r
        .synced_lyrics
        .as_deref()
        .map(parse_lrc)
        .filter(|v| !v.is_empty());
    let plain = r.plain_lyrics.filter(|s| !s.trim().is_empty());
    if synced.is_none() && plain.is_none() {
        return None;
    }
    Some(Lyrics {
        synced,
        plain,
        instrumental: false,
    })
}

fn client() -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(10))
        .build()?)
}

/// Strip version/credit suffixes that break lyric lookup:
/// "- Remastered", "(feat. ...)", "- Radio Edit", etc.
pub fn normalize_title(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    // Strip one bracketed feat/ft/with group at a time:
    // "Song (feat. A)" -> "Song". Case-insensitive, () or [].
    loop {
        let lower = s.to_lowercase();
        let mut cut: Option<(usize, usize)> = None;
        for (open, close) in [('(', ')'), ('[', ']')] {
            let mut search = 0;
            while let Some(o) = lower[search..].find(open) {
                let o = search + o;
                if let Some(c) = lower[o..].find(close) {
                    let c = o + c;
                    let inner = &lower[o + 1..c];
                    if inner.contains("feat")
                        || inner.contains("ft.")
                        || inner.contains("featuring")
                        || inner.trim_start().starts_with("with ")
                        || inner.contains(" with ")
                    {
                        cut = Some((o, c + 1));
                        break;
                    }
                    search = c + 1;
                } else {
                    break;
                }
            }
            if cut.is_some() {
                break;
            }
        }
        match cut {
            Some((o, c)) => {
                s = format!("{} {}", &s[..o], &s[c..]);
                s = s.split_whitespace().collect::<Vec<_>>().join(" ");
            }
            None => break,
        }
    }
    // Trailing " - <version>" suffixes: cut at the LAST " - " whose tail
    // names a version/mix. Loops so "X - Live - Remastered" fully trims.
    const VERSION_BITS: &[&str] = &[
        "remaster", "radio edit", "single version", "album version", "acoustic",
        "live", "bonus", "deluxe", "extended", "club mix", "instrumental",
        "karaoke", "sped up", "slowed", "reverb", "8d", "tiktok", "slowed +",
        "official audio", "official video", "lyric video", "visualizer",
    ];
    loop {
        let lower = s.to_lowercase();
        let Some(idx) = lower.rfind(" - ") else {
            break;
        };
        let tail = &lower[idx + 3..];
        if VERSION_BITS.iter().any(|b| tail.contains(b)) {
            s = s[..idx].trim_end().to_string();
        } else {
            break;
        }
    }
    // Trailing bracketed version tags: "(Remastered ...)", "[Radio Edit]".
    loop {
        let lower = s.to_lowercase();
        let trimmed = lower.trim_end();
        let (open, close) = if trimmed.ends_with(')') {
            ('(', ')')
        } else if trimmed.ends_with(']') {
            ('[', ']')
        } else {
            break;
        };
        let Some(o) = trimmed.rfind(open) else {
            break;
        };
        let inner = &trimmed[o + 1..trimmed.len() - close.len_utf8()];
        if VERSION_BITS.iter().any(|b| inner.contains(b)) {
            s = s[..o].trim_end().to_string();
        } else {
            break;
        }
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Parse an LRC string into timestamped lines.
///
/// - Multiple timestamps per line (`[00:10.00][01:30.00] text`) fan out.
/// - Metadata tags (`[ar:]`, `[ti:]`, `[offset:]`, …) are ignored.
/// - Empty-text lines are kept (instrumental gaps).
/// - Output is sorted by `ms`.
pub fn parse_lrc(lrc: &str) -> Vec<LyricLine> {
    let mut out = Vec::new();
    for raw_line in lrc.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        let mut stamps = Vec::new();
        let mut pos = 0;
        let bytes = line.as_bytes();
        let mut last_close = 0;
        while let Some(o) = line[pos..].find('[') {
            let o = pos + o;
            let Some(c_rel) = line[o..].find(']') else {
                break;
            };
            let c = o + c_rel;
            if let Some(ms) = parse_stamp(&line[o + 1..c]) {
                stamps.push(ms);
                last_close = c + 1;
            } else if o == 0 {
                // Leading non-timestamp tag ([ar:], [offset:], …): metadata line.
                // A line that opens with metadata carries no lyric timing.
                stamps.clear();
                last_close = 0;
                break;
            } else {
                // Bracketed text mid-line, not a timestamp: stop scanning so
                // it stays part of the lyric text.
                break;
            }
            pos = c + 1;
            if pos >= bytes.len() {
                break;
            }
        }
        if stamps.is_empty() {
            continue;
        }
        let text = line[last_close..].trim().to_string();
        for ms in stamps {
            out.push(LyricLine {
                ms,
                text: text.clone(),
            });
        }
    }
    out.sort_by_key(|l| l.ms);
    out
}

/// `[mm:ss]`, `[mm:ss.xx]`, `[mm:ss:xx]`, `[mm:ss.xxx]`. None for metadata.
fn parse_stamp(tag: &str) -> Option<u32> {
    let (mm, rest) = tag.split_once(':')?;
    // Reject metadata like "ar:xxx"/"offset:xxx": minutes must be numeric.
    if mm.trim().is_empty() || !mm.trim().chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let mm: u32 = mm.trim().parse().ok()?;
    // Seconds may carry a fractional part with '.' or ':'.
    let (ss, frac) = match rest.split_once('.') {
        Some((a, b)) => (a, Some(b)),
        None => match rest.split_once(':') {
            Some((a, b)) => (a, Some(b)),
            None => (rest, None),
        },
    };
    if ss.trim().is_empty() || !ss.trim().chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let ss: u32 = ss.trim().parse().ok()?;
    if ss >= 60 && frac.is_none() {
        // Tolerate long-form minutes overflow anyway; guard absurd values.
        if mm > 999 || ss > 5999 {
            return None;
        }
    }
    let frac_ms = match frac {
        None => 0,
        Some(f) => {
            let digits: String = f.chars().take_while(|c| c.is_ascii_digit()).collect();
            match digits.len() {
                0 => 0,
                1 => digits.parse::<u32>().unwrap_or(0) * 100,
                2 => digits.parse::<u32>().unwrap_or(0) * 10,
                _ => digits[..3].parse::<u32>().unwrap_or(0),
            }
        }
    };
    Some(mm * 60_000 + ss * 1000 + frac_ms)
}

/// LRCLIB lookup: exact `GET /api/get` first, then `GET /api/search`
/// fallback picking the duration-closest hit (within ~2s).
pub async fn fetch_lyrics(
    artist: &str,
    title: &str,
    album: &str,
    duration_secs: u32,
) -> Option<Lyrics> {
    fetch_lyrics_raw(artist, title, album, duration_secs)
        .await
        .ok()
        .and_then(|(synced_raw, plain_raw, instrumental)| {
            if instrumental {
                return Some(Lyrics {
                    synced: None,
                    plain: None,
                    instrumental: true,
                });
            }
            let synced = synced_raw
                .as_deref()
                .map(parse_lrc)
                .filter(|v| !v.is_empty());
            let plain = plain_raw.filter(|s| !s.trim().is_empty());
            if synced.is_none() && plain.is_none() {
                return None;
            }
            Some(Lyrics {
                synced,
                plain,
                instrumental: false,
            })
        })
}

/// Why an LRCLIB lookup failed. Surfaced to the UI so "no lyrics exist"
/// is never confused with "the service (or this backend) is broken".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LyricsError {
    /// LRCLIB answered: no lyrics for this track.
    NotFound,
    /// Network failure, rate limit (429), or an unexpected response.
    Unavailable,
}

/// Same as [`fetch_lyrics`] but keeps the raw LRC string so callers can
/// cache it verbatim (SQLite) and parse on read.
pub async fn fetch_lyrics_raw(
    artist: &str,
    title: &str,
    album: &str,
    duration_secs: u32,
) -> Result<(Option<String>, Option<String>, bool), LyricsError> {
    let http = client().map_err(|_| LyricsError::Unavailable)?;
    let track = normalize_title(title);
    let params: Vec<(&str, String)> = vec![
        ("artist_name", artist.to_string()),
        ("track_name", track.clone()),
        ("album_name", album.to_string()),
        ("duration", duration_secs.to_string()),
    ];
    let res = http
        .get(format!("{LRCLIB_BASE}/api/get"))
        .query(&params)
        .send()
        .await
        .map_err(|_| LyricsError::Unavailable)?;
    if res.status().is_success() {
        match res.json::<LrclibGet>().await {
            Ok(got) => {
                if got.instrumental {
                    return Ok((None, None, true));
                }
                let has_synced = got
                    .synced_lyrics
                    .as_deref()
                    .is_some_and(|s| !s.trim().is_empty());
                let has_plain = got
                    .plain_lyrics
                    .as_deref()
                    .is_some_and(|s| !s.trim().is_empty());
                if !has_synced && !has_plain {
                    return Err(LyricsError::NotFound);
                }
                return Ok((got.synced_lyrics, got.plain_lyrics, false));
            }
            Err(_) => return Err(LyricsError::Unavailable),
        }
    }
    if res.status().as_u16() != 404 {
        // Rate limit, server error, … — not "no lyrics", must not be
        // reported (or cached) as a miss.
        return Err(LyricsError::Unavailable);
    }
    // Fallback: free search, duration-closest hit wins (tolerance ~2s).
    let q = format!("{artist} {track}");
    let res = http
        .get(format!("{LRCLIB_BASE}/api/search"))
        .query(&[("q", q)])
        .send()
        .await
        .map_err(|_| LyricsError::Unavailable)?;
    if !res.status().is_success() {
        return Err(LyricsError::Unavailable);
    }
    let hits: Vec<LrclibGet> = res.json().await.map_err(|_| LyricsError::Unavailable)?;
    hits
        .into_iter()
        .filter_map(|h| {
            let d = h.duration.unwrap_or(-1.0);
            if d < 0.0 {
                return None;
            }
            let diff = (d - duration_secs as f64).abs();
            if diff > 2.0 {
                return None;
            }
            if h.instrumental {
                return Some((diff, (None::<String>, None::<String>, true)));
            }
            let has_synced = h
                .synced_lyrics
                .as_deref()
                .is_some_and(|s| !s.trim().is_empty());
            let has_plain = h
                .plain_lyrics
                .as_deref()
                .is_some_and(|s| !s.trim().is_empty());
            if !has_synced && !has_plain {
                return None;
            }
            Some((diff, (h.synced_lyrics, h.plain_lyrics, false)))
        })
        .min_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(_, l)| l)
        .ok_or(LyricsError::NotFound)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lrc_multi_stamps_and_sort_and_gaps() {
        let lines = parse_lrc("[ar:Someone]\n[01:30.00][00:10.00] hello\n[00:20.00]\n[ti:Title]");
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].ms, 10_000);
        assert_eq!(lines[0].text, "hello");
        assert_eq!(lines[1].ms, 20_000);
        assert_eq!(lines[1].text, "");
        assert_eq!(lines[2].ms, 90_000);
    }

    #[test]
    fn lrc_fraction_forms() {
        let lines = parse_lrc("[00:01.5] a\n[00:02.05] b\n[00:03.123] c\n[00:04] d");
        assert_eq!(lines[0].ms, 1500);
        assert_eq!(lines[1].ms, 2050);
        assert_eq!(lines[2].ms, 3123);
        assert_eq!(lines[3].ms, 4000);
    }

    #[test]
    fn lrc_ignores_offset_metadata() {
        let lines = parse_lrc("[offset:500]\n[length: 03:20]\n[00:05.00] x");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].ms, 5000);
    }

    #[test]
    fn titles_normalize() {
        assert_eq!(normalize_title("Song - Remastered"), "Song");
        assert_eq!(normalize_title("Song (feat. A)"), "Song");
        assert_eq!(normalize_title("Song [ft. A & B]"), "Song");
        assert_eq!(normalize_title("Song - Radio Edit"), "Song");
        assert_eq!(normalize_title("Song (Remastered 2011)"), "Song");
        assert_eq!(normalize_title("Treat U Right"), "Treat U Right");
    }

    #[test]
    fn instrumental_maps() {
        let l = lyrics_from_response(LrclibGet {
            synced_lyrics: None,
            plain_lyrics: None,
            instrumental: true,
            duration: None,
        });
        assert_eq!(
            l,
            Some(Lyrics {
                synced: None,
                plain: None,
                instrumental: true
            })
        );
    }
}
