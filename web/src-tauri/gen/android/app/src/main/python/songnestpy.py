"""SongnestPy: on-device yt-dlp bridge (Chaquopy / Android).

Called from Rust over JNI (see `crates/extract/src/songnestpy.rs`).
Every function takes plain strings and returns a JSON string so the
bridge stays untyped. yt-dlp is imported lazily inside each call — the
first import on device takes a few seconds, later calls reuse it.

Only search + resolve live here. Downloads and streaming reuse the
server's direct googlevideo fetch against the resolved URLs, so this
module never writes media files and needs no completion callbacks.
"""

import json
import os

_STATE = {"cookies": None}


def configure(cfg_json):
    """Point the bridge at a cookies file. Missing file => anonymous."""
    try:
        cfg = json.loads(cfg_json or "{}")
    except Exception as e:
        return json.dumps({"ok": False, "error": "bad config: %r" % (e,)})
    path = cfg.get("cookies")
    _STATE["cookies"] = path if path and os.path.exists(path) else None
    return json.dumps({"ok": True, "cookies": _STATE["cookies"] is not None})


def probe():
    """Interpreter + yt-dlp versions and cookie state (diagnostics)."""
    import sys

    try:
        import yt_dlp

        ydl_version = yt_dlp.version.__version__
    except Exception as e:
        return json.dumps({"error": "yt-dlp import FAILED: %r" % (e,)})
    return json.dumps(
        {
            "python": sys.version.split()[0],
            "yt_dlp": ydl_version,
            "cookies": _STATE["cookies"] is not None,
        }
    )


def _base_params():
    params = {
        "quiet": True,
        "no_warnings": True,
        "socket_timeout": 30,
        "retries": 3,
        "fragment_retries": 3,
    }
    if _STATE["cookies"]:
        params["cookiefile"] = _STATE["cookies"]
    return params


def search_json(query, limit=5):
    """ytsearchN for a query. Returns hits or {"error": ...}."""
    try:
        from yt_dlp import YoutubeDL

        params = _base_params()
        with YoutubeDL(params) as ydl:
            info = ydl.extract_info(
                "ytsearch%d:%s" % (limit, query), download=False
            )
        entries = (info or {}).get("entries") or []
        hits = []
        for e in entries:
            if not e or e.get("id") is None:
                continue
            hits.append(
                {
                    "id": str(e.get("id")),
                    "title": e.get("title") or "",
                    "duration": e.get("duration"),
                    "channel": e.get("channel") or e.get("uploader") or "",
                }
            )
        return json.dumps({"hits": hits})
    except Exception as e:
        return json.dumps({"error": "search FAILED: %.300r" % (e,)})


def resolve_json(video_id):
    """Best-audio direct URL for one video. Returns stream or {"error": ...}."""
    try:
        from yt_dlp import YoutubeDL

        params = _base_params()
        params["format"] = "ba[ext=m4a]/ba"
        with YoutubeDL(params) as ydl:
            info = ydl.extract_info(
                "https://youtube.com/watch?v=%s" % video_id, download=False
            )
        if not info:
            return json.dumps({"error": "resolve returned nothing"})
        url = info.get("url") or ""
        if not url and info.get("requested_formats"):
            url = info["requested_formats"][0].get("url") or ""
        if not url:
            return json.dumps({"error": "resolve returned no playable url"})
        return json.dumps(
            {
                "url": url,
                "ext": info.get("ext") or "",
                "abr": info.get("abr"),
            }
        )
    except Exception as e:
        return json.dumps({"error": "resolve FAILED: %.300r" % (e,)})
