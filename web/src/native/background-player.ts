/**
 * Background playback bridge.
 *
 * Two engines, one store API (`src/player/store.ts` keeps owning the queue):
 *
 * - **Android:** the `player` plugin owns ExoPlayer and its MediaSession; the
 *   store sends commands and mirrors native state events.
 * - **iOS:** `tauri-plugin-native-audio` owns AVPlayer.
 * - **Everywhere else (desktop Tauri, browser dev):** the WebView `<audio>`
 *   element, untouched. Desktop backgrounding comes from the Rust tray +
 *   hide-to-close (`src-tauri/src/player.rs`); OS transport metadata comes
 *   from the MediaSession publish below.
 *
 * `initBackgroundPlayer()` is idempotent — call it once from `App`.
 */

import { getServerUrl, type Song } from "@/lib/api";
import {
  persistPlaybackPosition,
  usePlayer,
  useTime,
} from "@/player/store";
import type { NativeAudioState } from "tauri-plugin-native-audio-api";
import { addPluginListener, invoke } from "@tauri-apps/api/core";

interface AndroidPlayerState {
  position: number;
  duration: number;
  playing: boolean;
  currentIndex: number;
  currentId: string;
}

interface AndroidQueueTrack {
  id: string;
  url: string;
  title: string;
  artist: string;
  artwork: string | null;
}

/** Payloads the Rust tray sends on `player-control` (see player.rs). */
type TrayAction = "toggle" | "prev" | "next";

let nativeActive = false;
let nativePlaying = false;
let nativePos = 0;
let nativeDur = 0;
let nativeReady = false;
/**
 * Last native position update (performance.now()). The native player only
 * emits state events sparsely, so the lyrics view interpolates between
 * 150ms polls (see nativePositionSmooth + ensurePositionPoll).
 */
let lastNativeAt = 0;
let pollTimer: number | undefined;
/** Set when native init definitively failed: fall back to `<audio>`. */
let nativeFailed = false;
let initPromise: Promise<void> | null = null;
let booted = false;

/**
 * Android always stays on the native route, including after initialization
 * errors, so the WebView audio element can never start a second player.
 * iOS falls back to WebView audio only if its native player failed.
 */
export function preferNativeTransport(): boolean {
  return isPhoneApp() && (isAndroidApp() || !nativeFailed);
}

/** True once the native mobile engine owns transport. */
export function isNativePlayback(): boolean {
  return nativeActive;
}

/** Last known native playing flag (mirrored into the store too). */
export function isNativePlaying(): boolean {
  return nativePlaying;
}

export function nativePosition(): number {
  return nativePos;
}

/**
 * Interpolated native position (seconds): last emitted position plus wall
 * clock elapsed since that update while playing. The Android WebView only
 * gets position events every 100-200ms, so the lyrics rAF loop reads this
 * instead of the raw value to stay smooth between updates.
 */
export function nativePositionSmooth(): number {
  if (!nativePlaying || lastNativeAt === 0) return nativePos;
  const dt = (performance.now() - lastNativeAt) / 1000;
  if (!(dt > 0) || dt > 5) return nativePos;
  return nativeDur > 0 ? Math.min(nativePos + dt, nativeDur) : nativePos + dt;
}

export function nativeDuration(): number {
  return nativeDur;
}

/** Native path only inside the Tauri phone app — never desktop/browser. */
function isPhoneApp(): boolean {
  if (typeof window === "undefined") return false;
  if (!("__TAURI__" in window)) return false;
  return /android|iphone|ipad/i.test(navigator.userAgent);
}

function isAndroidApp(): boolean {
  return isPhoneApp() && /android/i.test(navigator.userAgent);
}

async function plugin() {
  return import("tauri-plugin-native-audio-api");
}

function fail(message: string): void {
  usePlayer.setState({ playing: false, buffering: false, error: message });
}

function applyNativeState(st: NativeAudioState): void {
  nativePos = st.currentTime;
  nativeDur = st.duration;
  lastNativeAt = performance.now();
  useTime.setState({ currentTime: nativePos, duration: nativeDur });
  persistPlaybackPosition();
  if (st.status === "playing") {
    nativePlaying = true;
    usePlayer.setState({ playing: true, buffering: false });
  } else if (st.status === "loading") {
    usePlayer.setState({ buffering: true });
  } else if (st.status === "ended") {
    nativePlaying = false;
    usePlayer.setState({ playing: false, buffering: false });
    const s = usePlayer.getState();
    if (s.repeat === "one") {
      void nativeSeek(0).then(() => nativePlay());
    } else {
      s.next(false);
    }
  } else if (st.status === "error") {
    nativePlaying = false;
    fail(st.error ?? "Playback failed.");
  } else {
    // "idle": paused (or fresh). Never show stale buffering.
    nativePlaying = false;
    usePlayer.setState({ playing: false, buffering: false });
  }
  publishMediaSession();
}

/** Resolve once the platform's native engine is up. */
async function ensureInit(): Promise<boolean> {
  if (!isPhoneApp() || nativeFailed) return false;
  if (nativeActive) return true;
  initPromise ??= doInit();
  await initPromise;
  return nativeActive;
}

