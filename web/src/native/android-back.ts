/**
 * Android hardware/gesture back button.
 *
 * The app keeps its own page stack and never pushes browser history, so by
 * default Android finishes the activity on every back press — even with a
 * sheet open or several in-app pages deep. Registering a listener takes over
 * that default; the callback decides whether the press was consumed or should
 * close the app.
 *
 * No-op outside the Android Tauri shell (desktop, iOS, browsers).
 */

/** True inside the Android Tauri app (not desktop, not a mobile browser). */
function isAndroidTauri(): boolean {
  if (typeof window === "undefined") return false;
  if (!("__TAURI_INTERNALS__" in window || "__TAURI__" in window)) return false;
  return /android/i.test(navigator.userAgent);
}

export type BackResult = "handled" | "exit";

/**
 * Listen for the Android back button.
 *
 * @param handler Called on every press. Return `"exit"` to let the app close
 *   (the usual behavior at the root of the page stack), or `"handled"` when
 *   the press was used to close a sheet / pop an in-app page.
 * @returns Unregister function. Safe to call even if registration failed.
 */
export async function registerAndroidBackHandler(
  handler: () => BackResult
): Promise<() => void> {
  if (!isAndroidTauri()) return () => {};

  try {
    const { exit, onBackButtonPress } = await import("@tauri-apps/api/app");
    const listener = await onBackButtonPress(() => {
      if (handler() === "exit") void exit(0);
    });
    return () => {
      void listener.unregister();
    };
  } catch (e) {
    // Older runtimes or a missing capability: leave Android's default
    // behavior (close the app) in place rather than breaking startup.
    console.warn("Android back handler unavailable", e);
    return () => {};
  }
}
