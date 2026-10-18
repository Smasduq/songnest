import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from "framer-motion";

import { NowPlaying } from "@/components/now-playing";
import { NowPlayingSheet } from "@/components/now-playing-sheet";
import { SettingsSheet } from "@/components/settings-sheet";
import { MiniPlayer } from "@/components/mini-player";
import { MobileSeekBar } from "@/components/mobile-seek-bar";
import { Diagnostics } from "@/components/diagnostics";
import ProfilePage from "@/pages/profile";
import LyricsPage from "@/pages/lyrics";
import AuthPage from "@/pages/auth";
import UpdatePage from "@/pages/update";
import {
  AccountsError,
  dropPushed,
  enqueueChange,
  getCursor,
  isLocalOnly,
  loadOutbox,
  loadSession,
  logout,
  pullLikes,
  pushLikes,
  setCursor,
  toChange,
  type RemoteLike,
  type Session,
  updateStoredEmail,
} from "@/lib/accounts";
import {
  startLikesSync,
  type LikesSyncHandle,
} from "@/lib/likes-sync-worker";
import { Sidebar, type Page } from "@/components/sidebar";
import { Header, useTheme } from "@/components/header";
import { MobileHeader } from "@/components/mobile-header";
import { MobileNav } from "@/components/mobile-nav";
import { PlayerBar } from "@/components/player-bar";
import { CustomScroller } from "@/components/custom-scroller";
import { EmptyState, OfflineState } from "@/components/empty-state";
import { Disc3, Heart, Library, SearchX } from "lucide-react";
import { SongCard, type DlState, type SwipeLeftKind } from "@/components/song-card";
import { useCurrentTrack, usePlayer } from "@/player/store";
import { initBackgroundPlayer } from "@/native/background-player";
import {
  deleteTrack,
  dzOf,
  enqueueDownload,
  fetchDownloader,
  fetchHealth,
  postDownloaderUpdate,
  fetchLibrary,
  fetchLikedRows,
  fetchLikes,
  fetchSuggestions,
  refreshArtists,
  likeKeyFor,
  resolveTrack,
  searchSongs,
  setLiked,
  waitForDownload,
  type DownloaderStatus,
  type Health,
  type LikedRow,
  type SearchHit,
  type Song,
} from "@/lib/api";

function hitToSong(h: SearchHit): Song {
  return {
    id: `dz-${h.dz}`,
    title: h.title,
    artist: h.artist,
    album: h.album,
    duration: h.duration,
    coverUrl: h.cover,
    streamUrl: "",
    deezerId: h.dz,
  };
}

/** Slide/fade wrapper so lists animate in and out (mobile feel).
 *  Exit mirrors the queue rows (slide right + fade) so deletes and
 *  unlikes leave the list the same way queue removals do. */
function Anim({ id, children }: { id: string; children: ReactNode }) {
  return (
    <motion.div
      key={id}
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 24 }}
      transition={{ type: "spring", stiffness: 400, damping: 35 }}
    >
      {children}
    </motion.div>
  );
}

