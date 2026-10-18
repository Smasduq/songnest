import { create } from "zustand";

import { resolveTrack, type Song } from "@/lib/api";
import {
  isNativePlaying,
  nativeDuration,
  nativeLoad,
  nativePause,
  nativePlay,
  nativePosition,
  nativeSeek,
  nativeStop,
  preferNativeTransport,
} from "@/native/background-player";

export type { Song };

export type RepeatMode = "off" | "all" | "one";

/**
 * The one audio element. Module-level on purpose: it is never part of
 * JSX, so no mount/unmount (sheet open/close, page switch) can cut
 * playback. The store below only mirrors its state and drives it.
 */
export const audio = new Audio();
audio.preload = "metadata";

const VOL_KEY = "songnest-volume";
// Bumped (one-time reset): the old key could hold a stuck "1" latched by a
// volume-slider mis-tap — volume-to-0 used to set the mute flag, so every
// song after that started silent ("auto muted"). Everyone starts clean.
const MUTE_KEY = "songnest-muted-v2";
const LAST_PLAYBACK_KEY = "songnest-last-playback";

try {
  // Missing key (fresh install) must keep the element default of 1:
  // Number(null) is 0, which would otherwise start every new install silent.
  const raw = localStorage.getItem(VOL_KEY);
  const v = raw === null ? NaN : Number(raw);
  if (Number.isFinite(v)) audio.volume = Math.min(1, Math.max(0, v));
  audio.muted = localStorage.getItem(MUTE_KEY) === "1";
} catch {
  // private mode / no storage — element defaults stand
}

function persistVolume() {
  try {
    localStorage.setItem(VOL_KEY, String(audio.volume));
    localStorage.setItem(MUTE_KEY, audio.muted ? "1" : "0");
  } catch {
    // ignore
  }
}

