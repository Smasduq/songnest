/**
 * Background worker for liked-songs sync.
 *
 * The likes engine is local-first (outbox in localStorage, see
 * `accounts.ts`), so edits made offline must upload on their own once
 * connectivity returns — without the user tapping "Sync now". This
 * module owns that: it runs outside the React render cycle (started once
 * from `App`, lives until unmount) and triggers the caller-supplied
 * sync task when:
 *
 * - the browser fires `online` (after a short settle delay, since the
 *   event can precede usable connectivity — the attempt itself proves
 *   the server is reachable, failures back off and retry),
 * - the tab becomes visible / focused or returns from bfcache (covers
 *   laptop sleep/wake, which often fires no `online` event),
 * - another tab touches the outbox/session via `storage` events,
 * - a heartbeat sees a non-empty outbox while online,
 * - a heartbeat sees the periodic pull overdue (multi-device
 *   convergence even with nothing queued locally),
 * - the app explicitly asks via `requestSync` (new like, login, "Sync
 *   now" button).
 *
 * Attempts are debounced, single-flight, and retried with exponential
 * backoff (2s → 5min cap). Credential/logout failures stop retrying.
 * Heartbeats skip while `navigator.onLine` is false — the `online`
 * event picks the work back up.
 *
 * Why not a Service Worker / Web Worker? Both die with the page in the
 * Tauri webview (the primary target), and neither can reach the
 * localStorage outbox or the OS credential store — so a real worker
 * process would add plumbing without adding capability. This engine
 * gives every automatic-sync behavior that is actually achievable:
 * sync whenever the running app has a connection.
 */

import { useEffect, useState } from "react";
import { AccountsError } from "./accounts";

export interface LikesSyncTask {
  /** False when logged out — nothing is attempted. */
  isSignedIn: () => boolean;
  /** True when the outbox holds unsynced changes. */
  hasPending: () => boolean;
  /** One full push + pull. May throw `AccountsError`. */
  run: () => Promise<void>;
}

export interface LikesSyncOptions {
  /** Re-check interval while running. Default 30s. */
  heartbeatMs?: number;
  /** Pull even with an empty outbox after this long without a
   *  successful sync (catches edits from other devices). Default 5min. */
  pullIntervalMs?: number;
  /** Coalesce rapid triggers. Default 1s. */
  debounceMs?: number;
  /** Wait after `online` before attempting (the event can fire before
   *  the route is usable). Default 1.5s. */
  onlineSettleMs?: number;
  /** Backoff ceiling for failed attempts. Default 5min. */
  maxBackoffMs?: number;
}

export interface LikesSyncHandle {
  /** Ask for a sync soon (debounced, coalesced). Safe to call often. */
  requestSync: (reason?: string) => void;
  /** Drop pending/debounced/backoff work (e.g. on sign-out). */
  cancel: () => void;
  /** Remove all listeners and timers. */
  stop: () => void;
}

const BASE_BACKOFF_MS = 2000;
const OUTBOX_PREFIX = "songnest-sync-outbox:";
const CURSOR_PREFIX = "songnest-sync-cursor:";
const SESSION_KEY = "songnest-accounts-session";

function isBrowserOnline(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.onLine !== "boolean") {
    return true;
  }
  return navigator.onLine;
}

/** Current online state + re-render on change. For offline banners. */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(isBrowserOnline);
  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);
  return online;
}

/**
 * Start the background sync engine. Returns a handle; call `stop()`
 * on unmount. Starting twice creates two independent engines, so call
 * once (StrictMode dev double-effects are safe — mount, stop, start).
 */
