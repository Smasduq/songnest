import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { Heart, Home, Library } from "lucide-react";

import { NowPlaying } from "@/components/now-playing";
import { Sidebar, type Page } from "@/components/sidebar";
import { Header, useTheme } from "@/components/header";
import { PlayerBar } from "@/components/player-bar";
import { SongCard, type DlState } from "@/components/song-card";
import { useCurrentTrack, usePlayer } from "@/player/store";
import {
  dzOf,
  enqueueDownload,
  fetchHealth,
  fetchLibrary,
  fetchLikedRows,
  fetchLikes,
  fetchSuggestions,
  likeKeyFor,
  resolveTrack,
  searchSongs,
  setLiked,
  waitForDownload,
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
  };
}

/** Fade/slide wrapper so lists animate in and out (mobile feel). */
function Anim({ id, children }: { id: string; children: ReactNode }) {
  return (
    <motion.div
      key={id}
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
    >
      {children}
    </motion.div>
  );
}

export default function App() {
  const [page, setPage] = useState<Page>("home");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [suggestions, setSuggestions] = useState<SearchHit[]>([]);
  const [likes, setLikes] = useState<Set<string>>(new Set());
  const [likedRows, setLikedRows] = useState<LikedRow[]>([]);
  const [dl, setDl] = useState<Record<string, { state: DlState; progress: number }>>({});
  const [health, setHealth] = useState<Health | null>(null);
  const { theme, setTheme } = useTheme();

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
    setDl((prev) => ({ ...prev, [mapKey]: { state: "working", progress: 0 } }));
    try {
      await enqueueDownload(dz);
      await waitForDownload(dz, (progress) =>
        setDl((prev) => ({ ...prev, [mapKey]: { state: "working", progress } }))
      );
      setDl((prev) => ({ ...prev, [mapKey]: { state: "done", progress: 100 } }));
      await refreshLibrary();
    } catch {
      setDl((prev) => ({ ...prev, [mapKey]: { state: "error", progress: 0 } }));
    }
  }

  function dlFor(mapKey: string): { state: DlState; progress: number } {
    return dl[mapKey] ?? { state: "idle", progress: 0 };
  }

  function cardFor(
    song: Song,
    downloadableDz: number | null,
    mapKey: string,
    onPlay: () => void,
    active = false
  ) {
    const key = likeKeyFor(song);
    const d = dlFor(mapKey);
    return (
      <SongCard
        key={song.id}
        song={song}
        downloadableDz={downloadableDz}
        liked={key !== null && likes.has(key)}
        dl={d.state}
        dlProgress={d.progress}
        active={active}
        onToggleLike={() => toggleLike(song)}
        onDownload={() => {
          if (downloadableDz !== null) downloadSong(downloadableDz, mapKey);
        }}
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
          }
        )
  );

  return (
    <div className="flex h-dvh flex-col gap-3 overflow-hidden bg-background p-3">
      <Header theme={theme} onPickTheme={setTheme} server={health} />
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="hidden md:block">
          <Sidebar
            page={page}
            onNavigate={setPage}
            onSearchFocus={() =>
              document.getElementById("songnest-search")?.focus()
            }
            libraryCount={library.length}
            likedCount={likes.size}
          />
        </div>

        <main className="scroller min-w-0 flex-1 space-y-6 rounded-3xl border border-border/40 bg-background/40 p-4 backdrop-blur-xl sm:p-6">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              runSearch();
            }}
          >
            <input
              id="songnest-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search Deezer — artist title"
              className="h-11 min-w-0 flex-1 rounded-full border border-border/60 bg-background/60 px-5 text-sm text-foreground backdrop-blur placeholder:text-foreground/40 focus:outline-none focus:ring-2 focus:ring-foreground/30"
            />
            <button
              type="submit"
              className="h-11 rounded-full bg-foreground px-6 text-sm font-medium text-background hover:bg-foreground/90"
            >
              {searching ? "…" : "Search"}
            </button>
          </form>

          {hits.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xl font-semibold tracking-tight text-foreground">
                Results
              </h2>
              <div className="grid grid-cols-[minmax(0,1fr)] gap-3 2xl:grid-cols-[repeat(2,minmax(0,1fr))]">
                <AnimatePresence initial={false}>
                  {hits.map((h) => (
                    <Anim key={`hit-dz:${h.dz}`} id={`hit-dz:${h.dz}`}>
                      {cardFor(hitToSong(h), h.dz, `hit-dz:${h.dz}`, () =>
                        playHit(h)
                      )}
                    </Anim>
                  ))}
                </AnimatePresence>
              </div>
            </section>
          )}

          {page === "home" && (
            <section className="space-y-3">
              <h2 className="text-xl font-semibold tracking-tight text-foreground">
                Suggested for you
              </h2>
              {loading ? (
                <p className="text-sm text-foreground/60">Loading…</p>
              ) : suggestions.length === 0 ? (
                <p className="text-sm text-foreground/60">
                  No suggestions right now — is the server reachable?
                </p>
              ) : (
                <div className="grid grid-cols-[minmax(0,1fr)] gap-3 2xl:grid-cols-[repeat(2,minmax(0,1fr))]">
                  <AnimatePresence initial={false}>
                    {suggestions.map((h) => (
                      <Anim key={`sug-dz:${h.dz}`} id={`sug-dz:${h.dz}`}>
                        {cardFor(hitToSong(h), h.dz, `sug-dz:${h.dz}`, () =>
                          playHit(h)
                        )}
                      </Anim>
                    ))}
                  </AnimatePresence>
                </div>
              )}
            </section>
          )}

          {page === "library" && (
            <section className="space-y-3">
              <h2 className="text-xl font-semibold tracking-tight text-foreground">
                Your Library
              </h2>
              {loading ? (
                <p className="text-sm text-foreground/60">Loading library…</p>
              ) : library.length === 0 ? (
                <p className="text-sm text-foreground/60">
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
                          t.id === activeTrack?.id
                        )}
                      </Anim>
                    ))}
                  </AnimatePresence>
                </div>
              )}
              {loadError !== null && (
                <p className="text-sm text-foreground/60">
                  Library unreachable ({loadError}) — is the server on :8787?
                </p>
              )}
            </section>
          )}

          {page === "liked" && (
            <section className="space-y-3">
              <h2 className="text-xl font-semibold tracking-tight text-foreground">
                Liked Songs
              </h2>
              {likedSongs.length === 0 ? (
                <p className="text-sm text-foreground/60">
                  Nothing liked yet — use ⋯ → Like on any song.
                </p>
              ) : (
                <div className="grid grid-cols-[minmax(0,1fr)] gap-3 2xl:grid-cols-[repeat(2,minmax(0,1fr))]">
                  <AnimatePresence initial={false}>
                    {likedSongs.map((t) => (
                      <Anim key={`liked-${t.id}`} id={`liked-${t.id}`}>
                        {cardFor(
                          t,
                          dzOf(t),
                          `liked-${t.id}`,
                          () => playSong(t),
                          t.id === activeTrack?.id
                        )}
                      </Anim>
                    ))}
                  </AnimatePresence>
                </div>
              )}
            </section>
          )}
        </main>

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

      <PlayerBar />

      <nav className="flex flex-shrink-0 items-center justify-around rounded-3xl border border-border/40 bg-background/60 px-4 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] backdrop-blur-xl md:hidden">
        {(
          [
            { id: "home", label: "Home", icon: Home },
            { id: "library", label: "Library", icon: Library },
            { id: "liked", label: "Liked", icon: Heart },
          ] as const
        ).map((item) => {
          const Icon = item.icon;
          const on = page === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setPage(item.id)}
              className={`flex flex-col items-center gap-1 rounded-2xl px-5 py-1.5 text-[11px] font-medium ${
                on ? "text-foreground" : "text-foreground/50"
              }`}
            >
              <Icon className="h-5 w-5" />
              {item.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