interface PlayerState {
  /** user-queued songs, played first */
  queue: Song[];
  /** downloaded library, played after the queue */
  library: Song[];
  /** position inside [...queue, ...library] */
  index: number;
  /** Explicitly queued songs that have not started playing yet. */
  pendingQueueIds: string[];
  /** Planned library tracks that follow the explicit queue. */
  upNextIds: string[];
  repeat: RepeatMode;
  shuffle: boolean;
  playbackStarted: boolean;
  playing: boolean;
  volume: number;
  muted: boolean;
  error: string | null;
  /** true while a yt-dlp resolve is in flight (Now Playing shows it). */
  resolving: boolean;
  resolvingDz: number | null;
  /** true while the audio element is buffering a fresh stream. */
  buffering: boolean;
  /**
   * ids of play-now placeholders: tapped songs that were never explicitly
   * queued. Hidden from Up next and dropped once superseded, so the queue
   * only ever shows songs the user deliberately added.
   */
  transientIds: string[];
  setLibrary: (tracks: Song[]) => void;
  restoreLastPlayback: () => void;
  playTrack: (song: Song) => void;
  playDz: (
    dz: number,
    hint?: Song,
    fresh?: boolean,
    startAtSeconds?: number
  ) => Promise<void>;
  enqueue: (song: Song) => void;
  removeFromQueue: (id: string) => void;
  /** drag-reorder the queue; the playing index follows its track. */
  setQueueOrder: (next: Song[]) => void;
  /** swap a queued placeholder for its resolved stream, in place. */
  swapQueued: (id: string, song: Song) => void;
  toggle: () => void;
  next: (manual: boolean) => void;
  prev: () => void;
  seekTo: (ratio: number) => void;
  seekBy: (seconds: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  cycleRepeat: () => void;
  toggleShuffle: () => void;
  clearError: () => void;
}

/**
 * Clock only. Written ~4Hz by timeupdate; ONLY seek-bar/progress
 * readers subscribe here so the queue and track state never churn.
 */
interface TimeState {
  currentTime: number;
  duration: number;
}

export const useTime = create<TimeState>()(() => ({
  currentTime: 0,
  duration: 0,
}));

/** Stale-async guard: slow resolveTrack calls must not beat newer ones. */
let generation = 0;
/** Error-recovery budget, reset on every fresh load. */
let retriesLeft = 1;
let stallTimer: number | undefined;
let lastPlaybackPersistedAt = 0;
let restoreAttempted = false;

function combined(queue: Song[], library: Song[]): Song[] {
  return [...queue, ...library];
}

function planLibraryTracks(
  song: Song,
  library: Song[],
  shuffle: boolean,
  repeat: RepeatMode,
  queuedIds: string[] = []
): string[] {
  const current = library.findIndex((track) => track.id === song.id);
  if (current < 0 || repeat === "one" || library.length === 0) return [];
  const queued = new Set(queuedIds);
  let future: Song[];
  if (shuffle) {
    future = library.filter(
      (track) => track.id !== song.id && !queued.has(track.id)
    );
    for (let i = future.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [future[i], future[j]] = [future[j], future[i]];
    }
  } else {
    const length =
      repeat === "all" ? library.length - 1 : library.length - current - 1;
    future = Array.from(
      { length },
      (_, i) => library[(current + i + 1) % library.length]
    );
  }
  if (repeat === "all" && !queued.has(song.id)) future.push(song);
  return future.filter((track) => !queued.has(track.id)).map((track) => track.id);
}

/**
 * Transport position/duration behind the active engine: the native phone
 * player (Media3/AVPlayer) or the WebView `<audio>` element. Never touch
 * `audio.*` on the native path — the element stays idle so nothing can
 * double-play.
 */
function curPos(): number {
  return preferNativeTransport() ? nativePosition() : audio.currentTime;
}

function curDur(): number {
  return preferNativeTransport() ? nativeDuration() : audio.duration || 0;
}

interface SavedPlayback {
  trackId: string;
  position: number;
  song: Omit<Song, "streamUrl">;
}

function isSavedSong(value: unknown): value is SavedPlayback["song"] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("title" in value) ||
    typeof value.title !== "string" ||
    !("artist" in value) ||
    typeof value.artist !== "string" ||
    !("album" in value) ||
    typeof value.album !== "string" ||
    !("duration" in value) ||
    typeof value.duration !== "number" ||
    !Number.isFinite(value.duration) ||
    !("coverUrl" in value) ||
    typeof value.coverUrl !== "string"
  ) {
    return false;
  }
  return (
    !("deezerId" in value) ||
    value.deezerId === null ||
    (typeof value.deezerId === "number" && Number.isFinite(value.deezerId))
  );
}

function readLastPlayback(): SavedPlayback | null {
  try {
    const raw = localStorage.getItem(LAST_PLAYBACK_KEY);
    if (raw === null) return null;
    const saved: unknown = JSON.parse(raw);
    if (
      typeof saved !== "object" ||
      saved === null ||
      !("trackId" in saved) ||
      typeof saved.trackId !== "string" ||
      !("position" in saved) ||
      typeof saved.position !== "number" ||
      !Number.isFinite(saved.position) ||
      saved.position < 0 ||
      !("song" in saved) ||
      !isSavedSong(saved.song) ||
      saved.song.id !== saved.trackId
    ) {
      return null;
    }
    return {
      trackId: saved.trackId,
      position: saved.position,
      song: saved.song,
    };
  } catch {
    return null;
  }
}

export function persistPlaybackPosition(force = false): void {
  const now = Date.now();
  if (!force && now - lastPlaybackPersistedAt < 3000) return;
  const state = usePlayer.getState();
  const track = combined(state.queue, state.library)[state.index];
  if (track === undefined) return;
  const position =
    preferNativeTransport() || audio.getAttribute("src") === track.streamUrl
      ? curPos()
      : 0;
  savePlayback(track, position);
}

function savePlayback(track: Song, position: number): void {
  try {
    localStorage.setItem(
      LAST_PLAYBACK_KEY,
      JSON.stringify({
        trackId: track.id,
        position: Math.max(0, position),
        song: {
          id: track.id,
          title: track.title,
          artist: track.artist,
          album: track.album,
          duration: track.duration,
          coverUrl: track.coverUrl,
          ...(track.deezerId !== undefined
            ? { deezerId: track.deezerId }
            : {}),
        },
      } satisfies SavedPlayback)
    );
    lastPlaybackPersistedAt = Date.now();
  } catch {
    // Storage full or blocked; playback remains available for this session.
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => persistPlaybackPosition(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistPlaybackPosition(true);
  });
}

