import { create } from "zustand";

import { resolveTrack, type Song } from "@/lib/api";

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
  repeat: RepeatMode;
  shuffle: boolean;
  playing: boolean;
  volume: number;
  muted: boolean;
  error: string | null;
  /** true while a yt-dlp resolve is in flight (Now Playing shows it). */
  resolving: boolean;
  resolvingDz: number | null;
  /** true while the audio element is buffering a fresh stream. */
  buffering: boolean;
  setLibrary: (tracks: Song[]) => void;
  playTrack: (song: Song) => void;
  playDz: (dz: number, hint?: Song, fresh?: boolean) => Promise<void>;
  enqueue: (song: Song) => void;
  removeFromQueue: (id: string) => void;
  /** drag-reorder the queue; the playing index follows its track. */
  setQueueOrder: (next: Song[]) => void;
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

function combined(queue: Song[], library: Song[]): Song[] {
  return [...queue, ...library];
}

function playCurrentElement() {
  audio.play().catch((e: unknown) => {
    // Rapid track switches reject the earlier play(): normal, silent.
    if (e instanceof DOMException && e.name === "AbortError") return;
    console.error(e);
    usePlayer.setState({ error: "Playback failed." });
  });
}

function loadAt(index: number) {
  const { queue, library } = usePlayer.getState();
  const track = combined(queue, library)[index];
  if (track === undefined) {
    usePlayer.setState({ playing: false, buffering: false });
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
  usePlayer.setState({ index, error: null });
  if (audio.getAttribute("src") !== track.streamUrl) {
    audio.src = track.streamUrl;
    // fresh stream: show "Getting the song ready…" until it plays
    usePlayer.setState({ buffering: true });
  }
  playCurrentElement();
}

/** Reload the current src once (expired proxy URL), resume where we were. */
function recoverStream() {
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
audio.addEventListener("pause", () =>
  usePlayer.setState({ playing: false, buffering: false })
);
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
});
audio.addEventListener("loadedmetadata", () => {
  useTime.setState({ currentTime: 0, duration: audio.duration || 0 });
});

export const usePlayer = create<PlayerState>()((set, get) => ({
  queue: [],
  library: [],
  index: 0,
  repeat: "off",
  shuffle: false,
  playing: false,
  volume: audio.volume,
  muted: audio.muted,
  error: null,
  resolving: false,
  resolvingDz: null,
  buffering: false,

  setLibrary: (tracks) => {
    const { queue, index } = get();
    const total = queue.length + tracks.length;
    set({
      library: tracks,
      index: total === 0 ? 0 : Math.min(index, total - 1),
    });
  },

  playTrack: (song) => {
    generation++;
    const { queue, library } = get();
    const idx = combined(queue, library).findIndex((t) => t.id === song.id);
    if (idx >= 0) {
      loadAt(idx);
      return;
    }
    set({ queue: [...queue, song] });
    loadAt(queue.length); // appended at the end of the queue head
  },

  playDz: async (dz, hint, fresh = false) => {
    const g = ++generation;
    // Optimistic Now Playing: show the tapped song immediately (cover,
    // title, artist) while yt-dlp resolves in the background. The previous
    // audio keeps playing until the new stream is ready — no dead silence.
    if (hint !== undefined) {
      const st = get();
      // Drop an older unresolved placeholder so spam-taps can't stack them.
      let queue = st.queue;
      if (
        st.resolvingDz !== null &&
        st.resolvingDz !== dz &&
        queue.some(
          (t) => t.id === `dz-${st.resolvingDz}` && t.streamUrl === ""
        )
      ) {
        queue = queue.filter(
          (t) => !(t.id === `dz-${st.resolvingDz}` && t.streamUrl === "")
        );
      }
      const at = combined(queue, st.library).findIndex(
        (t) => t.id === hint.id
      );
      if (at >= 0) {
        set({ queue, index: at });
      } else {
        set({ queue: [...queue, hint], index: queue.length });
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
      usePlayer.setState({
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
    const at = combined(queue, library).findIndex((t) => t.id === song.id);
    if (at >= 0) {
      const next = [...queue];
      const qi = queue.findIndex((t) => t.id === song.id);
      if (qi >= 0) next[qi] = song;
      set({ queue: next, resolving: false, resolvingDz: null });
      loadAt(at);
    } else {
      set({ resolving: false, resolvingDz: null });
      get().playTrack(song);
    }
  },

  enqueue: (song) => {
    const { queue } = get();
    if (queue.some((t) => t.id === song.id)) return;
    set({ queue: [...queue, song] });
  },

  setQueueOrder: (next) => {
    const { queue, index } = get();
    const cur = queue[index];
    set({ queue: next });
    // same length: library positions are unaffected; only follow the
    // track when the now-playing one lives inside the queue
    if (cur !== undefined) {
      const at = next.findIndex((t) => t.id === cur.id);
      if (at >= 0) set({ index: at });
    }
  },

  removeFromQueue: (id) => {
    const { queue, library, index } = get();
    const qi = queue.findIndex((t) => t.id === id);
    if (qi < 0) return;
    const next = queue.filter((t) => t.id !== id);
    if (qi !== index) {
      set({ queue: next, index: qi < index ? Math.max(0, index - 1) : index });
      return;
    }
    // removing what's playing: continue with whatever is now there
    const total = next.length + library.length;
    if (total === 0 || index >= total) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      set({ queue: next, index: 0, playing: false, buffering: false });
      return;
    }
    set({ queue: next });
    loadAt(index);
  },

  toggle: () => {
    if (audio.paused) {
      usePlayer.setState({ error: null });
      playCurrentElement();
    } else {
      audio.pause();
    }
  },

  next: (manual) => {
    const { queue, library, index, repeat, shuffle } = get();
    const total = queue.length + library.length;
    if (total === 0) return;
    if (!manual && repeat === "off" && index >= total - 1) {
      audio.pause(); // stop at the end instead of wrapping
      return;
    }
    if (shuffle && total > 1) {
      // random next, never the same track twice in a row
      let j = index;
      while (j === index) j = Math.floor(Math.random() * total);
      loadAt(j);
      return;
    }
    loadAt((index + 1) % total);
  },

  prev: () => {
    const { queue, library, index } = get();
    const total = queue.length + library.length;
    if (total === 0) return;
    if (audio.currentTime > 3) {
      audio.currentTime = 0; // standard: restart first, then go back
      return;
    }
    loadAt((index - 1 + total) % total);
  },

  seekTo: (ratio) => {
    if (audio.duration) {
      audio.currentTime =
        Math.min(1, Math.max(0, ratio)) * audio.duration;
    }
  },

  seekBy: (seconds) => {
    if (audio.duration) {
      audio.currentTime = Math.min(
        Math.max(0, audio.currentTime + seconds),
        audio.duration
      );
    }
  },

  setVolume: (v) => {
    const clamped = Math.min(1, Math.max(0, v));
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
    const next = !get().muted;
    audio.muted = next;
    persistVolume();
    set({ muted: next });
  },

  cycleRepeat: () =>
    set((s) => ({
      repeat: s.repeat === "off" ? "all" : s.repeat === "all" ? "one" : "off",
    })),

  toggleShuffle: () => set((s) => ({ shuffle: !s.shuffle })),

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
