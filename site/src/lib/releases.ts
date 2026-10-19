export interface ReleaseAsset {
  id: number
  name: string
  browser_download_url: string
  size: number
  download_count: number
}

export interface Release {
  id: number
  tag_name: string
  name: string | null
  published_at: string | null
  prerelease: boolean
  draft: boolean
  body: string | null
  html_url: string
  assets: ReleaseAsset[]
}

export type OsKey = 'macos-arm64' | 'macos-x64' | 'macos' | 'windows' | 'linux' | 'android' | 'ios' | 'other'

/**
 * Android CPU family, best-effort from the browser. Browsers do not expose the
 * device ABI, so arm64 (almost every phone made since ~2017) is the default and
 * armeabi-v7a is only assumed for the 32-bit signals we can actually see.
 */
export type AndroidAbi = 'arm64' | 'armv7' | 'universal'

const REPO = 'Smasduq/songnest'
const API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=100`
const CACHE_KEY = 'songnest-releases-v1'
const CACHE_TTL_MS = 60 * 60 * 1000

interface CacheEntry {
  fetchedAt: number
  releases: Release[]
}

function readCache(): Release[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const entry = JSON.parse(raw) as CacheEntry
    if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null
    if (!Array.isArray(entry.releases)) return null
    return entry.releases
  } catch {
    return null
  }
}

function writeCache(releases: Release[]): void {
  try {
    const entry: CacheEntry = { fetchedAt: Date.now(), releases }
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry))
  } catch {
    // storage full or unavailable — ignore
  }
}

function pickFieldsOnly(input: unknown): Release[] {
  if (!Array.isArray(input)) return []
  return input
    .filter((r) => r && typeof r === 'object' && !(r as { draft?: boolean }).draft)
    .map((r) => {
      const rel = r as Record<string, unknown>
      const assets = Array.isArray(rel['assets'])
        ? (rel['assets'] as Record<string, unknown>[]).map((a) => ({
            id: Number(a['id'] ?? 0),
            name: String(a['name'] ?? 'download'),
            browser_download_url: String(a['browser_download_url'] ?? ''),
            size: Number(a['size'] ?? 0),
            download_count: Number(a['download_count'] ?? 0),
          }))
        : []
      return {
        id: Number(rel['id'] ?? 0),
        tag_name: String(rel['tag_name'] ?? 'untagged'),
        name: typeof rel['name'] === 'string' ? rel['name'] : null,
        published_at: typeof rel['published_at'] === 'string' ? rel['published_at'] : null,
        prerelease: Boolean(rel['prerelease']),
        draft: Boolean(rel['draft']),
        body: typeof rel['body'] === 'string' ? rel['body'] : null,
        html_url: String(rel['html_url'] ?? `https://github.com/${REPO}/releases`),
        assets: assets.filter((a) => a.browser_download_url.length > 0),
      } satisfies Release
    })
}