/** Drop play-now placeholders that are no longer current. The playing
 *  index follows its track; library offsets shift with the queue. */
function pruneTransient() {
  const s = usePlayer.getState();
  if (s.transientIds.length === 0) return;
  const cur = combined(s.queue, s.library)[s.index];
  const nextQ = s.queue.filter(
    (t) => !s.transientIds.includes(t.id) || t.id === cur?.id
  );
  if (nextQ.length === s.queue.length) return;
  const keep = new Set(nextQ.map((t) => t.id));
  let index: number;
  if (cur !== undefined) {
    const qi = nextQ.findIndex((t) => t.id === cur.id);
    index = qi >= 0 ? qi : nextQ.length + (s.index - s.queue.length);
  } else {
    index = 0;
  }
  const total = nextQ.length + s.library.length;
  usePlayer.setState({
    queue: nextQ,
    transientIds: s.transientIds.filter((id) => keep.has(id)),
    index: total === 0 ? 0 : Math.min(Math.max(0, index), total - 1),
  });
}

function playCurrentElement() {
  if (preferNativeTransport()) {
    void nativePlay();
    return;
  }
  audio.play().catch((e: unknown) => {
    // Rapid track switches reject the earlier play(): normal, silent.
    if (e instanceof DOMException && e.name === "AbortError") return;
    console.error(e);
    usePlayer.setState({ error: "Playback failed." });
  });
}

function loadAt(index: number, startAtSeconds = 0) {
  const { queue, library } = usePlayer.getState();
  const track = combined(queue, library)[index];
  if (track === undefined) {
    usePlayer.setState({
      playing: false,
      buffering: false,
      playbackStarted: false,
    });
    pruneTransient();
    return;
  }
  if (track.streamUrl === "") {
    const { resolving, resolvingDz } = usePlayer.getState();
    if (resolving && track.id === `dz-${resolvingDz}`) {
      usePlayer.setState({ error: "Finding the song… (resolving audio)" });
    } else {
      usePlayer.setState({ error: "That track has no playable audio." });
    }
    return;
  }
  retriesLeft = 1;
  usePlayer.setState({ index, error: null, playbackStarted: true });
  savePlayback(track, startAtSeconds);
  if (preferNativeTransport()) {
    // Native owns the element-free path: hand over URL + metadata, play.
    // Progress/ended/error come back through the native state listener.
    usePlayer.setState({ buffering: true });
    void nativeLoad(track, startAtSeconds);
    pruneTransient();
    return;
  }
  if (audio.getAttribute("src") !== track.streamUrl) {
    audio.src = track.streamUrl;
    // streams buffer over the network; downloaded tracks play off disk,
    // so they never raise the "getting ready" state (a stale one clears)
    usePlayer.setState({ buffering: !track.id.startsWith("db-") });
  }
  if (startAtSeconds > 0) {
    const seekAndPlay = () => {
      audio.removeEventListener("loadedmetadata", seekAndPlay);
      if (audio.getAttribute("src") !== track.streamUrl) return;
      audio.currentTime = Math.max(
        0,
        Math.min(
          startAtSeconds,
          audio.duration > 0 ? audio.duration - 1 : startAtSeconds
        )
      );
      useTime.setState({ currentTime: audio.currentTime });
      playCurrentElement();
    };
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) seekAndPlay();
    else audio.addEventListener("loadedmetadata", seekAndPlay);
    pruneTransient();
    return;
  }
  playCurrentElement();
  pruneTransient();
}

