/**
 * Background playback bridge.
 *
 * Two engines, one store API (`src/player/store.ts` keeps owning the queue):
 *
 * - **Phones (Tauri + Android/iOS):** the native player from
 *   `tauri-plugin-native-audio` — Media3 ExoPlayer + MediaSessionService on
 *   Android, so audio survives backgrounding with a notification, lockscreen
 *   controls, and audio-focus handling. The store drives it through
 *   `nativeLoad/nativePlay/nativePause/nativeSeek`; native state events flow
 *   back into the zustand stores below.
 * - **Everywhere else (desktop Tauri, browser dev):** the WebView `<audio>`
 *   element, untouched. Desktop backgrounding comes from the Rust tray +
 *   hide-to-close (`src-tauri/src/player.rs`); OS transport metadata comes
 *   from the MediaSession publish below.
 *
 * `initBackgroundPlayer()` is idempotent — call it once from `App`.
 */

import type { Song } from "@/lib/api";
import { usePlayer, useTime } from "@/player/store";
import type { NativeAudioState } from "tauri-plugin-native-audio-api";

/** Payloads the Rust tray sends on `player-control` (see player.rs). */
type TrayAction = "toggle" | "prev" | "next";

/** JS entry the Android notification relay calls (see MainActivity). */
export interface SongnestTransport {
  next: () => void;
  prev: () => void;
  toggle: () => void;
}

declare global {
  interface Window {
    __songnestTransport?: SongnestTransport;
  }
}

let nativeActive = false;
let nativePlaying = false;
let nativePos = 0;
let nativeDur = 0;
let nativeReady = false;
/** Set when native init definitively failed: fall back to `<audio>`. */
let nativeFailed = false;
let initPromise: Promise<void> | null = null;
let booted = false;

/**
 * Synchronous transport routing for the store. True inside the phone app
 * unless native init already failed — including while init is still in
 * flight, so early taps can't start the `<audio>` element and double-play
 * once the native engine comes up. Transports `await ensureInit()` first.
 */
export function preferNativeTransport(): boolean {
  return isPhoneApp() && !nativeFailed;
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

export function nativeDuration(): number {
  return nativeDur;
}

/** Native path only inside the Tauri phone app — never desktop/browser. */
function isPhoneApp(): boolean {
  if (typeof window === "undefined") return false;
  if (!("__TAURI__" in window)) return false;
  return /android|iphone|ipad/i.test(navigator.userAgent);
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
  useTime.setState({ currentTime: nativePos, duration: nativeDur });
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

/** Resolve once the native engine is up (phone only). False = use `<audio>`. */
async function ensureInit(): Promise<boolean> {
  if (!isPhoneApp() || nativeFailed) return false;
  if (nativeActive) return true;
  initPromise ??= doInit();
  await initPromise;
  return nativeActive;
}

async function doInit(): Promise<void> {
  try {
    const na = await plugin();
    await na.addStateListener(applyNativeState);
    applyNativeState(await na.initialize());
    nativeActive = true;
    nativeReady = true;
  } catch (e: unknown) {
    console.error(e);
    nativeActive = false;
    nativeReady = false;
    nativeFailed = true;
  }
}

/** Hand the current track to ExoPlayer/AVPlayer and start it. */
export async function nativeLoad(song: Song): Promise<void> {
  if (!(await ensureInit())) {
    fail("Playback failed.");
    return;
  }
  try {
    const na = await plugin();
    const dz = song.id.startsWith("dz-") ? Number(song.id.slice(3)) : NaN;
    await na.setSource({
      src: song.streamUrl,
      id: Number.isInteger(dz) ? dz : undefined,
      title: song.title,
      artist: song.artist,
      artworkUrl: song.coverUrl === "" ? undefined : song.coverUrl,
    });
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
    applyNativeState(await (await plugin()).play());
  } catch (e: unknown) {
    console.error(e);
    fail("Playback failed.");
  }
}

export async function nativePause(): Promise<void> {
  if (!(await ensureInit())) return;
  try {
    applyNativeState(await (await plugin()).pause());
  } catch (e: unknown) {
    console.error(e);
  }
}

export async function nativeSeek(secs: number): Promise<void> {
  if (!(await ensureInit())) return;
  try {
    applyNativeState(await (await plugin()).seekTo(secs));
  } catch (e: unknown) {
    console.error(e);
  }
}

/** Full teardown for "queue emptied while playing". */
export async function nativeStop(): Promise<void> {
  try {
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
  // Notification-relay entry (Android): MainActivity evaluates
  // window.__songnestTransport.next()/prev() for the native card buttons.
  // Set synchronously at boot so it exists before any playback.
  try {
    window.__songnestTransport = {
      next: () => usePlayer.getState().next(true),
      prev: () => usePlayer.getState().prev(),
      toggle: () => usePlayer.getState().toggle(),
    };
  } catch {
    // non-DOM harness — native relay just stays unavailable
  }
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
