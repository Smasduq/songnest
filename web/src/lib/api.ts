// Overridable for phone testing over LAN:
//   VITE_API_URL=http://<pc-lan-ip>:8787 npm run dev
// In-app Server URL setting (localStorage) wins over the build default,
// so the app can follow the PC across networks without a rebuild.
const SERVER_KEY = "songnest-server-url";
const BUILD_DEFAULT =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  "http://127.0.0.1:8787";

export function getServerUrl(): string {
  try {
    return localStorage.getItem(SERVER_KEY) ?? BUILD_DEFAULT;
  } catch {
    return BUILD_DEFAULT;
  }
}

export function setServerUrl(url: string): void {
  try {
    localStorage.setItem(SERVER_KEY, url.replace(/\/+$/, ""));
  } catch {
    // ignore
  }
}

function apiBase(): string {
  return getServerUrl();
}

export interface Song {
  id: string;
  title: string;
  artist: string;
  album: string;
  /** seconds */
  duration: number;
  coverUrl: string;
  streamUrl: string;
}

interface LibraryRow {
  id: number;
  title: string;
  artist: string;
  album: string;
  duration: number;
  cover: string;
  stream: string;
  cover_url: string;
  deezer_id: number;
}

export interface SearchHit {
  dz: number;
  title: string;
  artist: string;
  album: string;
  duration: number;
  cover: string;
}

interface ResolveHit extends SearchHit {
  video_id: string;
  stream: string;
}

function toSong(
  id: string,
  title: string,
  artist: string,
  album: string,
  duration: number,
  coverUrl: string,
  streamUrl: string
): Song {
  return { id, title, artist, album, duration, coverUrl, streamUrl };
}

/** Downloaded library tracks. */
export async function fetchLibrary(): Promise<Song[]> {
  const r = await fetch(`${apiBase()}/api/library`);
  if (!r.ok) throw new Error(`library: ${r.status}`);
  const rows = (await r.json()) as LibraryRow[];
  return rows.map((t) =>
    toSong(
      `db-${t.id}`,
      t.title,
      t.artist,
      t.album,
      t.duration,
      t.cover_url ? `${apiBase()}${t.cover_url}` : t.cover,
      `${apiBase()}${t.stream}`
    )
  );
}

