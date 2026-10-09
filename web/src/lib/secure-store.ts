/**
 * Secret storage for account tokens.
 *
 * Native (Tauri): OS credential store via the `secret_*` commands in
 * src-tauri (macOS Keychain, Windows Credential Manager, Linux Secret
 * Service, mobile keystores). Browser dev / fallback: localStorage.
 * Tokens are never written to plaintext config files.
 */

const FALLBACK_PREFIX = "songnest-secret:";

function isNative(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

async function invoke<T>(cmd: string, args: Record<string, string>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Non-technical error for storage failures (safe to show). */
export class SecretStoreError extends Error {}

/** Read a secret. Returns null when absent. */
export async function secretGet(key: string): Promise<string | null> {
  if (isNative()) {
    try {
      return await invoke<string | null>("secret_get", { key });
    } catch {
      // Keychain unavailable (e.g. headless Linux): fall through.
    }
  }
  try {
    return window.localStorage.getItem(FALLBACK_PREFIX + key);
  } catch {
    throw new SecretStoreError("couldn't read saved login");
  }
}

/** Write a secret. */
export async function secretSet(key: string, value: string): Promise<void> {
  if (isNative()) {
    try {
      await invoke("secret_set", { key, value });
      return;
    } catch {
      // Fall through to localStorage.
    }
  }
  try {
    window.localStorage.setItem(FALLBACK_PREFIX + key, value);
  } catch {
    throw new SecretStoreError("couldn't save login on this device");
  }
}

/** Delete a secret. Missing keys are fine. */
export async function secretDelete(key: string): Promise<void> {
  if (isNative()) {
    try {
      await invoke("secret_delete", { key });
    } catch {
      // Best effort; continue to clear the fallback too.
    }
  }
  try {
    window.localStorage.removeItem(FALLBACK_PREFIX + key);
  } catch {
    // Best effort.
  }
}