/** Reload the current src once (expired proxy URL), resume where we were. */
function recoverStream() {
  if (preferNativeTransport()) {
    // Native errors surface through the state listener; a retry here just
    // re-hands the current track to the engine with the same budget.
    if (retriesLeft <= 0) {
      usePlayer.setState({
        error: "Stream failed. Check connection or try another track.",
      });
      return;
    }
    retriesLeft--;
    const { queue, library, index } = usePlayer.getState();
    const track = combined(queue, library)[index];
    if (track?.streamUrl !== undefined && track.streamUrl !== "") {
      usePlayer.setState({ buffering: true });
      void nativeLoad(track);
    }
    return;
  }
  if (!audio.getAttribute("src")) return; // element was emptied on purpose
  if (retriesLeft <= 0) {
    usePlayer.setState({
      error: "Stream failed. Check connection or try another track.",
    });
    return;
  }
  retriesLeft--;
  const t = audio.currentTime;
  const onMeta = () => {
    audio.removeEventListener("loadedmetadata", onMeta);
    audio.currentTime = t;
    playCurrentElement();
  };
  audio.addEventListener("loadedmetadata", onMeta);
  audio.load();
  usePlayer.setState({ buffering: true });
}

audio.addEventListener("play", () => usePlayer.setState({ playing: true }));
audio.addEventListener("pause", () => {
  usePlayer.setState({ playing: false, buffering: false });
  persistPlaybackPosition(true);
});
audio.addEventListener("waiting", () =>
  usePlayer.setState({ buffering: true })
);
audio.addEventListener("ended", () => {
  const s = usePlayer.getState();
  if (s.repeat === "one") {
    audio.currentTime = 0;
    playCurrentElement();
  } else {
    s.next(false);
  }
});
audio.addEventListener("error", () => recoverStream());
audio.addEventListener("stalled", () => {
  window.clearTimeout(stallTimer);
  // transient stalls are normal while buffering; only recover if stuck
  stallTimer = window.setTimeout(() => recoverStream(), 15000);
});
audio.addEventListener("playing", () => {
  window.clearTimeout(stallTimer);
  usePlayer.setState({ buffering: false });
});
audio.addEventListener("timeupdate", () => {
  window.clearTimeout(stallTimer);
  useTime.setState({ currentTime: audio.currentTime });
  persistPlaybackPosition();
});
audio.addEventListener("loadedmetadata", () => {
  useTime.setState({ currentTime: 0, duration: audio.duration || 0 });
});