export default function App() {
  const [history, setHistory] = useState<Page[]>(["home"]);
  const page = history[history.length - 1];
  function go(p: Page) {
    setHistory((h) => (h[h.length - 1] === p ? h : [...h, p]));
  }
  function back() {
    setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h));
  }
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [suggestions, setSuggestions] = useState<SearchHit[]>([]);
  const [likes, setLikes] = useState<Set<string>>(new Set());
  const [likedRows, setLikedRows] = useState<LikedRow[]>([]);
  const [dl, setDl] = useState<Record<string, { state: DlState; progress: number }>>({});
  const [toast, setToast] = useState<{ id: number; msg: string } | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  // frontend download gate: max 2 at once, ~2s between starts,
  // 5-minute pause after a rate-limit style failure
  const dlActive = useRef(0);
  const dlLastStart = useRef(0);
  const dlCooldownUntil = useRef(0);

  function showToast(msg: string) {
    window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), msg });
    toastTimer.current = window.setTimeout(() => setToast(null), 2500);
  }
  const [sheetOpen, setSheetOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const { theme, setTheme } = useTheme();
  const mainRef = useRef<HTMLElement>(null);
  const edgeRef = useRef<{
    x: number;
    t0: number;
    lx: number;
    lt: number;
  } | null>(null);

  // edge-swipe-back: touch starting within 20px of main's left edge pops
  // the page history (commits past 40% width or on a fast flick)
  function onTouchStart(e: React.TouchEvent) {
    const r = mainRef.current?.getBoundingClientRect();
    const t = e.touches[0];
    if (r !== undefined && t.clientX - r.left <= 20 && history.length > 1) {
      const now = performance.now();
      edgeRef.current = { x: t.clientX, t0: now, lx: t.clientX, lt: now };
    }
  }
  function onTouchMove(e: React.TouchEvent) {
    const cur = edgeRef.current;
    if (cur === null) return;
    cur.lx = e.touches[0].clientX;
    cur.lt = performance.now();
  }
  function onTouchEnd() {
    const cur = edgeRef.current;
    edgeRef.current = null;
    if (cur === null) return;
    const width = mainRef.current?.getBoundingClientRect().width ?? 0;
    if (width === 0) return;
    const dx = cur.lx - cur.x;
    const velocity = dx / Math.max(1, cur.lt - cur.t0); // px per ms
    if (dx > width * 0.4 || velocity > 0.5) back();
  }
  const reduceMotion = useReducedMotion();

  // playback state lives in the zustand store (audio element is module-level)
  const queue = usePlayer((s) => s.queue);
  const library = usePlayer((s) => s.library);
  const index = usePlayer((s) => s.index);
  const resolving = usePlayer((s) => s.resolving);
  const buffering = usePlayer((s) => s.buffering);
  const resolvingDz = usePlayer((s) => s.resolvingDz);
  const activeTrack = useCurrentTrack();
  // playback actions (stable refs from the store — safe to call anywhere)
  const store = usePlayer;

  /** Persistently downloaded Deezer IDs (survives list re-renders and
   *  restarts). The per-row `dl` map only tracks live progress; this set
   *  is what the UI reads for "Downloaded". */
  const DOWNLOADED_KEY = "songnest-downloaded-dz";
  const [downloadedDz, setDownloadedDz] = useState<Set<number>>(() => {
    try {
      const raw = window.localStorage.getItem(DOWNLOADED_KEY);
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      return new Set(Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === "number") : []);
    } catch {
      return new Set<number>();
    }
  });

  function persistDownloaded(next: Set<number>): void {
    try {
      window.localStorage.setItem(DOWNLOADED_KEY, JSON.stringify([...next]));
    } catch {
      // Storage full/blocked: in-memory state still works this session.
    }
  }

  function markDownloaded(dz: number): void {
    // Functional update: success handlers run after awaits, so the
    // rendered closure may be stale (concurrent downloads must not drop
    // each other's marks). The localStorage write is idempotent.
    setDownloadedDz((prev) => {
      if (prev.has(dz)) return prev;
      const next = new Set(prev).add(dz);
      persistDownloaded(next);
      return next;
    });
  }

  function unmarkDownloaded(dz: number): void {
    setDownloadedDz((prev) => {
      if (!prev.has(dz)) return prev;
      const next = new Set(prev);
      next.delete(dz);
      persistDownloaded(next);
      return next;
    });
  }

  const refreshLibrary = useCallback(async () => {
    try {
      const library = await fetchLibrary();
      store.getState().setLibrary(library);
      // Seed the downloaded set from what's on disk (covers installs
      // from before this registry existed, and other devices' files
      // are naturally excluded — localStorage is per device).
      const ids = library
        .map((t) => t.deezerId)
        .filter((d): d is number => typeof d === "number");
      if (ids.length > 0) {
        setDownloadedDz((prev) => {
          if (ids.every((id) => prev.has(id))) return prev;
          const next = new Set(prev);
          for (const id of ids) next.add(id);
          try {
            window.localStorage.setItem(DOWNLOADED_KEY, JSON.stringify([...next]));
          } catch {
            // Best effort.
          }
          return next;
        });
      }
      setLoadError(null);
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : "library failed");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshLikes = useCallback(async () => {
    try {
      const [keys, rows] = await Promise.all([fetchLikes(), fetchLikedRows()]);
      setLikes(keys);
      setLikedRows(rows);
    } catch {
      // backend unreachable — keep previous state
    }
  }, []);

  // Background player boot (once): native phone engine when available,
  // desktop tray/MediaSession wiring otherwise. Never blocks first paint.
  useEffect(() => {
    void initBackgroundPlayer();
  }, []);

  useEffect(() => {
    refreshLibrary().finally(() => setLoading(false));
    fetchSuggestions()
      .then(setSuggestions)
      .catch(() => setSuggestions([]));
    refreshLikes();
    // self-heal rows stored before full artist credits shipped, then
    // reload whatever changed so cards + now playing show every artist
    refreshArtists()
      .then(({ tracks_updated, likes_updated }) => {
        if (tracks_updated > 0) refreshLibrary();
        if (likes_updated > 0) refreshLikes();
      })
      .catch(() => {});
    fetchHealth()
      .then(setHealth)
      .catch(() => setHealth(null));
  }, [refreshLibrary, refreshLikes]);

  // downloader status for the health banner (mount + every 60s)
  const [dlStatus, setDlStatus] = useState<DownloaderStatus | null>(null);
  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const s = await fetchDownloader();
        if (alive) setDlStatus(s);
      } catch {
        if (alive) setDlStatus(null);
      }
    }
    poll();
    const t = window.setInterval(poll, 60000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  // deep link: #diagnostics opens the diagnostics page,
  // #profile (also #account / #me, or path /profile) opens the profile page,
  // #signin / #signup / #auth opens the sign-in/sign-up page.
  // `?code=` (GitHub OAuth return) also opens it so the callback is exchanged.
  const [isAuthRoute, setIsAuthRoute] = useState(() =>
    ["#signin", "#signup", "#auth"].includes(window.location.hash) ||
    new URLSearchParams(window.location.search).has("code")
  );
  useEffect(() => {
    function applyHash() {
      const hash = window.location.hash;
      if (hash === "#diagnostics") go("diagnostics");
      else if (hash === "#update") go("update");
      else if (
        hash === "#profile" ||
        hash === "#account" ||
        hash === "#me" ||
        window.location.pathname === "/profile"
      )
        go("profile");
      setIsAuthRoute(
        ["#signin", "#signup", "#auth"].includes(hash) ||
          new URLSearchParams(window.location.search).has("code"),
      );
    }
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Publish fixed-bar heights for mobile scroll padding. Desktop header
  // is display:none on mobile (and vice versa), so take whichever is live.
  // Also registers the passive touchstart iOS Safari needs for :active.
  useEffect(() => {
    const root = document.documentElement;
    function apply() {
      const bottom = document.getElementById("bottom-stack");
      const top =
        document.getElementById("mobile-header") ??
        document.getElementById("app-header");
      root.style.setProperty(
        "--bottom-bars-h",
        `${bottom?.offsetHeight ?? 0}px`
      );
      root.style.setProperty("--top-bar-h", `${top?.offsetHeight ?? 0}px`);
    }
    apply();
    const ro = new ResizeObserver(apply);
    const b = document.getElementById("bottom-stack");
    const t =
      document.getElementById("mobile-header") ??
      document.getElementById("app-header");
    if (b) ro.observe(b);
    if (t) ro.observe(t);
    document.addEventListener("touchstart", () => {}, { passive: true });
    return () => {
      ro.disconnect();
      root.style.setProperty("--bottom-bars-h", "0px");
      root.style.setProperty("--top-bar-h", "0px");
    };
  }, []);

  // "/" focuses search from anywhere (except while typing)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (
        e.key === "/" &&
        (el === null || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA"))
      ) {
        e.preventDefault();
        document.getElementById("songnest-search")?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const runSearch = useCallback(
    async (qOverride?: string) => {
      // override: typeahead picks setQuery + search in one tap — state
      // hasn't re-rendered yet, so search the passed text directly
      const q = (qOverride ?? query).trim();
      if (!q) return;
      setSearching(true);
      try {
        setHits(await searchSongs(q));
        setSearchFailed(false);
      } catch {
        setHits([]);
        setSearchFailed(true);
      } finally {
        setSearching(false);
      }
    },
    [query]
  );

  /** Typeahead pick: fill the bar and run the full search for it. */
  function pickSuggest(hit: SearchHit) {
    const label = `${hit.title} ${hit.artist}`;
    setQuery(label);
    go("search");
    void runSearch(label);
  }

  function playHit(hit: SearchHit) {
    // Optimistic: Now Playing updates on the tapped metadata instantly;
    // yt-dlp resolves the stream in the background (see store.playDz).
    // The sheet stays closed — it opens from the mini-player.
    // NOTE: hits/query are intentionally kept so the search results stay
    // visible while the tapped song plays.
    const hint = hitToSong(hit);
    void store.getState().playDz(hit.dz, hint);
  }

  function playSong(song: Song) {
    if (song.streamUrl !== "") {
      store.getState().playTrack(song);
      return;
    }
    const dz = dzOf(song);
    if (dz !== null) {
      void store.getState().playDz(dz, song);
    } else {
      store.getState().playTrack(song);
    }
  }

  /** Wrong song? Force a fresh YouTube search and swap the stream in place. */
  async function retryMatch() {
    const t = store.getState();
    const cur = [...t.queue, ...t.library][t.index];
    const dz = cur !== undefined ? dzOf(cur) : null;
    if (dz === null || cur === undefined) return;
    showToast("Searching for a better match…");
    await store.getState().playDz(dz, cur, true);
  }

  function addToQueue(song: Song) {
    const st = store.getState();
    const already = st.queue.some((t) => t.id === song.id);
    // optimistic: visible in Up next immediately, even from other pages
    // while something else plays; streams resolve in the background
    st.enqueue(song);
    if (!already) showToast("Added to queue");
    const dz = dzOf(song);
    if (dz === null || song.streamUrl !== "") return;
    resolveTrack(dz)
      .then((full) => store.getState().swapQueued(song.id, full))
      .catch(() => {
        if (!already) store.getState().removeFromQueue(song.id);
        showToast("Couldn't add to queue — try again");
      });
  }

  async function toggleLike(song: Song) {
    const key = likeKeyFor(song);
    if (key === null) return;
    const next = !likes.has(key);
    // Optimistic: the heart fills instantly, even offline.
    setLikes((prev) => {
      const n = new Set(prev);
      if (next) n.add(key);
      else n.delete(key);
      return n;
    });
    setLikedRows((prev) =>
      next
        ? [
            ...prev.filter((r) => r.key !== key),
            {
              key,
              title: song.title,
              artist: song.artist,
              album: song.album,
              cover: song.coverUrl,
            },
          ]
        : prev.filter((r) => r.key !== key)
    );
    try {
      await setLiked(song, next);
      await refreshLikes();
    } catch {
      // Music server unreachable (offline): local state already updated;
      // the account sync below still queues the change.
    }
    const session = accountRef.current;
    if (session !== null) {
      const change = toChange(song, next);
      // null → local-only like (library row without a Deezer ID):
      // stays on this device, never uploaded.
      if (change !== null) {
        enqueueChange(session.userId, change);
        scheduleSync();
      }
    }
  }

  // --- Account + liked-songs sync --------------------------------------
  const [account, setAccount] = useState<Session | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const accountRef = useRef<Session | null>(null);
  const syncActive = useRef(false);
  // Background sync engine (see lib/likes-sync-worker.ts). Started once
  // on mount; `scheduleSync` below just nudges it.
  const likesSyncRef = useRef<LikesSyncHandle | null>(null);
  const runSyncRef = useRef<(session: Session) => Promise<void>>(
    () => Promise.resolve()
  );

  // Keep mutable refs fresh every render (no deps array on purpose).
  useEffect(() => {
    accountRef.current = account;
    runSyncRef.current = runSync;
  });

  /** Apply one server change to the music server + local state. Throws
   *  offline so the cursor does not advance past unapplied changes. */
  async function applyRemoteLike(change: RemoteLike): Promise<void> {
    const m = /^dz:(\d+)$/.exec(change.track_id);
    if (m === null) return;
    const dz = Number(m[1]);
    const song: Song = {
      id: `dz-${dz}`,
      title: change.title,
      artist: change.artist,
      album: change.album,
      duration: 0,
      coverUrl: change.cover,
      streamUrl: "",
      deezerId: dz,
    };
    await setLiked(song, change.liked);
    const key = `dz:${dz}`;
    setLikes((prev) => {
      const n = new Set(prev);
      if (change.liked) n.add(key);
      else n.delete(key);
      return n;
    });
    setLikedRows((prev) =>
      change.liked
        ? [
            ...prev.filter((r) => r.key !== key),
            {
              key,
              title: change.title,
              artist: change.artist,
              album: change.album,
              cover: change.cover,
            },
          ]
        : prev.filter((r) => r.key !== key)
    );
  }

  /** Push queued changes, then pull + apply. Merge-safe: push first so
   *  local edits are on the server before remote state is applied. */
  async function runSync(session: Session): Promise<void> {
    if (syncActive.current) return;
    syncActive.current = true;
    setSyncing(true);
    setSyncError(null);
    try {
      for (;;) {
        const batch = loadOutbox(session.userId).slice(0, 500);
        if (batch.length === 0) break;
        await pushLikes(batch);
        dropPushed(session.userId, batch.length);
      }
      let since = getCursor(session.userId);
      for (;;) {
        const { changes, cursor } = await pullLikes(since);
        for (const c of changes) {
          await applyRemoteLike(c);
          since = c.version;
          setCursor(session.userId, since);
        }
        if (changes.length < 500) {
          setCursor(session.userId, Math.max(since, cursor));
          break;
        }
      }
    } catch (e) {
      if (e instanceof AccountsError && e.code === "logged-out") {
        setAccount(null);
      } else {
        setSyncError(
          e instanceof AccountsError ? e.message : "Sync failed — will retry."
        );
      }
      throw e;
    } finally {
      syncActive.current = false;
      setSyncing(false);
    }
  }

  /** Nudge the background sync engine (debounced + coalesced there). */
  function scheduleSync(): void {
    likesSyncRef.current?.requestSync();
  }

  /** First login: seed the outbox from existing local likes so neither
   *  side is overwritten — local and server merge via last-write-wins. */
  function seedOutboxFromLocal(session: Session): void {
    const byDbId = new Map(library.map((t) => [t.id, t]));
    for (const row of likedRows) {
      if (/^dz:\d+$/.test(row.key)) {
        enqueueChange(session.userId, {
          track_id: row.key,
          liked: true,
          updated_at: new Date().toISOString(),
          title: row.title,
          artist: row.artist,
          album: row.album,
          cover: row.cover,
        });
        continue;
      }
      const dbm = /^db:(\d+)$/.exec(row.key);
      if (dbm !== null) {
        const song = byDbId.get(`db-${dbm[1]}`);
        // TODO(resolve): upgrade db-only likes to dz: IDs via Deezer
        // search + match scoring so they can sync; until then they stay
        // local and are never uploaded.
        const change = song !== undefined ? toChange(song, true) : null;
        if (change !== null) enqueueChange(session.userId, change);
      }
    }
  }

  function handleAuthed(session: Session): void {
    seedOutboxFromLocal(session);
    setAccount(session);
    // Clear both the auth hash and any one-time OAuth query (?code=&state=).
    try {
      const clean = new URL(window.location.href);
      clean.hash = "";
      clean.searchParams.delete("code");
      clean.searchParams.delete("state");
      window.history.replaceState(null, "", clean.toString());
    } catch {
      window.location.hash = "";
    }
    setIsAuthRoute(false);
    runSync(session).catch(() => {
      // Error state is set inside runSync; retry is scheduled by callers.
    });
  }

  async function handleSignOut(): Promise<void> {
    likesSyncRef.current?.cancel();
    await logout();
    setAccount(null);
    showToast("Signed out");
  }

  /** Account button: signed-out users go to sign-in, signed-in users
   *  go to their profile page. */
  const handleOpenAccount = useCallback(() => {
    if (accountRef.current !== null) go("profile");
    else window.location.hash = "#signin";
  }, []);
  const handleProfileLoggedOut = useCallback(() => {
    setAccount(null);
  }, []);
  const handleEmailChanged = useCallback((email: string) => {
    setAccount((prev) => (prev !== null ? { ...prev, email } : prev));
    void updateStoredEmail(email);
  }, []);

  useEffect(() => {
    // Background worker: auto-sync likes whenever we're online, plus
    // heartbeat + cross-tab + visibility triggers (see the module docs).
    const handle = startLikesSync({
      isSignedIn: () => accountRef.current !== null,
      hasPending: () => {
        const session = accountRef.current;
        return session !== null && loadOutbox(session.userId).length > 0;
      },
      run: async () => {
        const session = accountRef.current;
        if (session !== null) await runSyncRef.current(session);
      },
    });
    likesSyncRef.current = handle;
    loadSession().then((session) => {
      if (session !== null) {
        setAccount(session);
        runSync(session).catch(() => {});
      }
    });
    return () => {
      handle.stop();
      likesSyncRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function downloadSong(dz: number, mapKey: string) {
    const now = Date.now();
    if (now < dlCooldownUntil.current) {
      const secs = Math.ceil((dlCooldownUntil.current - now) / 1000);
      showToast(`Downloads paused (rate limited) — retry in ${secs}s`);
      return;
    }
    setDl((prev) => ({ ...prev, [mapKey]: { state: "working", progress: 0 } }));
    showToast("Downloading…");
    // wait for a slot (2 max) with ~2s spacing between starts
    let queuedShown = false;
    for (;;) {
      if (dlActive.current < 2) {
        const gap = 2000 - (Date.now() - dlLastStart.current);
        if (gap <= 0) break;
        if (!queuedShown) {
          queuedShown = true;
          setDl((prev) => ({ ...prev, [mapKey]: { state: "queued", progress: 0 } }));
        }
        await new Promise((r) => setTimeout(r, Math.min(gap, 500)));
        continue;
      }
      if (!queuedShown) {
        queuedShown = true;
        setDl((prev) => ({ ...prev, [mapKey]: { state: "queued", progress: 0 } }));
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (queuedShown) {
      setDl((prev) => ({ ...prev, [mapKey]: { state: "working", progress: 0 } }));
    }
    dlActive.current++;
    dlLastStart.current = Date.now();
    try {
      await enqueueDownload(dz);
      await waitForDownload(dz, (progress) =>
        setDl((prev) => ({ ...prev, [mapKey]: { state: "working", progress } }))
      );
      setDl((prev) => ({ ...prev, [mapKey]: { state: "done", progress: 100 } }));
      markDownloaded(dz);
      showToast("Downloaded");
      await refreshLibrary();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "download failed";
      if (/429|throttl|rate.?limit|sign.?in|bot/i.test(msg)) {
        dlCooldownUntil.current = Date.now() + 5 * 60 * 1000;
        showToast("The source is rate limiting requests. Pausing for a few minutes.");
      } else if (/extract|unsupported url|ejs|js runtime|challenge/i.test(msg)) {
        showToast("Download failed (extractor) — see Settings → Diagnostics");
      } else {
        showToast("Download failed");
      }
      setDl((prev) => ({ ...prev, [mapKey]: { state: "error", progress: 0 } }));
    } finally {
      dlActive.current = Math.max(0, dlActive.current - 1);
    }
  }

  function dlFor(mapKey: string): { state: DlState; progress: number } {
    return dl[mapKey] ?? { state: "idle", progress: 0 };
  }

  const libraryDz = useMemo(
    () =>
      new Set(
        library
          .map((t) => t.deezerId)
          .filter((d): d is number => typeof d === "number")
      ),
    [library]
  );

  /** True when the song exists as a file: library row, finished queue job,
   *  a Deezer id already in the library, or the persistent download
   *  registry (marks survive list re-renders and restarts). */
  function isDownloaded(song: Song, mapKey: string): boolean {
    if (song.id.startsWith("db-")) return true;
    if (dlFor(mapKey).state === "done") return true;
    const dz = song.deezerId;
    if (dz === null || dz === undefined) return false;
    return libraryDz.has(dz) || downloadedDz.has(dz);
  }

  async function deleteSong(song: Song) {
    const m = /^db-(\d+)$/.exec(song.id);
    if (m === null) return;
    try {
      await deleteTrack(Number(m[1]));
    } catch {
      showToast("Delete failed");
      return;
    }
    const dz = dzOf(song);
    if (dz !== null) unmarkDownloaded(dz);
    store.getState().removeFromQueue(song.id);
    await refreshLibrary();
    await refreshLikes();
    // deleted while playing: move on (or pause when nothing is left)
    if (activeTrack?.id === song.id) {
      const st = store.getState();
      const stillThere =
        st.queue.some((t) => t.id === song.id) ||
        st.library.some((t) => t.id === song.id);
      if (!stillThere) {
        if (st.queue.length + st.library.length === 0) {
          if (st.playing) st.toggle();
        } else {
          st.next(true);
        }
      }
    }
    showToast("Deleted");
  }

  function cardFor(
    song: Song,
    downloadableDz: number | null,
    mapKey: string,
    onPlay: () => void,
    active = false,
    swipe: SwipeLeftKind = "download"
  ) {
    const key = likeKeyFor(song);
    const d = dlFor(mapKey);
    const downloaded = isDownloaded(song, mapKey);
    const onDownloadNow = () => {
      if (downloadableDz !== null) downloadSong(downloadableDz, mapKey);
    };
    return (
      <SongCard
        key={song.id}
        song={song}
        downloadableDz={downloadableDz}
        liked={key !== null && likes.has(key)}
        dl={d.state}
        dlProgress={d.progress}
        downloaded={downloaded}
        active={active}
        resolving={
          resolving &&
          resolvingDz !== null &&
          song.id === `dz-${resolvingDz}`
        }
        swipeLeft={swipe}
        onToggleLike={() => toggleLike(song)}
        onDownload={onDownloadNow}
        onDelete={swipe === "delete" ? () => void deleteSong(song) : null}
        onSwipeLeft={
          swipe === "delete"
            ? () => void deleteSong(song)
            : swipe === "like"
              ? () => toggleLike(song)
              : onDownloadNow
        }
        onAddToQueue={() => addToQueue(song)}
        onPlay={onPlay}
        localOnly={isLocalOnly(song)}
      />
    );
  }

  const likedSongs: Song[] = likedRows.map((r) =>
    r.key.startsWith("dz:")
      ? {
          id: `dz-${r.key.slice(3)}`,
          title: r.title,
          artist: r.artist,
          album: r.album,
          duration: 0,
          coverUrl: r.cover,
          streamUrl: "",
          deezerId: Number(r.key.slice(3)) || null,
        }
      : (
          library.find((t) => t.id === `db-${r.key.slice(3)}`) ?? {
            id: r.key,
            title: r.title,
            artist: r.artist,
            album: r.album,
            duration: 0,
            coverUrl: r.cover,
            streamUrl: "",
            deezerId: null,
          }
        )
  );

  /** Now-playing download state (sheet + desktop sidebar share it): the
   *  active track has no list row, so derive progress + persistence here. */
  const activeDz = activeTrack !== undefined ? dzOf(activeTrack) : null;
  const activeDlKey = activeTrack !== undefined ? `np-${activeTrack.id}` : "";
  const activeDlState = activeTrack !== undefined ? dl[activeDlKey]?.state : undefined;
  const activeDownloading = activeDlState === "working" || activeDlState === "queued";
  const activeDownloaded =
    activeTrack !== undefined &&
    (activeTrack.id.startsWith("db-") ||
      activeDlState === "done" ||
      (activeDz !== null && (libraryDz.has(activeDz) || downloadedDz.has(activeDz))));

  if (isAuthRoute) {
    return (
      <MotionConfig reducedMotion="user">
        <AuthPage
          onAuthed={handleAuthed}
          onBack={() => {
            window.location.hash = "";
            setIsAuthRoute(false);
          }}
        />
      </MotionConfig>
    );
  }

return (
    <MotionConfig reducedMotion="user">
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      {/* Desktop header */}
      <Header
        theme={theme}
        onPickTheme={setTheme}
        query={query}
        onQueryChange={setQuery}
        onSubmitSearch={() => {
          runSearch();
          go("search");
        }}
        onPickSuggest={pickSuggest}
        onClearSearch={() => {
          setQuery("");
          setHits([]);
          setSearchFailed(false);
        }}
        onOpenDiagnostics={() => go("diagnostics")}
        accountEmail={account?.email ?? null}
        onOpenAccount={handleOpenAccount}
        onOpenUpdates={() => go("update")}
        className="hidden md:flex"
        page={page}
      />

      {/* Mobile header */}
      <MobileHeader
        page={page}
        onNavigate={go}
        query={query}
        onQueryChange={setQuery}
        onSubmitSearch={() => {
          runSearch();
          go("search");
        }}
        onPickSuggest={pickSuggest}
        onClearSearch={() => {
          setQuery("");
          setHits([]);
          setSearchFailed(false);
        }}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenSearch={() => {
          runSearch();
          go("search");
        }}
        className="md:hidden"
      />

      <div className="flex min-h-0 flex-1">
        {/* Desktop sidebar */}
        <div className="hidden md:block">
          <Sidebar
            page={page}
            onNavigate={go}
            libraryCount={library.length}
            likedCount={likes.size}
            accountEmail={account?.email ?? null}
            onOpenAccount={handleOpenAccount}
          />
        </div>

        {/* Main content */}
        <CustomScroller
          scrollRef={mainRef}
          fillet
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          className="space-y-6 md:p-4 md:sm:p-6 max-md:pt-[calc(var(--top-bar-h,0px)+0.75rem)] pb-[calc(var(--bottom-bars-h,0px)+env(safe-area-inset-bottom)+4px)]"
        >
          {dlStatus?.health === "outdated" && (
            <div className="flex items-center gap-3 rounded-2xl border border-border/40 bg-background/60 px-4 py-3 text-sm backdrop-blur-xl md:mx-4">
              <span className="flex-1 text-muted-foreground">
                Downloader needs an update.
              </span>
              <button
                type="button"
                onClick={async () => {
                  try {
                    const s = await postDownloaderUpdate();
                    setDlStatus(s);
                    if (s.update_outcome !== undefined && s.update_outcome !== null) {
                      showToast(s.update_outcome);
                    } else if (s.health === "ok" || s.health === "Ok") {
                      showToast("Downloader updated");
                    } else if (s.last_error !== "") {
                      showToast(s.last_error);
                    } else {
                      showToast(`Update finished — still ${s.health}`);
                    }
                  } catch {
                    showToast("Update failed");
                  }
                }}
                className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
              >
                Update
              </button>
            </div>
          )}
          {dlStatus?.health === "rate_limited" && (
            <div className="flex items-center gap-3 rounded-2xl border border-border/40 bg-background/60 px-4 py-3 text-sm backdrop-blur-xl md:mx-4">
              <span className="flex-1 text-muted-foreground">
                The source is rate limiting requests — streaming and downloads may
                fail. Signing in with YouTube usually fixes it.
              </span>
              <button
                type="button"
                onClick={() => go("diagnostics")}
                className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
              >
                Fix
              </button>
            </div>
          )}
          {dlStatus?.health === "js_runtime_missing" && (
            <div className="flex items-center gap-3 rounded-2xl border border-border/40 bg-background/60 px-4 py-3 text-sm backdrop-blur-xl md:mx-4">
              <span className="flex-1 text-muted-foreground">
                A JavaScript runtime is needed — install Deno or Node 22+, then
                re-check.
              </span>
              <button
                type="button"
                onClick={() => go("diagnostics")}
                className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
              >
                Details
              </button>
            </div>
          )}
          {page === "search" && (
            <section className="space-y-3 md:mx-4">
              {searching ? (
                <div className="space-y-2 motion-reduce:animate-none" aria-hidden>
                  <div className="h-16 animate-pulse rounded-[15px] bg-muted" />
                  <div className="h-16 animate-pulse rounded-[15px] bg-muted" />
                </div>
              ) : hits.length === 0 ? (
                searchFailed || health === null ? (
                  <OfflineState
                    detail={
                      query.trim() === ""
                        ? undefined
                        : `No reply for “${query.trim()}”.`
                    }
                    onRetry={() => runSearch()}
                  />
                ) : query.trim() === "" ? (
                  <EmptyState
                    icon={SearchX}
                    variant="inline"
                    title="Search for a song or artist"
                    body="Results land here — try a title, artist, or album."
                  />
                ) : (
                  <EmptyState
                    icon={SearchX}
                    variant="inline"
                    title="No results"
                    body={`Nothing matched “${query.trim()}” — check the spelling or try another song.`}
                  />
                )
              ) : (
                <div className="grid grid-cols-[minmax(0,1fr)] gap-3 2xl:grid-cols-[repeat(2,minmax(0,1fr))]">
                  <AnimatePresence initial={false}>
                    {hits.map((h) => {
                      const s = hitToSong(h);
                      const k = `hit-dz:${h.dz}`;
                      return (
                        <Anim key={k} id={k}>
                          {cardFor(
                            s,
                            h.dz,
                            k,
                            () => playHit(h),
                            false,
                            isDownloaded(s, k) ? "like" : "download"
                          )}
                        </Anim>
                      );
                    })}
                  </AnimatePresence>
                </div>
              )}
            </section>
          )}

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={page}
              initial={{ opacity: 0, x: reduceMotion ? 0 : 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: reduceMotion ? 0 : -20, transition: { duration: 0.1 } }}
              transition={{ duration: 0.18 }}
              className="space-y-6"
            >
          {page === "home" && (
            <section className="space-y-3 md:mx-4">
              {loading ? (
                <div className="space-y-2 motion-reduce:animate-none" aria-hidden>
                  <div className="h-16 animate-pulse rounded-[15px] bg-muted" />
                  <div className="h-16 animate-pulse rounded-[15px] bg-muted" />
                </div>
              ) : suggestions.length === 0 ? (
                loadError !== null || health === null ? (
                  <OfflineState
                    detail={loadError ?? undefined}
                    onRetry={() => {
                      refreshLibrary();
                      fetchHealth()
                        .then(setHealth)
                        .catch(() => setHealth(null));
                    }}
                  />
                ) : (
                  <EmptyState
                    icon={Disc3}
                    variant="inline"
                    title="Nothing suggested yet"
                    body="New picks appear here once the server responds."
                  />
                )
              ) : (
                <div className="grid grid-cols-[minmax(0,1fr)] gap-3 2xl:grid-cols-[repeat(2,minmax(0,1fr))]">
                  <AnimatePresence initial={false}>
                    {suggestions.map((h) => {
                      const s = hitToSong(h);
                      const k = `sug-dz:${h.dz}`;
                      return (
                        <Anim key={k} id={k}>
                          {cardFor(
                            s,
                            h.dz,
                            k,
                            () => playHit(h),
                            false,
                            isDownloaded(s, k) ? "like" : "download"
                          )}
                        </Anim>
                      );
                    })}
                  </AnimatePresence>
                </div>
              )}
            </section>
          )}

          {page === "library" && (
            <section className="space-y-3 md:mx-4">
              {loading ? (
                <div className="space-y-2 motion-reduce:animate-none" aria-hidden>
                  <div className="h-16 animate-pulse rounded-[15px] bg-muted" />
                  <div className="h-16 animate-pulse rounded-[15px] bg-muted" />
                </div>
              ) : loadError !== null ? (
                <OfflineState
                  detail={loadError}
                  onRetry={() => {
                    refreshLibrary();
                    fetchHealth()
                      .then(setHealth)
                      .catch(() => setHealth(null));
                  }}
                />
              ) : library.length === 0 ? (
                <EmptyState
                  icon={Library}
                  variant="inline"
                  title="Your library is empty"
                  body="Nothing downloaded yet — pick a song below or search above, then ⋯ → Download."
                />
              ) : (
                <div className="grid grid-cols-[minmax(0,1fr)] gap-3 2xl:grid-cols-[repeat(2,minmax(0,1fr))]">
                  <AnimatePresence initial={false}>
                    {library.map((t) => (
                      <Anim key={`lib-${t.id}`} id={`lib-${t.id}`}>
                        {cardFor(
                          t,
                          null,
                          `lib-${t.id}`,
                          () => playSong(t),
                          t.id === activeTrack?.id,
                          "delete"
                        )}
                      </Anim>
                    ))}
                  </AnimatePresence>
                </div>
              )}
            </section>
          )}

          {page === "liked" && (
            <section className="space-y-3 md:mx-4">
              {likedSongs.length === 0 ? (
                <EmptyState
                  icon={Heart}
                  variant="inline"
                  title="Nothing liked yet"
                  body="Use ⋯ → Like on any song and it lands here."
                />
              ) : (
                <div className="grid grid-cols-[minmax(0,1fr)] gap-3 2xl:grid-cols-[repeat(2,minmax(0,1fr))]">
                  <AnimatePresence initial={false}>
                    {likedSongs.map((t) => {
                      const k = `liked-${t.id}`;
                      return (
                        <Anim key={k} id={k}>
                          {cardFor(
                            t,
                            dzOf(t),
                            k,
                            () => playSong(t),
                            t.id === activeTrack?.id,
                            isDownloaded(t, k) ? "like" : "download"
                          )}
                        </Anim>
                      );
                    })}
                  </AnimatePresence>
                </div>
              )}
            </section>
          )}

          {page === "lyrics" && (
            <div className="md:mx-4">
              <LyricsPage />
            </div>
          )}

          {page === "profile" && (
            <ProfilePage
              account={account}
              syncing={syncing}
              lastError={syncError}
              libraryCount={library.length}
              likedCount={likes.size}
              pendingCount={
                account !== null ? loadOutbox(account.userId).length : 0
              }
              onSignIn={() => {
                window.location.hash = "#signin";
              }}
              onSignOut={() => void handleSignOut()}
              onSyncNow={() => scheduleSync()}
              onLoggedOut={handleProfileLoggedOut}
              onEmailChanged={handleEmailChanged}
            />
          )}

          {page === "diagnostics" && (
            <div className="space-y-3 md:mx-4">
              <Diagnostics onToast={showToast} />
            </div>
          )}

          {page === "update" && <UpdatePage />}
            </motion.div>
          </AnimatePresence>
        </CustomScroller>

        {/* Desktop now playing sidebar */}
        <div className="hidden xl:block">
          <NowPlaying
            track={activeTrack}
            resolving={resolving}
            buffering={buffering}
            liked={
              activeTrack !== undefined &&
              (() => {
                const k = likeKeyFor(activeTrack);
                return k !== null && likes.has(k);
              })()
            }
            downloadable={
              activeTrack !== undefined && dzOf(activeTrack) !== null
            }
            downloading={activeDownloading}
            downloaded={activeDownloaded}
            onToggleLike={() => {
              if (activeTrack !== undefined) toggleLike(activeTrack);
            }}
            onRetryMatch={() => void retryMatch()}
            onDownload={() => {
              if (activeTrack !== undefined) {
                const dz = dzOf(activeTrack);
                if (dz !== null) downloadSong(dz, `np-${activeTrack.id}`);
              }
            }}
            queue={queue}
            activeQueueId={
              index < queue.length ? queue[index].id : null
            }
            onRemoveFromQueue={(id) => store.getState().removeFromQueue(id)}
            onPlayQueued={(id) => {
              const found =
                queue.find((t) => t.id === id) ??
                library.find((t) => t.id === id);
              if (found) store.getState().playTrack(found);
            }}
            onNext={() => store.getState().next(true)}
            onPrev={() => store.getState().prev()}
          />
        </div>
      </div>

      {/* Desktop player bar */}
      <PlayerBar
        className="hidden md:flex"
        onOpenLyrics={() => go("lyrics")}
        lyricsActive={page === "lyrics"}
      />

      {/* Mobile bottom stack */}
      <div id="bottom-stack" className="fixed inset-x-0 bottom-0 z-40 md:hidden">
        <div className="glass-bar relative flex flex-col overflow-hidden rounded-t-3xl border-t border-border/40 pb-[env(safe-area-inset-bottom)]">
          {/* ambient: blurred cover glow, track follows now playing */}
          {activeTrack !== undefined && activeTrack.coverUrl !== "" && (
            <div aria-hidden className="pointer-events-none absolute inset-0">
              <img
                key={activeTrack.coverUrl}
                src={activeTrack.coverUrl}
                alt=""
                draggable={false}
                className="h-full w-full scale-125 object-cover opacity-40 blur-2xl saturate-150"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-background/70 via-background/30 to-transparent" />
            </div>
          )}
          <div className="relative z-10 flex flex-col">
            <div className="flex items-center px-3 py-1.5">
              <MiniPlayer onOpen={() => setSheetOpen(true)} />
            </div>
            <MobileSeekBar />
            <MobileNav page={page} onNavigate={go} />
          </div>
        </div>
      </div>

      <AnimatePresence>
        {settingsOpen && (
          <SettingsSheet
            onClose={() => setSettingsOpen(false)}
            theme={theme}
            onPickTheme={setTheme}
            onOpenAccount={handleOpenAccount}
            onOpenDiagnostics={() => go("diagnostics")}
            onOpenUpdates={() => go("update")}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {sheetOpen && (
          <NowPlayingSheet
            onClose={() => setSheetOpen(false)}
            liked={
              activeTrack !== undefined &&
              (() => {
                const k = likeKeyFor(activeTrack);
                return k !== null && likes.has(k);
              })()
            }
            downloadable={
              activeTrack !== undefined && dzOf(activeTrack) !== null
            }
            downloading={activeDownloading}
            downloaded={activeDownloaded}
            onToggleLike={() => {
              if (activeTrack !== undefined) toggleLike(activeTrack);
            }}
            onDownload={() => {
              if (activeTrack !== undefined) {
                const dz = dzOf(activeTrack);
                if (dz !== null) downloadSong(dz, `np-${activeTrack.id}`);
              }
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toast !== null && (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: 12, x: "-50%" }}
            animate={{ opacity: 1, y: 0, x: "-50%" }}
            exit={{ opacity: 0, x: "-50%" }}
            transition={{ type: "spring", stiffness: 400, damping: 35 }}
            className="pointer-events-none fixed bottom-36 left-1/2 z-[110] rounded-full border border-border/50 bg-background/95 px-5 py-2.5 text-sm text-foreground shadow-lg backdrop-blur-2xl md:bottom-28"
          >
            {toast.msg}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
    </MotionConfig>
  );
}