/** Single fetch, cached. No waterfall: one request for the whole page. */
export async function fetchReleases(signal?: AbortSignal): Promise<Release[]> {
  const cached = readCache()
  try {
    const res = await fetch(API_URL, {
      signal,
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!res.ok) {
      if (cached) return cached
      throw new Error(`GitHub API responded with ${res.status}`)
    }
    const json: unknown = await res.json()
    const releases = pickFieldsOnly(json)
    writeCache(releases)
    return releases
  } catch (err) {
    if (cached) return cached
    throw err instanceof Error ? err : new Error('Failed to load releases')
  }
}

export function classifyAsset(fileName: string): { os: OsKey; label: string } {
  const n = fileName.toLowerCase()
  if (n.endsWith('.apk')) return { os: 'android', label: 'Android APK' }
  if (n.endsWith('.ipa')) return { os: 'ios', label: 'iOS IPA' }
  if (n.includes('aarch64') && (n.endsWith('.dmg') || n.includes('mac'))) {
    return { os: 'macos-arm64', label: 'macOS Apple Silicon' }
  }
  if (n.includes('x64') && (n.endsWith('.dmg') || n.includes('mac'))) {
    return { os: 'macos-x64', label: 'macOS Intel' }
  }
  if (n.endsWith('.dmg')) return { os: 'macos', label: 'macOS disk image' }
  if (n.endsWith('.exe') || n.endsWith('.msi') || n.includes('windows') || n.includes('win')) {
    return { os: 'windows', label: 'Windows installer' }
  }
  if (
    n.endsWith('.appimage') ||
    n.endsWith('.deb') ||
    n.endsWith('.rpm') ||
    n.endsWith('.tar.gz') ||
    n.includes('linux') ||
    n.includes('ubuntu')
  ) {
    return { os: 'linux', label: 'Linux bundle' }
  }
  return { os: 'other', label: 'Download' }
}

const OS_PRIORITY: OsKey[] = ['macos-arm64', 'macos-x64', 'macos', 'windows', 'linux', 'android', 'ios', 'other']

/** Stable sort: OS priority first, then name. Avoids re-render churn. */
export function sortAssets(assets: ReleaseAsset[]): ReleaseAsset[] {
  return [...assets].sort((a, b) => {
    const pa = OS_PRIORITY.indexOf(classifyAsset(a.name).os)
    const pb = OS_PRIORITY.indexOf(classifyAsset(b.name).os)
    if (pa !== pb) return pa - pb
    return a.name.localeCompare(b.name)
  })
}

/** Best single asset for the visitor's OS, or null. */
export function pickAssetForPlatform(assets: ReleaseAsset[], platform: OsKey | null): ReleaseAsset | null {
  if (assets.length === 0 || !platform) return null
  // Android gets the ABI-aware picker: never hand a phone the 156 MB universal
  // APK if a single-ABI build exists, since some installers reject it.
  if (platform === 'android') return pickAndroidAsset(assets, detectAndroidAbi())
  const sorted = sortAssets(assets)
  const exact = sorted.find((a) => classifyAsset(a.name).os === platform)
  if (exact) return exact
  if (platform === 'macos-arm64' || platform === 'macos-x64') {
    return sorted.find((a) => classifyAsset(a.name).os === 'macos') ?? sorted[0] ?? null
  }
  return sorted[0] ?? null
}

export function detectPlatform(): OsKey | null {
  if (typeof navigator === 'undefined') return null // prerendered HTML has no navigator
  const ua = navigator.userAgent.toLowerCase()
  const plat = (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform.toLowerCase() ?? ''
  const combined = `${ua} ${plat}`
  if (combined.includes('android')) return 'android'
  if (combined.includes('iphone') || combined.includes('ipad')) return 'ios'
  if (combined.includes('mac')) return combined.includes('arm') ? 'macos-arm64' : 'macos-x64'
  if (combined.includes('win')) return 'windows'
  if (combined.includes('linux')) return 'linux'
  return null
}

/**
 * Best Android APK for a phone, preferring a single-ABI build over the
 * universal one. The universal APK packs all four ABIs (~156 MB) and some
 * installers — Transsion/HiOS on Android 15 — reject it as an invalid package,
 * so a matching per-ABI APK is the safer default.
 */
export function pickAndroidAsset(assets: ReleaseAsset[], abi: AndroidAbi): ReleaseAsset | null {
  const apks = assets.filter((a) => a.name.toLowerCase().endsWith('.apk'))
  if (apks.length === 0) return null

  const byAbi = (needle: string) => apks.find((a) => a.name.toLowerCase().includes(needle))
  const universal = apks.find((a) => a.name.toLowerCase().includes('universal'))

  if (abi === 'armv7') return byAbi('armv7') ?? universal ?? apks[0] ?? null
  if (abi === 'arm64') return byAbi('arm64') ?? byAbi('aarch64') ?? universal ?? apks[0] ?? null
  return universal ?? apks[0] ?? null
}

/**
 * Guess the phone's CPU family. Chromium exposes a bitness hint via
 * `userAgentData` on some builds; everything else falls back to arm64, which
 * is right for the overwhelming majority of Android devices.
 */
export function detectAndroidAbi(): AndroidAbi {
  if (typeof navigator === 'undefined') return 'universal'
  const nav = navigator as Navigator & {
    userAgentData?: { bitness?: string; architecture?: string }
  }
  const bitness = nav.userAgentData?.bitness
  if (bitness === '32') return 'armv7'
  if (bitness === '64') return 'arm64'
  const arch = nav.userAgentData?.architecture?.toLowerCase()
  if (arch === 'arm') return 'armv7'
  const ua = navigator.userAgent.toLowerCase()
  // x86 phones exist but are vanishingly rare; treat unknown Android as arm64.
  if (ua.includes('android')) return 'arm64'
  return 'universal'
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

export function formatDate(iso: string | null): string {
  if (!iso) return 'Unreleased'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Unreleased'
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export const REPO_URL = `https://github.com/${REPO}`