export const usePlayer = create<PlayerState>()((set, get) => ({
  queue: [],
  library: [],
  index: 0,
  pendingQueueIds: [],
  upNextIds: [],
  repeat: "off",
  shuffle: false,
  playbackStarted: false,
  playing: false,
  volume: audio.volume,
  muted: audio.muted,
  error: null,
  resolving: false,
  resolvingDz: null,
  buffering: false,
  transientIds: [],

  setLibrary: (tracks) => {
    const {
      queue,
      library,
      index,
      pendingQueueIds,
      upNextIds,
      transientIds,
      shuffle,
      repeat,
    } = get();
    // pin Now Playing to its track: library refreshes (download finished,
    // track deleted) shift positions, so follow the id instead of the slot
    const cur = [...queue, ...library][index];
    const total = queue.length + tracks.length;
    let nextIndex = total === 0 ? 0 : Math.min(index, total - 1);
    if (cur !== undefined) {
      const at = [...queue, ...tracks].findIndex((t) => t.id === cur.id);
      if (at >= 0) nextIndex = at;
    }
    const currentIsInLibrary =
      cur !== undefined &&
      index >= queue.length &&
      library.some((track) => track.id === cur.id);
    const queuedIds = pendingQueueIds.filter(
      (id) => !transientIds.includes(id)
    );
    const nextIds =
      currentIsInLibrary && cur !== undefined
        ? planLibraryTracks(
            cur,
            tracks,
            shuffle,
            repeat,
            queuedIds
          )
        : upNextIds.filter(
            (id) =>
              tracks.some((track) => track.id === id) &&
              !queuedIds.includes(id)
          );
    set({
      library: tracks,
      index: nextIndex,
      upNextIds: nextIds,
    });
  },

  restoreLastPlayback: () => {
    const state = get();
    if (state.playbackStarted || restoreAttempted) return;
    const saved = readLastPlayback();
    if (saved === null) return;
    const index = state.library.findIndex(
      (track) =>
        track.id === saved.trackId ||
        (saved.song.deezerId != null &&
          track.deezerId === saved.song.deezerId)
    );
    if (index >= 0) {
      const track = state.library[index];
      if (track.streamUrl !== "") {
        restoreAttempted = true;
        set({
          pendingQueueIds: [],
          upNextIds: planLibraryTracks(
            track,
            state.library,
            state.shuffle,
            state.repeat
          ),
        });
        loadAt(
          state.queue.length + index,
          Math.min(saved.position, Math.max(track.duration - 1, 0))
        );
        return;
      }
    }
    const match = /^dz-(\d+)$/.exec(saved.song.id);
    const deezerId = saved.song.deezerId ?? (match ? Number(match[1]) : null);
    if (deezerId === null) return;
    restoreAttempted = true;
    void get().playDz(
      deezerId,
      { ...saved.song, deezerId, streamUrl: "" },
      false,
      saved.position
    );
  },

  playTrack: (song) => {
    generation++;
    const {
      queue,
      library,
      transientIds,
      pendingQueueIds,
      shuffle,
      repeat,
    } = get();
    const queueIndex = queue.findIndex((t) => t.id === song.id);
    const libraryIndex = library.findIndex((t) => t.id === song.id);
    const idx =
      pendingQueueIds.includes(song.id) && queueIndex >= 0
        ? queueIndex
        : libraryIndex >= 0
          ? queue.length + libraryIndex
          : queueIndex;
    if (idx >= 0) {
      const nextPending = pendingQueueIds.filter((id) => id !== song.id);
      const libraryTrack =
        idx >= queue.length ? library[idx - queue.length] : undefined;
      set({
        pendingQueueIds: nextPending,
        ...(libraryTrack !== undefined
          ? {
              upNextIds: planLibraryTracks(
                libraryTrack,
                library,
                shuffle,
                repeat,
                nextPending
              ),
            }
          : {}),
      });
      loadAt(idx);
      return;
    }
    // play-now without polluting Up next: transient head placeholder
    set({
      queue: [song, ...queue],
      transientIds: [...transientIds, song.id],
      upNextIds: [],
    });
    loadAt(0);
  },

  playDz: async (dz, hint, fresh = false, startAtSeconds = 0) => {
    const g = ++generation;
    // Optimistic Now Playing: show the tapped song immediately (cover,
    // title, artist) while yt-dlp resolves in the background. The previous
    // audio keeps playing until the new stream is ready — no dead silence.
    if (hint !== undefined) {
      const st = get();
      // Drop older unresolved placeholders so spam-taps can't stack them.
      const queue = st.queue.filter(
        (t) => t.streamUrl !== "" || !st.transientIds.includes(t.id)
      );
      const liveIds = new Set(queue.map((t) => t.id));
      const queueIndex = queue.findIndex((t) => t.id === hint.id);
      const libraryIndex = st.library.findIndex((t) => t.id === hint.id);
      const targetIndex =
        st.pendingQueueIds.includes(hint.id) && queueIndex >= 0
          ? queueIndex
          : libraryIndex >= 0
            ? queue.length + libraryIndex
            : queueIndex >= 0
              ? queueIndex
              : -1;
      const libraryTrack =
        targetIndex >= queue.length && libraryIndex >= 0
          ? st.library[libraryIndex]
          : undefined;
      const nextPending = st.pendingQueueIds.filter((id) => id !== hint.id);
      if (targetIndex >= 0) {
        set({
          queue,
          index: targetIndex,
          transientIds: st.transientIds.filter((id) => liveIds.has(id)),
          pendingQueueIds: nextPending,
          ...(libraryTrack !== undefined
            ? {
                upNextIds: planLibraryTracks(
                  libraryTrack,
                  st.library,
                  st.shuffle,
                  st.repeat,
                  nextPending
                ),
              }
            : {}),
        });
      } else {
        // play-now placeholder: transient head, hidden from Up next
        set({
          queue: [hint, ...queue],
          index: 0,
          transientIds: [
            ...st.transientIds.filter((id) => liveIds.has(id)),
            hint.id,
          ],
          pendingQueueIds: nextPending,
          upNextIds: [],
        });
      }
      set({ resolving: true, resolvingDz: dz, error: null });
    } else {
      set({ resolving: true, resolvingDz: dz, error: null });
    }
    let song: Song;
    try {
      song = await resolveTrack(dz, fresh);
    } catch (e: unknown) {
      if (g !== generation) return; // a newer request already won
      // drop our failed placeholder; keep the current track if it survives
      const s = usePlayer.getState();
      const pid = `dz-${dz}`;
      const cur = combined(s.queue, s.library)[s.index];
      const nextQ = s.queue.filter(
        (t) => !(t.id === pid && s.transientIds.includes(t.id))
      );
      let index = s.index;
      if (cur !== undefined) {
        const qi = nextQ.findIndex((t) => t.id === cur.id);
        index = qi >= 0 ? qi : nextQ.length + (s.index - s.queue.length);
      } else {
        index = 0;
      }
      const total = nextQ.length + s.library.length;
      usePlayer.setState({
        queue: nextQ,
        transientIds: s.transientIds.filter((id) => id !== pid),
        index: total === 0 ? 0 : Math.min(Math.max(0, index), total - 1),
        resolving: false,
        resolvingDz: null,
        buffering: false,
        error: e instanceof Error ? e.message : "Couldn't play that track.",
      });
      return;
    }
    if (g !== generation) return; // a newer request already won
    // Swap the placeholder for the resolved stream in place, then play it.
    const { queue, library } = get();
    const resolvedQueueIndex = queue.findIndex((t) => t.id === song.id);
    const resolvedLibraryIndex = library.findIndex((t) => t.id === song.id);
    const resolvedState = get();
    const at =
      resolvedState.pendingQueueIds.includes(song.id) &&
      resolvedQueueIndex >= 0
        ? resolvedQueueIndex
        : resolvedLibraryIndex >= 0
          ? queue.length + resolvedLibraryIndex
          : resolvedQueueIndex;
    if (at >= 0) {
      const next = [...queue];
      const qi = queue.findIndex((t) => t.id === song.id);
      if (qi >= 0) next[qi] = song;
      set({ queue: next, resolving: false, resolvingDz: null });
      loadAt(at, startAtSeconds);
    } else {
      set({ resolving: false, resolvingDz: null });
      get().playTrack(song);
    }
  },

  enqueue: (song) => {
    const {
      queue,
      library,
      index,
      transientIds,
      pendingQueueIds,
    } = get();
    // explicit add: it belongs in Up next even if it was a placeholder
    if (queue.some((t) => t.id === song.id)) {
      if (transientIds.includes(song.id)) {
        set({
          transientIds: transientIds.filter((id) => id !== song.id),
          pendingQueueIds: [...pendingQueueIds, song.id],
          upNextIds: get().upNextIds.filter((id) => id !== song.id),
        });
      } else if (!pendingQueueIds.includes(song.id)) {
        set({
          pendingQueueIds: [...pendingQueueIds, song.id],
          upNextIds: get().upNextIds.filter((id) => id !== song.id),
        });
      }
      return;
    }
    // Appending to the queue shifts every library offset right by one, so
    // pin Now Playing to its track when it currently sits in the library.
    // (+1 keeps the same library row even when the enqueued id duplicates it.)
    const cur = combined(queue, library)[index];
    const nextQueue = [...queue, song];
    let nextIndex = index;
    if (cur !== undefined && index >= queue.length) {
      nextIndex = index + 1;
    }
    set({
      queue: nextQueue,
      index: nextIndex,
      pendingQueueIds: [...pendingQueueIds, song.id],
      upNextIds: get().upNextIds.filter((id) => id !== song.id),
    });
  },

  setQueueOrder: (next) => {
    const { queue, library, index, pendingQueueIds } = get();
    const cur = combined(queue, library)[index];
    const pending = new Set(pendingQueueIds);
    const historical = queue.filter((track) => !pending.has(track.id));
    const orderedPending = next.filter((track) => pending.has(track.id));
    const nextQueue = [...historical, ...orderedPending];
    const currentIndex =
      cur === undefined
        ? -1
        : nextQueue.findIndex((track) => track.id === cur.id);
    const libraryIndex =
      cur === undefined
        ? -1
        : library.findIndex((track) => track.id === cur.id);
    set({
      queue: nextQueue,
      pendingQueueIds: orderedPending.map((track) => track.id),
      ...(currentIndex >= 0
        ? { index: currentIndex }
        : libraryIndex >= 0
          ? { index: nextQueue.length + libraryIndex }
          : {}),
    });
  },

  swapQueued: (id, song) => {
    const { queue } = get();
    const qi = queue.findIndex((t) => t.id === id);
    if (qi < 0) return; // user removed it meanwhile
    const next = [...queue];
    next[qi] = song;
    set({ queue: next });
  },

  removeFromQueue: (id) => {
    const { queue, library, index, transientIds, pendingQueueIds } = get();
    const qi = queue.findIndex((t) => t.id === id);
    if (qi < 0) return;
    const next = queue.filter((t) => t.id !== id);
    const live = transientIds.filter((t) => t !== id);
    if (qi !== index) {
      set({
        queue: next,
        transientIds: live,
        pendingQueueIds: pendingQueueIds.filter((t) => t !== id),
        index: qi < index ? Math.max(0, index - 1) : index,
      });
      return;
    }
    // removing what's playing: continue with whatever is now there
    const total = next.length + library.length;
    if (total === 0 || index >= total) {
      if (preferNativeTransport()) {
        void nativeStop();
      } else {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
      set({
        queue: next,
        transientIds: live,
        pendingQueueIds: pendingQueueIds.filter((t) => t !== id),
        index: 0,
        playing: false,
        buffering: false,
        playbackStarted: false,
      });
      return;
    }
    set({
      queue: next,
      transientIds: live,
      pendingQueueIds: pendingQueueIds.filter((t) => t !== id),
    });
    loadAt(index);
  },

  toggle: () => {
    if (preferNativeTransport()) {
      usePlayer.setState({ error: null });
      if (isNativePlaying()) void nativePause();
      else void nativePlay();
      return;
    }
    if (audio.paused) {
      usePlayer.setState({ error: null });
      playCurrentElement();
    } else {
      audio.pause();
    }
  },

  next: (manual) => {
    const {
      queue,
      library,
      index,
      repeat,
      shuffle,
      pendingQueueIds,
      upNextIds,
    } = get();
    const total = queue.length + library.length;
    if (total === 0) return;
    const cur = combined(queue, library)[index];
    const pendingId = pendingQueueIds[0];
    if (pendingId !== undefined) {
      const queueIndex = queue.findIndex((track) => track.id === pendingId);
      if (queueIndex >= 0) {
        usePlayer.setState({ pendingQueueIds: pendingQueueIds.slice(1) });
        loadAt(queueIndex);
        return;
      }
      usePlayer.setState({ pendingQueueIds: pendingQueueIds.slice(1) });
    }
    const libraryNextIds =
      upNextIds.length === 0 && manual && repeat === "one" && cur !== undefined
        ? planLibraryTracks(cur, library, shuffle, "off")
        : upNextIds;
    const nextId = libraryNextIds[0];
    if (nextId !== undefined) {
      const libraryIndex = library.findIndex((track) => track.id === nextId);
      if (libraryIndex >= 0) {
        let following = libraryNextIds.slice(1);
        if (following.length === 0 && repeat === "all") {
          following = planLibraryTracks(
            library[libraryIndex],
            library,
            shuffle,
            repeat,
            pendingQueueIds.slice(1)
          );
        }
        usePlayer.setState({ upNextIds: following });
        loadAt(queue.length + libraryIndex);
        return;
      }
    }
    if (!manual && repeat === "off") {
      if (preferNativeTransport()) void nativePause();
      else audio.pause();
      return;
    }
    if (shuffle && total > 1) {
      // random next, never the same track twice in a row
      let j = index;
      while (j === index) j = Math.floor(Math.random() * total);
      loadAt(j);
      return;
    }
    // strictly sequential: the next song in order, never a jump.
    // queued songs still come first whenever they sit ahead of
    // the current position (tapped songs land at the head).
    loadAt((index + 1) % total);
  },

  prev: () => {
    const { queue, library, index, pendingQueueIds, shuffle, repeat } = get();
    const total = queue.length + library.length;
    if (total === 0) return;
    if (curPos() > 3) {
      // standard: restart first, then go back
      if (preferNativeTransport()) void nativeSeek(0);
      else audio.currentTime = 0;
      return;
    }
    const previousIndex = (index - 1 + total) % total;
    const previous = combined(queue, library)[previousIndex];
    if (previous !== undefined && previousIndex >= queue.length) {
      usePlayer.setState({
        upNextIds: planLibraryTracks(
          previous,
          library,
          shuffle,
          repeat,
          pendingQueueIds
        ),
      });
    }
    loadAt(previousIndex);
  },

  seekTo: (ratio) => {
    const at = Math.min(1, Math.max(0, ratio)) * curDur();
    if (preferNativeTransport()) {
      if (curDur() > 0) void nativeSeek(at);
      return;
    }
    if (audio.duration) {
      audio.currentTime =
        Math.min(1, Math.max(0, ratio)) * audio.duration;
    }
  },

  seekBy: (seconds) => {
    if (preferNativeTransport()) {
      const d = curDur();
      if (d > 0) {
        void nativeSeek(Math.min(Math.max(0, curPos() + seconds), d));
      }
      return;
    }
    if (audio.duration) {
      audio.currentTime = Math.min(
        Math.max(0, audio.currentTime + seconds),
        audio.duration
      );
    }
  },

  setVolume: (v) => {
    const clamped = Math.min(1, Math.max(0, v));
    if (preferNativeTransport()) {
      // Phones use hardware buttons; the plugin exposes no gain API.
      // Remember the choice for desktop/browser sessions anyway.
      try {
        localStorage.setItem(VOL_KEY, String(clamped));
      } catch {
        // ignore
      }
      set({ volume: clamped });
      return;
    }
    audio.volume = clamped;
    // Volume-up is an explicit want-to-hear: drop any mute. Volume-down to
    // 0 just goes silent through the gain — it never sets the mute flag,
    // so a slider mis-tap can't latch songs into silence.
    const muted = clamped === 0 ? get().muted : false;
    audio.muted = muted;
    persistVolume();
    set({ volume: clamped, muted });
  },

  toggleMute: () => {
    if (preferNativeTransport()) {
      const next = !get().muted;
      try {
        localStorage.setItem(MUTE_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      set({ muted: next });
      return;
    }
    const next = !get().muted;
    audio.muted = next;
    persistVolume();
    set({ muted: next });
  },

  cycleRepeat: () => {
    const s = get();
    const repeat =
      s.repeat === "off" ? "all" : s.repeat === "all" ? "one" : "off";
    const current = combined(s.queue, s.library)[s.index];
    const upNextIds =
      current !== undefined && s.index >= s.queue.length
        ? planLibraryTracks(
            current,
            s.library,
            s.shuffle,
            repeat,
            s.pendingQueueIds
          )
        : s.upNextIds;
    set({
      repeat,
      upNextIds,
    });
  },

  toggleShuffle: () => {
    const s = get();
    const shuffle = !s.shuffle;
    const current = combined(s.queue, s.library)[s.index];
    const upNextIds =
      current !== undefined && s.index >= s.queue.length
        ? planLibraryTracks(
            current,
            s.library,
            shuffle,
            s.repeat,
            s.pendingQueueIds
          )
        : s.upNextIds;
    set({ shuffle, upNextIds });
  },

  clearError: () => set({ error: null }),
}));

/** Current track; safe to call in any component (stable subscriptions). */
export function useCurrentTrack(): Song | undefined {
  const queue = usePlayer((s) => s.queue);
  const library = usePlayer((s) => s.library);
  const index = usePlayer((s) => s.index);
  const all = [...queue, ...library];
  return index < all.length ? all[index] : undefined;
}

// Dev-only escape hatch for headless/browser-console tests.
if (import.meta.env.DEV) {
  (window as unknown as { __player: typeof usePlayer }).__player =
    usePlayer;
}
