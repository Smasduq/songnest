/**
 * Desktop backend health.
 *
 * The Tauri shell launches `songnest serve` as a sidecar. When that launch
 * fails (missing binary, blocked by antivirus, install still in progress)
 * the UI used to show a bare "offline" screen with no explanation. The
 * Rust side now records the failure and emits `backend-error`; this module
 * exposes both the initial read (the failure usually happens before the
 * WebView mounts) and the live event.
 */

export interface BackendIssue {
  message: string;
  detail: string;
}

function isNative(): boolean {
  if (typeof window === "undefined") return false;
  // `withGlobalTauri` is off, so `__TAURI__` may be absent while the v2
  // bridge (`__TAURI_INTERNALS__`) is present. The origin is the tiebreaker.
  if ("__TAURI__" in window || "__TAURI_INTERNALS__" in window) return true;
  if (window.location.protocol === "tauri:") return true;
  return window.location.hostname === "tauri.localhost";
}

/** Last backend launch failure, if any. Null in a browser or on mobile. */
export async function fetchBackendIssue(): Promise<BackendIssue | null> {
  if (!isNative()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<BackendIssue | null>("backend_diagnostics");
  } catch {
    return null;
  }
}

/** Subscribe to backend failures that happen after mount (restarts). */
export async function subscribeBackendIssue(
  onIssue: (issue: BackendIssue) => void
): Promise<() => void> {
  if (!isNative()) return () => {};
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<BackendIssue>("backend-error", (event) => {
      onIssue(event.payload);
    });
  } catch {
    return () => {};
  }
}