/** Deezer candidates for a query (same-name songs stay distinguishable). */
export async function searchSongs(q: string): Promise<SearchHit[]> {
  const r = await fetch(`${apiBase()}/api/search?q=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error(`search: ${r.status}`);
  return (await r.json()) as SearchHit[];
}

/** Resolve one exact Deezer track to playable audio. */
export async function resolveTrack(dz: number): Promise<Song> {
  const r = await fetch(`${apiBase()}/api/resolve?dz=${dz}`);
  if (!r.ok) throw new Error(`resolve: ${r.status}`);
  const t = (await r.json()) as ResolveHit;
  return toSong(
    `dz-${t.dz}`,
    t.title,
    t.artist,
    t.album,
    t.duration,
    t.cover,
    `${apiBase()}${t.stream}`
  );
}

/** Song identity for likes: "dz:<id>" for Deezer tracks, "db:<id>" for library rows. */
export function likeKeyFor(song: Song): string | null {
  if (song.id.startsWith("dz-")) return `dz:${song.id.slice(3)}`;
  if (song.id.startsWith("db-")) return `db:${song.id.slice(3)}`;
  return null;
}

/** Chart suggestions. */
export async function fetchSuggestions(): Promise<SearchHit[]> {
  const r = await fetch(`${apiBase()}/api/suggest`);
  if (!r.ok) throw new Error(`suggest: ${r.status}`);
  return (await r.json()) as SearchHit[];
}

export async function fetchLikes(): Promise<Set<string>> {
  const r = await fetch(`${apiBase()}/api/likes`);
  if (!r.ok) throw new Error(`likes: ${r.status}`);
  const rows = (await r.json()) as { key: string }[];
  return new Set(rows.map((x) => x.key));
}

export interface LikedRow {
  key: string;
  title: string;
  artist: string;
  album: string;
  cover: string;
}

export async function fetchLikedRows(): Promise<LikedRow[]> {
  const r = await fetch(`${apiBase()}/api/likes`);
  if (!r.ok) throw new Error(`likes: ${r.status}`);
  return (await r.json()) as LikedRow[];
}

export async function setLiked(
  song: Song,
  liked: boolean
): Promise<void> {
  const key = likeKeyFor(song);
  if (key === null) throw new Error("unlikeable song");
  if (liked) {
    const r = await fetch(`${apiBase()}/api/like`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key,
        title: song.title,
        artist: song.artist,
        album: song.album,
        cover: song.coverUrl,
      }),
    });
    if (!r.ok) throw new Error(`like: ${r.status}`);
  } else {
    const r = await fetch(
      `${apiBase()}/api/like?key=${encodeURIComponent(key)}`,
      { method: "DELETE" }
    );
    if (!r.ok) throw new Error(`unlike: ${r.status}`);
  }
}

/** Queue a Deezer track for download. 409 = already there/queued. */
export async function enqueueDownload(dz: number): Promise<number> {
  const r = await fetch(`${apiBase()}/api/enqueue?dz=${dz}`, { method: "POST" });
  if (r.status === 409) throw new Error("already downloaded or queued");
  if (!r.ok) throw new Error(`enqueue: ${r.status}`);
  const j = (await r.json()) as { job: number };
  return j.job;
}

export interface DownloadJob {
  id: number;
  deezer_id: number;
  video_id: string;
  status: string;
  progress: number;
  error: string;
}

export interface Health {
  backend?: string;
  yt_dlp: string;
  queue_depth: number;
  cooldown_secs: number;
}

export async function fetchHealth(): Promise<Health> {
  const r = await fetch(`${apiBase()}/api/health`);
  if (!r.ok) throw new Error(`health: ${r.status}`);
  return (await r.json()) as Health;
}

export interface JsRuntimeInfo {
  name: string;
  version: string;
  supported: boolean;
  path: string;
}

export interface DownloaderStatus {
  backend?: string;
  binary_source: string;
  path: string;
  version: string;
  latest_known_version: string | null;
  update_available: boolean;
  last_check_at: number;
  last_update_at: number | null;
  health: string;
  last_error: string;
  ffmpeg: string | null;
  js_runtimes: JsRuntimeInfo[];
  js_runtime_in_use: string | null;
  js_runtime_setting: string;
  ejs_available: boolean | null;
  ejs_note: string;
}

export async function fetchDownloader(): Promise<DownloaderStatus> {
  const r = await fetch(`${apiBase()}/api/downloader`);
  if (!r.ok) throw new Error(`downloader: ${r.status}`);
  return (await r.json()) as DownloaderStatus;
}

export async function postDownloaderUpdate(): Promise<DownloaderStatus> {
  const r = await fetch(`${apiBase()}/api/downloader/update`, {
    method: "POST",
  });
  if (!r.ok) throw new Error(`update: ${r.status}`);
  return (await r.json()) as DownloaderStatus;
}

export async function postDownloaderRecheck(): Promise<DownloaderStatus> {
  const r = await fetch(`${apiBase()}/api/downloader/recheck`, {
    method: "POST",
  });
  if (!r.ok) throw new Error(`recheck: ${r.status}`);
  return (await r.json()) as DownloaderStatus;
}

export async function postDownloaderRuntime(
  setting: string
): Promise<DownloaderStatus> {
  const r = await fetch(`${apiBase()}/api/downloader/runtime`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ setting }),
  });
  if (!r.ok) throw new Error(`runtime setting: ${r.status}`);
  return (await r.json()) as DownloaderStatus;
}

/** Wait until the queued job for dz finishes (or fails). */
export async function waitForDownload(
  dz: number,
  onProgress: (pct: number) => void,
  timeoutMs = 10 * 60 * 1000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const r = await fetch(`${apiBase()}/api/downloads`);
    if (!r.ok) throw new Error(`downloads: ${r.status}`);
    const jobs = (await r.json()) as DownloadJob[];
    const job = jobs.find((j) => j.deezer_id === dz);
    if (job === undefined) throw new Error("job vanished");
    onProgress(job.progress);
    if (job.status === "done") return;
    if (job.status === "error")
      throw new Error(job.error === "" ? "download failed" : job.error);
    if (Date.now() - start > timeoutMs) throw new Error("download timed out");
    await new Promise((res) => setTimeout(res, 2000));
  }
}

/** Extract dz id from a dz:-prefixed song, else null. */
export function dzOf(song: Song): number | null {
  if (!song.id.startsWith("dz-")) return null;
  const n = Number(song.id.slice(3));
  return Number.isInteger(n) ? n : null;
}

export function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "0:00";
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
