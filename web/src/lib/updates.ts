/**
 * In-app update checks against GitHub Releases. No backend involved:
 * the app fetches the release list, compares tags with its own version,
 * and hands the right installer to the OS (system browser/download on
 * desktop, APK download on Android). Installing is manual — open the
 * downloaded file.
 *
 * Works in the Tauri desktop/mobile shells and in plain browsers (dev).
 */

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface AppRelease {
  tag_name: string;
  name: string | null;
  published_at: string | null;
  prerelease: boolean;
  body: string | null;
  html_url: string;
  assets: ReleaseAsset[];
}

const REPO = "Smasduq/songnest";
const API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=20`;
const CACHE_KEY = "songnest-update-check-v1";
const CACHE_TTL_MS = 60 * 60 * 1000;
/** Fallback when the Tauri runtime is unreachable (browser dev). Keep in
 *  sync with package.json / tauri.conf.json. */
const FALLBACK_VERSION = "0.3.1";

interface CacheEntry {
  fetchedAt: number;
  releases: AppRelease[];
}

function readCache(): AppRelease[] | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (raw === null) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null;
    return Array.isArray(entry.releases) ? entry.releases : null;
  } catch {
    return null;
  }
}

function writeCache(releases: AppRelease[]): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), releases }));
  } catch {
    // Storage full/blocked: checks just run uncached.
  }
}

function pickFields(input: unknown): AppRelease[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((r) => r !== null && typeof r === "object" && !(r as { draft?: boolean }).draft)
    .map((r) => {
      const rel = r as Record<string, unknown>;
      const assets = Array.isArray(rel["assets"])
        ? (rel["assets"] as Record<string, unknown>[])
            .map((a) => ({
              name: String(a["name"] ?? "download"),
              browser_download_url: String(a["browser_download_url"] ?? ""),
              size: Number(a["size"] ?? 0),
            }))
            .filter((a) => a.browser_download_url !== "")
        : [];
      return {
        tag_name: String(rel["tag_name"] ?? ""),
        name: typeof rel["name"] === "string" ? rel["name"] : null,
        published_at: typeof rel["published_at"] === "string" ? rel["published_at"] : null,
        prerelease: Boolean(rel["prerelease"]),
        body: typeof rel["body"] === "string" ? rel["body"] : null,
        html_url: String(rel["html_url"] ?? `https://github.com/${REPO}/releases`),
        assets,
      };
    })
    .filter((r) => r.tag_name !== "");
}

/** Latest usable release (stable preferred, prerelease fallback). */
export async function fetchLatestRelease(): Promise<AppRelease | null> {
  const cached = readCache();
  try {
    const res = await fetch(API_URL, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return latestOf(cached ?? []);
    const releases = pickFields(await res.json());
    writeCache(releases);
    return latestOf(releases);
  } catch {
    return latestOf(cached ?? []);
  }
}

function latestOf(releases: AppRelease[]): AppRelease | null {
  if (releases.length === 0) return null;
  return releases.find((r) => !r.prerelease) ?? releases[0] ?? null;
}

/** This app's version: Tauri runtime first, build fallback second. */
export async function getCurrentVersion(): Promise<string> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    const v = await getVersion();
    if (typeof v === "string" && v !== "") return v;
  } catch {
    // Not in Tauri (browser dev) — fall through.
  }
  return FALLBACK_VERSION;
}

interface ParsedTag {
  core: number[];
  pre: string | null;
}

function parseTag(tag: string): ParsedTag | null {
  const m = /^v?(\d+(?:\.\d+)*)(?:[-.](.+))?$/.exec(tag.trim());
  if (m === null) return null;
  return { core: m[1].split(".").map(Number), pre: m[2] ?? null };
}

/** Compare tags: >0 when a is newer, <0 when older, 0 when equal.
 *  Unparseable tags → null (unknown). */