/** 150ms position pump while the native engine plays: keeps useTime +
 *  lyrics interpolation fresh between sparse state events. Started once. */
function ensurePositionPoll(): void {
  if (pollTimer !== undefined) return;
  pollTimer = window.setInterval(() => {
    if (!nativePlaying || !nativeActive) return;
    if (isAndroidApp() && document.visibilityState !== "visible") return;
    (isAndroidApp()
      ? invoke<AndroidPlayerState>("plugin:player|get_state")
      : plugin().then((na) => na.getState()))
      .then((st) => {
        if (isAndroidApp()) {
          applyAndroidState(st as AndroidPlayerState);
        } else {
          const nativeState = st as NativeAudioState;
          nativePos = nativeState.currentTime;
          nativeDur = nativeState.duration;
          lastNativeAt = performance.now();
          useTime.setState({ currentTime: nativePos, duration: nativeDur });
          persistPlaybackPosition();
        }
      })
      .catch(() => {
        // transient JNI miss — next tick retries
      });
  }, isAndroidApp() ? 1000 : 150);
}

async function doInit(): Promise<void> {
  try {
    if (isAndroidApp()) {
      await addPluginListener<{ id: string }>("player", "track-changed", (event) => {
        usePlayer.getState().nativeTrackChanged(event.id);
      });
      await addPluginListener<{ playing: boolean }>(
        "player",
        "playing-changed",
        (event) => {
          nativePlaying = event.playing;
          usePlayer.setState({ playing: event.playing, buffering: false });
          if (!event.playing) {
            void invoke<AndroidPlayerState>("plugin:player|get_state")
              .then(applyAndroidState)
              .catch((error: unknown) => console.error(error));
          }
        }
      );
      await addPluginListener<{ message: string }>(
        "player",
        "playback-error",
        (event) => {
          nativePlaying = false;
          fail(event.message);
        }
      );
      nativeActive = true;
      nativeReady = true;
      applyAndroidState(await invoke<AndroidPlayerState>("plugin:player|get_state"));
      ensurePositionPoll();
      return;
    }
    const na = await plugin();
    await na.addStateListener(applyNativeState);
    applyNativeState(await na.initialize());
    nativeActive = true;
    nativeReady = true;
    ensurePositionPoll();
  } catch (e: unknown) {
    console.error(e);
    nativeActive = false;
    nativeReady = false;
    nativeFailed = true;
  }
}

function applyAndroidState(state: AndroidPlayerState): void {
  nativePos = Math.max(0, state.position / 1000);
  nativeDur = Math.max(0, state.duration / 1000);
  nativePlaying = state.playing;
  lastNativeAt = performance.now();
  useTime.setState({ currentTime: nativePos, duration: nativeDur });
  usePlayer.setState({
    playing: state.playing,
    buffering: false,
  });
  persistPlaybackPosition();
}

function androidQueue(song: Song): AndroidQueueTrack[] {
  const state = usePlayer.getState();
  const tracks = [...state.queue, ...state.library];
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const ids = [song.id, ...state.pendingQueueIds, ...state.upNextIds];
  const seen = new Set<string>();
  const queue: AndroidQueueTrack[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const track = id === song.id ? song : byId.get(id);
    if (track === undefined) continue;
    const match = /^dz-(\d+)$/.exec(track.id);
    const deezerId = track.deezerId ?? (match ? Number(match[1]) : null);
    const url =
      track.streamUrl ||
      (deezerId !== null
        ? `songnest://resolve/${deezerId}?server=${encodeURIComponent(getServerUrl())}`
        : "");
    if (url === "") {
      throw new Error(`Track ${track.id} has no stream URL or Deezer ID`);
    }
    queue.push({
      id: track.id,
      url,
      title: track.title,
      artist: track.artist,
      artwork: track.coverUrl || null,
    });
  }
  return queue;
}

let queueSyncPromise: Promise<void> = Promise.resolve();

/** Refresh the native timeline after the user edits the upcoming queue. */
export function nativeQueueChanged(): void {
  if (!isAndroidApp() || !nativeActive) return;
  queueSyncPromise = queueSyncPromise
    .then(async () => {
      const state = usePlayer.getState();
      if (!state.playbackStarted) return;
      const song = [...state.queue, ...state.library][state.index];
      if (song === undefined) return;
      await invoke("plugin:player|set_queue", {
        tracks: androidQueue(song),
        startIndex: 0,
        preservePosition: true,
      });
    })
    .catch((error: unknown) => {
      console.error(error);
      fail("Couldn't update playback queue.");
    });
}