export function startLikesSync(
  task: LikesSyncTask,
  options: LikesSyncOptions = {}
): LikesSyncHandle {
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const pullIntervalMs = options.pullIntervalMs ?? 5 * 60_000;
  const debounceMs = options.debounceMs ?? 1_000;
  const onlineSettleMs = options.onlineSettleMs ?? 1_500;
  const maxBackoffMs = options.maxBackoffMs ?? 5 * 60_000;

  let stopped = false;
  let inFlight = false;
  let queued = false;
  let backoffMs = BASE_BACKOFF_MS;
  let lastOkAt = Date.now();
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let backoffTimer: ReturnType<typeof setTimeout> | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  function clearTimer(
    timer: ReturnType<typeof setTimeout> | undefined
  ): undefined {
    if (timer !== undefined) window.clearTimeout(timer);
    return undefined;
  }

  function safeHasPending(): boolean {
    try {
      return task.hasPending();
    } catch {
      return false;
    }
  }

  function safeIsSignedIn(): boolean {
    try {
      return task.isSignedIn();
    } catch {
      return false;
    }
  }

  function attempt(): void {
    if (stopped) return;
    if (inFlight) {
      // Coalesce: run once more when the current attempt lands.
      queued = true;
      return;
    }
    if (!safeIsSignedIn()) return;
    if (!isBrowserOnline()) return;
    inFlight = true;
    void task.run().then(
      () => {
        inFlight = false;
        backoffMs = BASE_BACKOFF_MS;
        lastOkAt = Date.now();
        if (queued && !stopped) {
          queued = false;
          schedule(debounceMs);
        }
      },
      (e: unknown) => {
        inFlight = false;
        if (
          e instanceof AccountsError &&
          (e.code === "logged-out" || e.code === "credentials")
        ) {
          // Session is dead — retrying is pointless. Future logins and
          // explicit requests re-arm the engine.
          queued = false;
          return;
        }
        // Offline / unreachable / server / rate-limited: back off and
        // retry. The heartbeat also keeps the work due in case timers
        // get throttled in a background tab.
        const wait = backoffMs;
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
        backoffTimer = clearTimer(backoffTimer);
        if (!stopped) {
          backoffTimer = window.setTimeout(() => {
            backoffTimer = undefined;
            queued = false;
            attempt();
          }, wait);
        }
      }
    );
  }

  function schedule(delay: number): void {
    if (stopped) return;
    debounceTimer = clearTimer(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      debounceTimer = undefined;
      attempt();
    }, delay);
  }

  function requestSync(): void {
    queued = false;
    backoffTimer = clearTimer(backoffTimer);
    schedule(debounceMs);
  }

  /** Heartbeat: pick up queued work and overdue pulls. */
  function onHeartbeat(): void {
    if (stopped || !safeIsSignedIn() || !isBrowserOnline()) return;
    const pullDue = Date.now() - lastOkAt > pullIntervalMs;
    if (safeHasPending() || pullDue) schedule(debounceMs);
  }

  function onOnline(): void {
    settleTimer = clearTimer(settleTimer);
    settleTimer = window.setTimeout(() => {
      settleTimer = undefined;
      if (!stopped && safeIsSignedIn()) schedule(0);
    }, onlineSettleMs);
  }

  function onOffline(): void {
    // Attempts would fail fast and noisily; the `online` event (plus
    // heartbeat, once back) resumes the work.
    debounceTimer = clearTimer(debounceTimer);
    backoffTimer = clearTimer(backoffTimer);
    settleTimer = clearTimer(settleTimer);
  }

  function onVisible(): void {
    if (document.visibilityState !== "visible") return;
    if (!safeIsSignedIn() || !isBrowserOnline()) return;
    if (safeHasPending() || Date.now() - lastOkAt > pullIntervalMs) {
      schedule(debounceMs);
    }
  }

  function onPageShow(): void {
    if (!safeIsSignedIn() || !isBrowserOnline()) return;
    schedule(debounceMs);
  }

  function onStorage(e: StorageEvent): void {
    if (e.key === null) return;
    if (
      e.key.startsWith(OUTBOX_PREFIX) ||
      e.key.startsWith(CURSOR_PREFIX) ||
      e.key === SESSION_KEY
    ) {
      // Another tab queued work or changed the session.
      if (safeIsSignedIn() && isBrowserOnline()) schedule(debounceMs);
    }
  }

  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("storage", onStorage);
  heartbeatTimer = window.setInterval(onHeartbeat, heartbeatMs);

  return {
    requestSync: () => {
      if (!stopped) requestSync();
    },
    cancel: () => {
      queued = false;
      debounceTimer = clearTimer(debounceTimer);
      backoffTimer = clearTimer(backoffTimer);
      settleTimer = clearTimer(settleTimer);
      backoffMs = BASE_BACKOFF_MS;
    },
    stop: () => {
      stopped = true;
      queued = false;
      debounceTimer = clearTimer(debounceTimer);
      backoffTimer = clearTimer(backoffTimer);
      settleTimer = clearTimer(settleTimer);
      if (heartbeatTimer !== undefined) {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("storage", onStorage);
    },
  };
}