export function compareTags(a: string, b: string): number | null {
  const pa = parseTag(a);
  const pb = parseTag(b);
  if (pa === null || pb === null) return null;
  const len = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

export type OsKey = "android" | "ios" | "windows" | "macos" | "linux" | "other";

/**
 * Android CPU family, best-effort from the WebView. Neither the browser nor a
 * Tauri WebView exposes the ABI, so arm64 (almost every phone since ~2017) is
 * the default. This only decides which APK to *prefer*; the universal APK
 * remains a fallback, since a wrong guess still has to install.
 */
export type AndroidAbi = "arm64" | "armv7" | "universal";

/** Guess the phone's CPU family from Chromium's bitness hint, else UA. */
export function detectAndroidAbi(): AndroidAbi {
  if (typeof navigator === "undefined") return "universal";
  const nav = navigator as Navigator & { userAgentData?: { bitness?: string; architecture?: string } };
  const bitness = nav.userAgentData?.bitness;
  if (bitness === "32") return "armv7";
  if (bitness === "64") return "arm64";
  const arch = nav.userAgentData?.architecture?.toLowerCase();
  if (arch === "arm") return "armv7";
  if (navigator.userAgent.toLowerCase().includes("android")) return "arm64";
  return "universal";
}

/** Current OS via UA sniffing (works in Tauri WebViews too: desktop UAs
 *  carry Windows/Mac/Linux, Android WebViews carry Android). */
export async function detectOs(): Promise<OsKey> {
  const ua = navigator.userAgent.toLowerCase();
  const plat =
    (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform.toLowerCase() ??
    "";
  const combined = `${ua} ${plat}`;
  if (combined.includes("android")) return "android";
  if (combined.includes("iphone") || combined.includes("ipad")) return "ios";
  if (combined.includes("win")) return "windows";
  if (combined.includes("mac")) return "macos";
  if (combined.includes("linux")) return "linux";
  return "other";
}

function assetScore(name: string, os: OsKey, abi: AndroidAbi = "universal"): number {
  const n = name.toLowerCase();
  switch (os) {
    case "android": {
      if (!n.endsWith(".apk")) return 99;
      const isUniversal = n.includes("universal");
      // Rank the single-ABI APK for this phone first. The universal APK packs
      // all four ABIs (~156 MB) and some installers reject it as an invalid
      // package, so it is a fallback, never the default.
      if (abi === "armv7") {
        if (n.includes("armv7") || n.includes("armeabi")) return 0;
        if (isUniversal) return 1;
        return 2;
      }
      if (abi === "arm64") {
        if (n.includes("arm64") || n.includes("aarch64")) return 0;
        if (isUniversal) return 1;
        return 2;
      }
      return isUniversal ? 0 : 1;
    }
    case "ios":
      return n.endsWith(".ipa") ? 0 : 99;
    case "windows":
      if (n.endsWith(".msi")) return 0;
      if (n.endsWith(".exe")) return 1;
      return 99;
    case "macos":
      if (n.endsWith(".dmg")) return n.includes("aarch64") || n.includes("arm64") ? 0 : 1;
      return 99;
    case "linux":
      if (n.endsWith(".deb")) return 0;
      if (n.endsWith(".appimage")) return 1;
      if (n.endsWith(".rpm")) return 2;
      if (n.endsWith(".tar.gz")) return 3;
      return 99;
    case "other":
      return 50;
  }
}

/** Best asset for this OS first, rest after. */
function sortAssetsForOs(assets: ReleaseAsset[], os: OsKey): ReleaseAsset[] {
  const abi = os === "android" ? detectAndroidAbi() : "universal";
  return [...assets].sort(
    (a, b) => assetScore(a.name, os, abi) - assetScore(b.name, os, abi) || a.name.localeCompare(b.name),
  );
}

/** Running inside any Tauri shell (desktop or mobile)? */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

/** Best asset for this OS, or null. The app always knows which file it
 *  needs — the UI never lists options. */
export function pickAsset(assets: ReleaseAsset[], os: OsKey): ReleaseAsset | null {
  return sortAssetsForOs(assets, os)[0] ?? null;
}

/** Desktop Tauri shell (updater-capable)? Mobile and browsers use the
 *  download flow instead. */
export function isDesktopTauri(os: OsKey): boolean {
  return isTauri() && os !== "android" && os !== "ios";
}

export interface TauriUpdate {
  version: string;
  date?: string;
  body?: string;
  downloadAndInstall: (
    onEvent: (downloaded: number, total: number | null, finished: boolean) => void,
  ) => Promise<void>;
  relaunch: () => Promise<void>;
}

/** Check via the Tauri updater (signed bundles, in-place install).
 *  Returns null when up to date. Throws with a showable message. */
export async function checkTauriUpdate(): Promise<TauriUpdate | null> {
  const { check } = await import("@tauri-apps/plugin-updater");
  const { relaunch } = await import("@tauri-apps/plugin-process");
  let update;
  try {
    update = await check();
  } catch {
    throw new Error("Couldn't reach the update server — check your connection.");
  }
  if (update === null) return null;
  return {
    version: update.version,
    date: update.date,
    body: update.body,
    downloadAndInstall: async (onEvent) => {
      let total: number | null = null;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? null;
        else if (event.event === "Progress") onEvent(event.data.chunkLength, total, false);
        else if (event.event === "Finished") onEvent(0, total, true);
      });
    },
    relaunch: () => relaunch(),
  };
}

/** Open a download: system handler in Tauri, new tab otherwise. */
export async function openDownload(url: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function formatDate(iso: string | null): string {
  if (iso === null) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export const ALL_RELEASES_URL = `https://github.com/${REPO}/releases`;
