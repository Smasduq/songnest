import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from "framer-motion";

import { NowPlaying } from "@/components/now-playing";
import { NowPlayingSheet } from "@/components/now-playing-sheet";
import { MiniPlayer } from "@/components/mini-player";
import { MobileSeekBar } from "@/components/mobile-seek-bar";
import { Diagnostics } from "@/components/diagnostics";
import { Sidebar, type Page } from "@/components/sidebar";
import { Header, useTheme } from "@/components/header";
import { MobileHeader } from "@/components/mobile-header";
import { MobileNav } from "@/components/mobile-nav";
import { PlayerBar } from "@/components/player-bar";
import { SongCard, type DlState, type SwipeLeftKind } from "@/components/song-card";
import { useCurrentTrack, usePlayer } from "@/player/store";
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
  getServerUrl,
  likeKeyFor,
  resolveTrack,
  searchSongs,
  setLiked,
  setServerUrl,
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
  const activeTrack = useCurrentTrack();
  // playback actions (stable refs from the store — safe to call anywhere)
  const store = usePlayer;

  const refreshLibrary = useCallback(async () => {
    try {
      store.getState().setLibrary(await fetchLibrary());
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

  useEffect(() => {
    refreshLibrary().finally(() => setLoading(false));
    fetchSuggestions()
      .then(setSuggestions)
      .catch(() => setSuggestions([]));
    refreshLikes();
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

  // deep link: #diagnostics opens the diagnostics page
  useEffect(() => {
    function applyHash() {
      if (window.location.hash === "#diagnostics") go("diagnostics");
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

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    try {
      setHits(await searchSongs(q));
    } catch {
      setHits([]);
    } finally {
      setSearching(false);
    }
  }, [query]);

  async function playHit(hit: SearchHit) {
    await store.getState().playDz(hit.dz);
    setHits([]);
    setQuery("");
  }

  function playSong(song: Song) {
    if (song.streamUrl !== "") {
      store.getState().playTrack(song);
      return;
    }
    const dz = dzOf(song);
    if (dz !== null) {
      void store.getState().playDz(dz);
    } else {
      store.getState().playTrack(song);
    }
  }

  function addToQueue(song: Song) {
    const dz = dzOf(song);
    if (dz !== null && song.streamUrl === "") {
      resolveTrack(dz)
        .then((full) => store.getState().enqueue(full))
        .catch(() => {});
    } else {
      store.getState().enqueue(song);
    }
  }

  async function toggleLike(song: Song) {
    const key = likeKeyFor(song);
    if (key === null) return;
    const next = !likes.has(key);
    try {
      await setLiked(song, next);
      await refreshLikes();
    } catch {
      // backend unreachable — ignore
    }
  }

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
   *  or a Deezer id already in the library. */
  function isDownloaded(song: Song, mapKey: string): boolean {
    if (song.id.startsWith("db-")) return true;
    if (dlFor(mapKey).state === "done") return true;
    return song.deezerId != null && libraryDz.has(song.deezerId);
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
        active={active}
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

return (
    <MotionConfig reducedMotion="user">
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      {/* Desktop header */}
      <Header
        theme={theme}
        onPickTheme={setTheme}
        server={health}
        query={query}
        onQueryChange={setQuery}
        onSubmitSearch={() => {
          runSearch();
          go("search");
        }}
        onClearSearch={() => {
          setQuery("");
          setHits([]);
        }}
        serverUrl={getServerUrl()}
        onSaveServerUrl={(url) => {
          setServerUrl(url);
          refreshLibrary();
          fetchHealth()
            .then(setHealth)
            .catch(() => setHealth(null));
        }}
        onOpenDiagnostics={() => go("diagnostics")}
        authed={health?.authed ?? false}
        onAuthChange={() => {
          fetchHealth()
            .then(setHealth)
            .catch(() => setHealth(null));
        }}
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
        onClearSearch={() => {
          setQuery("");
          setHits([]);
        }}
        onOpenSettings={() => go("diagnostics")}
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
          />
        </div>

        {/* Main content */}
        <main
          ref={mainRef}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          className="scroller min-w-0 flex-1 space-y-6 md:rounded-3xl md:border md:border-border/40 md:bg-background/40 md:p-4 md:backdrop-blur-xl md:sm:p-6 max-md:pt-[calc(var(--top-bar-h,0px)+0.75rem)] pb-[calc(var(--bottom-bars-h,0px)+env(safe-area-inset-bottom)+4px)]"
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
                    showToast("Downloader updated");
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
            <div className="rounded-2xl border border-border/40 bg-background/60 px-4 py-3 text-sm text-muted-foreground backdrop-blur-xl md:mx-4">
              The source is rate limiting requests — streaming and downloads may
              fail. Please wait a few minutes and try again.
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
              <h2 className="text-xl font-semibold tracking-tight text-foreground">
                Results
              </h2>
              {searching ? (
                <p className="text-sm text-muted-foreground">Searching…</p>
              ) : hits.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Search for a song or artist.
                </p>
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
              <h2 className="text-xl font-semibold tracking-tight text-foreground">
                Suggested for you
              </h2>
              {loading ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : suggestions.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No suggestions right now — is the server reachable?
                </p>
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
              <h2 className="text-xl font-semibold tracking-tight text-foreground">
                Your Library
              </h2>
              {loading ? (
                <p className="text-sm text-muted-foreground">Loading library…</p>
              ) : library.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing downloaded yet — pick a song below or search above,
                  then ⋯ → Download.
                </p>
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
              {loadError !== null && (
                <p className="text-sm text-muted-foreground">
                  Library unreachable ({loadError}) — is the server on :8787?
                </p>
              )}
            </section>
          )}

          {page === "liked" && (
            <section className="space-y-3 md:mx-4">
              <h2 className="text-xl font-semibold tracking-tight text-foreground">
                Liked Songs
              </h2>
              {likedSongs.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing liked yet — use ⋯ → Like on any song.
                </p>
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

          {page === "diagnostics" && (
            <div className="md:mx-4">
              <Diagnostics onToast={showToast} />
            </div>
          )}
            </motion.div>
          </AnimatePresence>
        </main>

        {/* Desktop now playing sidebar */}
        <div className="hidden xl:block">
          <NowPlaying
            track={activeTrack}
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
            downloading={false}
            onToggleLike={() => {
              if (activeTrack !== undefined) toggleLike(activeTrack);
            }}
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
              const found = queue.find((t) => t.id === id);
              if (found) store.getState().playTrack(found);
            }}
            onNext={() => store.getState().next(true)}
            onPrev={() => store.getState().prev()}
          />
        </div>
      </div>

      {/* Desktop player bar */}
      <PlayerBar className="hidden md:flex" />

      {/* Mobile bottom stack */}
      <div id="bottom-stack" className="fixed inset-x-0 bottom-0 z-40 md:hidden">
        <div className="glass-bar relative flex flex-col rounded-t-3xl border-t border-border/40 pb-[env(safe-area-inset-bottom)]">
          <div className="flex items-center px-3 py-1.5">
            <MiniPlayer onOpen={() => setSheetOpen(true)} />
          </div>
          <MobileSeekBar />
          <MobileNav page={page} onNavigate={go} />
        </div>
      </div>

      <AnimatePresence>
        {sheetOpen && <NowPlayingSheet onClose={() => setSheetOpen(false)} />}
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
