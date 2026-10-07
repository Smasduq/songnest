#!/usr/bin/env python3
"""
Spotify Player - 自包含的 Spotify 控制脚本
通过 Spotify Web API 实现搜索、播放、队列管理等功能
"""

import os
import sys
import json
import time
import base64
import urllib.parse
import urllib.request

# === Config ===
CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "")
TOKEN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".spotify_tokens.json")
DEFAULT_DEVICE_ID = os.environ.get("SPOTIFY_DEVICE_ID", "")
API_BASE = "https://api.spotify.com/v1"


# === Token Management ===

def load_tokens():
    if not os.path.exists(TOKEN_FILE):
        print("ERROR: No tokens found. Run auth_setup.py first.", file=sys.stderr)
        sys.exit(1)
    with open(TOKEN_FILE) as f:
        return json.load(f)


def save_tokens(tokens):
    with open(TOKEN_FILE, "w") as f:
        json.dump(tokens, f, indent=2)


def refresh_access_token():
    tokens = load_tokens()
    auth_header = base64.b64encode(f"{CLIENT_ID}:{CLIENT_SECRET}".encode()).decode()
    data = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": tokens["refresh_token"],
    }).encode()

    req = urllib.request.Request(
        "https://accounts.spotify.com/api/token",
        data=data,
        headers={
            "Authorization": f"Basic {auth_header}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read().decode())

    tokens["access_token"] = result["access_token"]
    if "refresh_token" in result:
        tokens["refresh_token"] = result["refresh_token"]
    tokens["expires_in"] = result.get("expires_in", 3600)
    tokens["refreshed_at"] = int(time.time())
    save_tokens(tokens)
    return tokens["access_token"]


def get_access_token():
    tokens = load_tokens()
    refreshed_at = tokens.get("refreshed_at", 0)
    expires_in = tokens.get("expires_in", 3600)
    if time.time() - refreshed_at > expires_in - 300:
        return refresh_access_token()
    return tokens["access_token"]


# === API Helpers ===

def api_request(method, endpoint, body=None, params=None, retry=True):
    token = get_access_token()
    url = f"{API_BASE}{endpoint}"
    if params:
        url += "?" + urllib.parse.urlencode(params)

    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    if body:
        req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req) as resp:
            if resp.status == 204:
                return None
            body = resp.read().decode().strip()
            if not body:
                return None
            try:
                return json.loads(body)
            except json.JSONDecodeError:
                return None
    except urllib.error.HTTPError as e:
        if e.code == 401 and retry:
            refresh_access_token()
            return api_request(method, endpoint, body, params, retry=False)
        error_body = e.read().decode() if e.fp else ""
        print(f"ERROR {e.code}: {error_body}", file=sys.stderr)
        sys.exit(1)


# === Core Functions ===

def _extract_artists(item):
    return ", ".join(a["name"] for a in item.get("artists", []))


def _format_duration(ms):
    mins, secs = divmod(ms // 1000, 60)
    return f"{mins}:{secs:02d}"


def _extract_item(search_type, item, index):
    """Data-driven field extraction — no branches per type."""
    base = {"index": index, "name": item["name"], "id": item["id"], "uri": item["uri"]}
    extra = {
        "track": lambda: {
            "artists": _extract_artists(item),
            "duration": _format_duration(item.get("duration_ms", 0)),
            "album": item.get("album", {}).get("name", ""),
        },
        "artist": lambda: {
            "genres": ", ".join(item.get("genres", [])),
            "followers": item.get("followers", {}).get("total", 0),
        },
        "album": lambda: {
            "artists": _extract_artists(item),
            "release_date": item.get("release_date", ""),
            "total_tracks": item.get("total_tracks", 0),
        },
        "playlist": lambda: {
            "owner": item.get("owner", {}).get("display_name", ""),
            "tracks_total": item.get("tracks", {}).get("total", 0),
        },
    }
    base.update(extra.get(search_type, lambda: {})())
    return base


def search(query, search_type="track", limit=10):
    result = api_request("GET", "/search", params={
        "q": query,
        "type": search_type,
        "limit": limit,
        "market": "US",
    })
    items_key = f"{search_type}s"
    items = result.get(items_key, {}).get("items", [])
    return [_extract_item(search_type, item, i) for i, item in enumerate(items, 1)]


def play(uri=None, context_uri=None, uris=None, device_id=None):
    device_id = device_id or DEFAULT_DEVICE_ID
    body = {}
    if context_uri:
        body["context_uri"] = context_uri
    if uris:
        body["uris"] = uris
    elif uri:
        body["uris"] = [uri]

    api_request("PUT", f"/me/player/play?device_id={device_id}", body=body if body else None)
    return {"status": "playing"}


def pause(device_id=None):
    device_id = device_id or DEFAULT_DEVICE_ID
    api_request("PUT", f"/me/player/pause?device_id={device_id}")
    return {"status": "paused"}


def resume(device_id=None):
    device_id = device_id or DEFAULT_DEVICE_ID
    api_request("PUT", f"/me/player/play?device_id={device_id}")
    return {"status": "resumed"}


def skip_next(device_id=None):
    device_id = device_id or DEFAULT_DEVICE_ID
    api_request("POST", f"/me/player/next?device_id={device_id}")
    return {"status": "skipped_next"}


def skip_previous(device_id=None):
    device_id = device_id or DEFAULT_DEVICE_ID
    api_request("POST", f"/me/player/previous?device_id={device_id}")
    return {"status": "skipped_previous"}


def add_to_queue(uri, device_id=None):
    device_id = device_id or DEFAULT_DEVICE_ID
    api_request("POST", "/me/player/queue", params={
        "uri": uri,
        "device_id": device_id,
    })
    return {"status": "queued", "uri": uri}


def now_playing():
    result = api_request("GET", "/me/player/currently-playing")
    if not result or not result.get("item"):
        return {"status": "nothing_playing"}
    item = result["item"]
    artists = ", ".join(a["name"] for a in item.get("artists", []))
    progress_ms = result.get("progress_ms", 0)
    duration_ms = item.get("duration_ms", 0)
    p_min, p_sec = divmod(progress_ms // 1000, 60)
    d_min, d_sec = divmod(duration_ms // 1000, 60)
    return {
        "name": item["name"],
        "artists": artists,
        "album": item.get("album", {}).get("name", ""),
        "progress": f"{p_min}:{p_sec:02d}",
        "duration": f"{d_min}:{d_sec:02d}",
        "is_playing": result.get("is_playing", False),
        "id": item["id"],
        "uri": item["uri"],
    }


def get_queue(limit=10):
    result = api_request("GET", "/me/player/queue")
    if not result:
        return {"currently_playing": None, "queue": []}
    cp = result.get("currently_playing")
    current = None
    if cp:
        artists = ", ".join(a["name"] for a in cp.get("artists", []))
        current = {"name": cp["name"], "artists": artists, "id": cp["id"]}

    queue = []
    for item in result.get("queue", [])[:limit]:
        artists = ", ".join(a["name"] for a in item.get("artists", []))
        queue.append({"name": item["name"], "artists": artists, "id": item["id"]})
    return {"currently_playing": current, "queue": queue}


def set_volume(percent, device_id=None):
    device_id = device_id or DEFAULT_DEVICE_ID
    api_request("PUT", "/me/player/volume", params={
        "volume_percent": max(0, min(100, percent)),
        "device_id": device_id,
    })
    return {"status": "volume_set", "volume": percent}


def get_devices():
    result = api_request("GET", "/me/player/devices")
    devices = []
    for d in result.get("devices", []):
        devices.append({
            "id": d["id"],
            "name": d["name"],
            "type": d["type"],
            "is_active": d["is_active"],
            "volume": d.get("volume_percent"),
        })
    return devices


def recently_played(limit=10):
    result = api_request("GET", "/me/player/recently-played", params={"limit": limit})
    tracks = []
    for item in result.get("items", []):
        t = item.get("track", {})
        artists = ", ".join(a["name"] for a in t.get("artists", []))
        tracks.append({
            "name": t["name"],
            "artists": artists,
            "id": t["id"],
            "played_at": item.get("played_at", ""),
        })
    return tracks


def get_playlists(limit=20):
    result = api_request("GET", "/me/playlists", params={"limit": limit})
    playlists = []
    for p in result.get("items", []):
        playlists.append({
            "name": p["name"],
            "id": p["id"],
            "tracks_total": p.get("tracks", {}).get("total", 0),
            "owner": p.get("owner", {}).get("display_name", ""),
        })
    return playlists


def batch_play(track_uris, device_id=None):
    """Play first track, queue the rest - simulates a playlist."""
    if not track_uris:
        return {"status": "error", "message": "No tracks provided"}
    play(uri=track_uris[0], device_id=device_id)
    queued = []
    for uri in track_uris[1:]:
        add_to_queue(uri, device_id)
        queued.append(uri)
    return {"status": "batch_playing", "playing": track_uris[0], "queued": len(queued)}


def set_shuffle(state=True, device_id=None):
    device_id = device_id or DEFAULT_DEVICE_ID
    api_request("PUT", "/me/player/shuffle", params={
        "state": str(state).lower(),
        "device_id": device_id,
    })
    return {"status": "shuffle_on" if state else "shuffle_off"}


def set_repeat(state="off", device_id=None):
    """state: track, context, off"""
    device_id = device_id or DEFAULT_DEVICE_ID
    api_request("PUT", "/me/player/repeat", params={
        "state": state,
        "device_id": device_id,
    })
    return {"status": f"repeat_{state}"}


def artist_top_tracks(artist_id, limit=10):
    # /artists/{id}/top-tracks requires Extended Quota Mode (restricted since 2024).
    # Workaround: get artist name, then search tracks filtered by artist, sort by popularity.
    artist = api_request("GET", f"/artists/{artist_id}")
    artist_name = artist.get("name", "")
    result = api_request("GET", "/search", params={
        "q": f"artist:{artist_name}",
        "type": "track",
        "limit": 10,
    })
    items = result.get("tracks", {}).get("items", [])
    # Keep only tracks where this artist is listed, sort by popularity desc
    items = [t for t in items if any(a["id"] == artist_id for a in t.get("artists", []))]
    items.sort(key=lambda t: t.get("popularity", 0), reverse=True)
    tracks = []
    for i, t in enumerate(items[:limit], 1):
        tracks.append({
            "index": i,
            "name": t["name"],
            "artists": _extract_artists(t),
            "id": t["id"],
            "uri": t["uri"],
            "duration": _format_duration(t.get("duration_ms", 0)),
            "album": t.get("album", {}).get("name", ""),
            "popularity": t.get("popularity", 0),
        })
    return tracks


def artist_albums(artist_id, include_groups="album", limit=20):
    result = api_request("GET", f"/artists/{artist_id}/albums", params={
        "include_groups": include_groups,
        "market": "US",
        "limit": limit,
    })
    albums = []
    for i, a in enumerate(result.get("items", []), 1):
        albums.append({
            "index": i,
            "name": a["name"],
            "id": a["id"],
            "uri": a["uri"],
            "release_date": a.get("release_date", ""),
            "total_tracks": a.get("total_tracks", 0),
        })
    return albums


def album_tracks(album_id):
    result = api_request("GET", f"/albums/{album_id}/tracks", params={"market": "US", "limit": 50})
    tracks = []
    for i, t in enumerate(result.get("items", []), 1):
        tracks.append({
            "index": i,
            "name": t["name"],
            "artists": _extract_artists(t),
            "id": t["id"],
            "uri": t["uri"],
            "duration": _format_duration(t.get("duration_ms", 0)),
        })
    return tracks


# === CLI ===

def print_json(data):
    print(json.dumps(data, ensure_ascii=False, indent=2))


def main():
    if len(sys.argv) < 2:
        print("Usage: spotify.py <command> [args...]")
        print("\nCommands:")
        print("  search <query> [type] [limit]  - Search (type: track/artist/album/playlist)")
        print("  play <uri>                     - Play a track/album/playlist URI")
        print("  pause                          - Pause playback")
        print("  resume                         - Resume playback")
        print("  next                           - Skip to next track")
        print("  prev                           - Skip to previous track")
        print("  queue <uri>                    - Add to queue")
        print("  now                            - Now playing")
        print("  show-queue [limit]             - Show queue")
        print("  volume <0-100>                 - Set volume")
        print("  devices                        - List devices")
        print("  recent [limit]                 - Recently played")
        print("  playlists [limit]              - My playlists")
        print("  batch-play <uri1> <uri2> ...   - Play first, queue rest")
        print("  shuffle <on|off>               - Toggle shuffle")
        print("  repeat <track|context|off>     - Set repeat mode")
        print("  artist-top <artist_id>         - Artist top tracks")
        print("  artist-albums <artist_id> [type] [limit] - Artist albums (type: album/single/compilation)")
        print("  album-tracks <album_id>        - List album tracks")
        print("  artist-top <artist_id>         - Artist top tracks")
        print("  artist-albums <artist_id> [type] [limit] - Artist albums (type: album/single/compilation)")
        print("  album-tracks <album_id>        - List album tracks")
        sys.exit(0)

    cmd = sys.argv[1]

    if cmd == "search":
        query = sys.argv[2] if len(sys.argv) > 2 else ""
        stype = sys.argv[3] if len(sys.argv) > 3 else "track"
        limit = int(sys.argv[4]) if len(sys.argv) > 4 else 10
        print_json(search(query, stype, limit))

    elif cmd == "play":
        uri = sys.argv[2] if len(sys.argv) > 2 else None
        device = sys.argv[3] if len(sys.argv) > 3 else None
        if uri and uri.startswith("spotify:"):
            if ":track:" in uri:
                print_json(play(uri=uri, device_id=device))
            else:
                print_json(play(context_uri=uri, device_id=device))
        elif uri:
            # Treat as track ID
            print_json(play(uri=f"spotify:track:{uri}", device_id=device))
        else:
            print_json(resume(device))

    elif cmd == "pause":
        print_json(pause())

    elif cmd == "resume":
        print_json(resume())

    elif cmd == "next":
        print_json(skip_next())

    elif cmd == "prev":
        print_json(skip_previous())

    elif cmd == "queue":
        uri = sys.argv[2]
        if not uri.startswith("spotify:"):
            uri = f"spotify:track:{uri}"
        print_json(add_to_queue(uri))

    elif cmd == "now":
        print_json(now_playing())

    elif cmd == "show-queue":
        limit = int(sys.argv[2]) if len(sys.argv) > 2 else 10
        print_json(get_queue(limit))

    elif cmd == "volume":
        vol = int(sys.argv[2])
        print_json(set_volume(vol))

    elif cmd == "devices":
        print_json(get_devices())

    elif cmd == "recent":
        limit = int(sys.argv[2]) if len(sys.argv) > 2 else 10
        print_json(recently_played(limit))

    elif cmd == "playlists":
        limit = int(sys.argv[2]) if len(sys.argv) > 2 else 20
        print_json(get_playlists(limit))

    elif cmd == "batch-play":
        uris = sys.argv[2:]
        uris = [u if u.startswith("spotify:") else f"spotify:track:{u}" for u in uris]
        print_json(batch_play(uris))

    elif cmd == "shuffle":
        state = sys.argv[2].lower() == "on" if len(sys.argv) > 2 else True
        print_json(set_shuffle(state))

    elif cmd == "repeat":
        state = sys.argv[2] if len(sys.argv) > 2 else "off"
        print_json(set_repeat(state))

    elif cmd == "artist-top":
        aid = sys.argv[2]
        print_json(artist_top_tracks(aid))

    elif cmd == "artist-albums":
        aid = sys.argv[2]
        groups = sys.argv[3] if len(sys.argv) > 3 else "album"
        limit = int(sys.argv[4]) if len(sys.argv) > 4 else 20
        print_json(artist_albums(aid, groups, limit))

    elif cmd == "album-tracks":
        alid = sys.argv[2]
        print_json(album_tracks(alid))

    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
