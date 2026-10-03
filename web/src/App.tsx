import { useCallback, useEffect, useState } from "react";

import { NowPlaying } from "@/components/now-playing";
import { Sidebar, type Page } from "@/components/sidebar";
import { PlayerBar } from "@/components/player-bar";
import { SongCard, type DlState } from "@/components/song-card";
import {
  dzOf,
  enqueueDownload,
  fetchLibrary,
  fetchLikedRows,
  fetchLikes,
  fetchSuggestions,
  likeKeyFor,
  resolveTrack,
  searchSongs,
  setLiked,
  waitForDownload,
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

export default function App() {
  const [page, setPage] = useState<Page>("home");
  const [tracks, setTracks] = useState<Song[]>([]);
  const [queue, setQueue] = useState<Song[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [suggestions, setSuggestions] = useState<SearchHit[]>([]);
  const [likes, setLikes] = useState<Set<string>>(new Set());
  const [likedRows, setLikedRows] = useState<LikedRow[]>([]);
  const [dl, setDl] = useState<Record<string, { state: DlState; progress: number }>>({});
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);

  const playList = [...queue, ...tracks];
  const safeIndex = Math.min(activeIndex, Math.max(0, playList.length - 1));
  const activeTrack = playList[safeIndex];

  const refreshLibrary = useCallback(async () => {
    try {
      setTracks(await fetchLibrary());
      setLoadError(null);
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : "library failed");
    }
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
  }, [refreshLibrary, refreshLikes]);

  // select a song once it appears in the play list (avoids stale closures)
  useEffect(() => {
    if (pendingSelect === null) return;
    const idx = playList.findIndex((t) => t.id === pendingSelect);
    if (idx >= 0) {
      setActiveIndex(idx);
      setPendingSelect(null);
    }
  }, [playList, pendingSelect]);

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

  function queueSong(song: Song) {
    setQueue((prev) => {
      if (prev.some((t) => t.id === song.id)) return prev;
      return [...prev, song];
    });
    setPendingSelect(song.id);
  }

  async function playHit(hit: SearchHit) {
    try {
      queueSong(await resolveTrack(hit.dz));
      setHits([]);
      setQuery("");
    } catch {
      // resolve failed (throttled?) — leave everything untouched
    }
  }

  function playSong(song: Song) {
    if (song.streamUrl !== "") {
      const idx = playList.findIndex((t) => t.id === song.id);
      if (idx >= 0) {
        setActiveIndex(idx);
        return;
      }
    }
    const dz = dzOf(song);
    if (dz !== null) {
      resolveTrack(dz).then(queueSong).catch(() => {});
    } else {
      queueSong(song);
    }
  }

  function step(delta: 1 | -1) {
    if (playList.length === 0) return;
    setActiveIndex(
      (safeIndex + delta + playList.length) % playList.length
    );
  }

  function addToQueue(song: Song) {
    const dz = dzOf(song);
    if (dz !== null && song.streamUrl === "") {
      resolveTrack(dz)
        .then((full) =>
          setQueue((prev) =>
            prev.some((t) => t.id === full.id) ? prev : [...prev, full]
          )
        )
        .catch(() => {});
    } else {
      setQueue((prev) =>
        prev.some((t) => t.id === song.id) ? prev : [...prev, song]
      );
    }
  }

  function removeFromQueue(id: string) {
    setQueue((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx < 0) return prev;
      const next = prev.filter((t) => t.id !== id);
      if (idx < activeIndex) setActiveIndex((a) => Math.max(0, a - 1));
      return next;
    });
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
          tracks.find((t) => t.id === `db-${r.key.slice(3)}`) ?? {
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
    <div className="flex h-screen flex-col gap-3 bg-background p-3">
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="hidden md:block">
          <Sidebar
            page={page}
            onNavigate={setPage}
            onSearchFocus={() =>
              document.getElementById("songnest-search")?.focus()
            }
            libraryCount={tracks.length}
            likedCount={likes.size}
          />
        </div>

        <main className="min-w-0 flex-1 space-y-6 overflow-y-auto rounded-3xl border border-border/40 bg-background/40 p-6 backdrop-blur-xl">
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
              className="h-11 flex-1 rounded-full border border-border/60 bg-background/60 px-5 text-sm text-foreground backdrop-blur placeholder:text-foreground/40 focus:outline-none focus:ring-2 focus:ring-foreground/30"
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
              <div className="grid gap-3 2xl:grid-cols-2">
                {hits.map((h) =>
                  cardFor(hitToSong(h), h.dz, `hit-dz:${h.dz}`, () => playHit(h))
                )}
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
                <div className="grid gap-3 2xl:grid-cols-2">
                  {suggestions.map((h) =>
                    cardFor(hitToSong(h), h.dz, `sug-dz:${h.dz}`, () =>
                      playHit(h)
                    )
                  )}
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
              ) : tracks.length === 0 ? (
                <p className="text-sm text-foreground/60">
                  Nothing downloaded yet — pick a song below or search above,
                  then ⋯ → Download.
                </p>
              ) : (
                <div className="grid gap-3 2xl:grid-cols-2">
                  {tracks.map((t) =>
                    cardFor(t, null, `lib-${t.id}`, () => playSong(t), t.id === activeTrack?.id)
                  )}
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
                <div className="grid gap-3 2xl:grid-cols-2">
                  {likedSongs.map((t) =>
                    cardFor(
                      t,
                      dzOf(t),
                      `liked-${t.id}`,
                      () => playSong(t),
                      t.id === activeTrack?.id
                    )
                  )}
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
              if (dz !== null)
                downloadSong(dz, `np-${activeTrack.id}`);
            }
          }}
          queue={queue}
          activeQueueId={
            activeIndex < queue.length ? queue[activeIndex].id : null
          }
          onRemoveFromQueue={removeFromQueue}
          onPlayQueued={(id) => {
            const idx = queue.findIndex((t) => t.id === id);
            if (idx >= 0) setActiveIndex(idx);
          }}
        />
      </div>

      <PlayerBar
        track={activeTrack}
        onNext={() => step(1)}
        onPrev={() => step(-1)}
        onEnded={() => step(1)}
      />
    </div>
  );
}