/** Hand the current track to ExoPlayer/AVPlayer and start it. */
export async function nativeLoad(song: Song, startAtSeconds = 0): Promise<void> {
  if (!(await ensureInit())) {
    fail("Playback failed.");
    return;
  }
  try {
    if (isAndroidApp()) {
      await invoke("plugin:player|set_queue", {
        tracks: androidQueue(song),
        startIndex: 0,
      });
      if (startAtSeconds > 0) {
        await invoke("plugin:player|seek_to", {
          positionMs: Math.round(startAtSeconds * 1000),
        });
      }
      await invoke("plugin:player|play");
      applyAndroidState(await invoke<AndroidPlayerState>("plugin:player|get_state"));
      return;
    }
    const na = await plugin();
    const dz = song.id.startsWith("dz-") ? Number(song.id.slice(3)) : NaN;
    await na.setSource({
      src: song.streamUrl,
      id: Number.isInteger(dz) ? dz : undefined,
      title: song.title,
      artist: song.artist,
      artworkUrl: song.coverUrl === "" ? undefined : song.coverUrl,
    });
    if (startAtSeconds > 0) await na.seekTo(startAtSeconds);
    applyNativeState(await na.play());
  } catch (e: unknown) {
    console.error(e);
    fail("Playback failed.");
  }
}

export async function nativePlay(): Promise<void> {
  if (!(await ensureInit())) {
    fail("Playback failed.");
    return;
  }
  try {
    if (isAndroidApp()) {
      await invoke("plugin:player|play");
      applyAndroidState(await invoke<AndroidPlayerState>("plugin:player|get_state"));
      return;
    }
    applyNativeState(await (await plugin()).play());
  } catch (e: unknown) {
    console.error(e);
    fail("Playback failed.");
  }
}

export async function nativePause(): Promise<void> {
  if (!(await ensureInit())) return;
  try {
    if (isAndroidApp()) {
      await invoke("plugin:player|pause");
      applyAndroidState(await invoke<AndroidPlayerState>("plugin:player|get_state"));
      return;
    }
    applyNativeState(await (await plugin()).pause());
  } catch (e: unknown) {
    console.error(e);
  }
}

export async function nativeSeek(secs: number): Promise<void> {
  if (!(await ensureInit())) return;
  try {
    if (isAndroidApp()) {
      await invoke("plugin:player|seek_to", {
        positionMs: Math.round(Math.max(0, secs) * 1000),
      });
      applyAndroidState(await invoke<AndroidPlayerState>("plugin:player|get_state"));
      return;
    }
    applyNativeState(await (await plugin()).seekTo(secs));
  } catch (e: unknown) {
    console.error(e);
  }
}

/** Full teardown for "queue emptied while playing". */
export async function nativeStop(): Promise<void> {
  try {
    if (isAndroidApp()) {
      await invoke("plugin:player|set_queue", { tracks: [], startIndex: 0 });
      nativePlaying = false;
      nativePos = 0;
      return;
    }
    const na = await plugin();
    await na.pause();
    await na.dispose();
  } catch (e: unknown) {
    console.error(e);
  } finally {
    nativePlaying = false;
    nativePos = 0;
  }
}

/** Publish Now Playing to the OS (desktop media keys, BT metadata). */
export function publishMediaSession(): void {
  try {
    if (!("mediaSession" in navigator)) return;
    const s = usePlayer.getState();
    const track = [...s.queue, ...s.library][s.index];
    if (track === undefined || !("MediaMetadata" in window)) {
      navigator.mediaSession.metadata = null;
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artwork:
        track.coverUrl === "" ? [] : [{ src: track.coverUrl, sizes: "512x512" }],
    });
  } catch {
    // older WebViews — transport still works, metadata just stays empty
  }
}

function initMediaSessionActions(): void {
  try {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler("play", () => {
      const st = usePlayer.getState();
      if (!st.playing) st.toggle();
    });
    ms.setActionHandler("pause", () => {
      const st = usePlayer.getState();
      if (st.playing) st.toggle();
    });
    ms.setActionHandler("previoustrack", () => usePlayer.getState().prev());
    ms.setActionHandler("nexttrack", () => usePlayer.getState().next(true));
  } catch {
    // setActionHandler throws for unsupported actions — safe to ignore
  }
}

/** Tray menu (Rust) → store. No-op outside Tauri. */
async function listenTrayControls(): Promise<void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<TrayAction>("player-control", (e) => {
      const st = usePlayer.getState();
      if (e.payload === "toggle") st.toggle();
      else if (e.payload === "next") st.next(true);
      else if (e.payload === "prev") st.prev();
    });
  } catch {
    // browser dev, or events not permitted — tray is desktop-only anyway
  }
}

/** One-time boot: call from `App` mount. Safe to call twice. */
export async function initBackgroundPlayer(): Promise<void> {
  if (booted) return;
  booted = true;
  initMediaSessionActions();
  // Republish whenever the track or transport flips (usePlayer never ticks
  // with playback position — that lives in useTime — so this stays cheap).
  try {
    usePlayer.subscribe(() => publishMediaSession());
  } catch {
    // store not ready in some test harness — MediaSession just stays manual
  }
  void listenTrayControls();
  if (!isPhoneApp()) return;
  initPromise ??= doInit();
  await initPromise;
}

export function isNativeReady(): boolean {
  return nativeReady;
}
