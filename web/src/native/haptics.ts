// Tiny haptics helper. Web/desktop: silent no-op (plus Android's
// navigator.vibrate where available).
//
// TODO(native): for real iOS/Android vibration -
//   1. npm i @tauri-apps/plugin-haptics (or the Capacitor equivalent),
//   2. register it in src-tauri capabilities,
//   3. extend resolveImpl() below to call it.

export type HapticKind = "light" | "medium" | "heavy" | "selection";

const MODULE_ID = "@tauri-apps/plugin-haptics";

async function resolveImpl(): Promise<(() => unknown) | null> {
  try {
    const mod = (await import(/* @vite-ignore */ MODULE_ID).catch(
      () => null
    )) as Record<string, unknown> | null;
    if (mod === null) return null;
    const fn =
      mod.impactFeedback ?? mod.impact ?? mod.vibrate ?? mod.haptics ?? null;
    return typeof fn === "function" ? (fn as () => unknown) : null;
  } catch {
    return null;
  }
}

export async function haptic(_kind: HapticKind = "light"): Promise<void> {
  const fn = await resolveImpl();
  if (fn !== null) {
    try {
      await fn();
    } catch {
      // never break UI over haptics
    }
    return;
  }
  try {
    if ("vibrate" in navigator && typeof navigator.vibrate === "function") {
      navigator.vibrate(10);
    }
  } catch {
    // no-op
  }
}
