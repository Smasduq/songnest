import { classifyAsset, isDownloadableAsset, type OsKey, type Release } from './releases.ts'

export interface PlatformStat {
  key: string
  label: string
  downloads: number
  files: number
}

export interface ReleaseStat {
  id: number
  tag: string
  publishedAt: string | null
  prerelease: boolean
  downloads: number
  files: number
}

export interface FileStat {
  id: number
  name: string
  url: string
  size: number
  downloads: number
  platform: string
  release: string
}

export interface Stats {
  totalDownloads: number
  totalFiles: number
  releaseCount: number
  latestDownloads: number
  latestTag: string | null
  latestPublishedAt: string | null
  platforms: PlatformStat[]
  releases: ReleaseStat[]
  topFiles: FileStat[]
}

const PLATFORM_LABELS: Record<string, string> = {
  'macos-arm64': 'macOS',
  'macos-x64': 'macOS',
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  android: 'Android',
  ios: 'iOS',
  other: 'Other',
}

/** Display order for the platform breakdown. */
const PLATFORM_ORDER = ['Windows', 'macOS', 'Linux', 'Android', 'iOS', 'Other']

export function platformLabel(os: OsKey): string {
  return PLATFORM_LABELS[os] ?? 'Other'
}

/**
 * Rolls the GitHub release payload up into the numbers the site shows.
 * Everything here is derived from `download_count`, which GitHub reports per
 * asset and keeps cumulative for the life of the file.
 */
export function computeStats(releases: Release[]): Stats {
  const byPlatform = new Map<string, PlatformStat>()
  for (const label of PLATFORM_ORDER) {
    byPlatform.set(label, { key: label.toLowerCase(), label, downloads: 0, files: 0 })
  }

  let totalDownloads = 0
  let totalFiles = 0
  const releaseStats: ReleaseStat[] = []
  const files: FileStat[] = []

  for (const release of releases) {
    let releaseDownloads = 0
    const downloadAssets = release.assets.filter((asset) => isDownloadableAsset(asset.name))
    for (const asset of downloadAssets) {
      const label = platformLabel(classifyAsset(asset.name).os)
      const bucket = byPlatform.get(label) ?? byPlatform.get('Other')!
      bucket.downloads += asset.download_count
      bucket.files += 1
      releaseDownloads += asset.download_count
      totalDownloads += asset.download_count
      totalFiles += 1
      files.push({
        id: asset.id,
        name: asset.name,
        url: asset.browser_download_url,
        size: asset.size,
        downloads: asset.download_count,
        platform: label,
        release: release.tag_name,
      })
    }
    releaseStats.push({
      id: release.id,
      tag: release.tag_name,
      publishedAt: release.published_at,
      prerelease: release.prerelease,
      downloads: releaseDownloads,
      files: downloadAssets.length,
    })
  }

  const platforms = PLATFORM_ORDER.map((label) => byPlatform.get(label)!).filter(
    (p) => p.files > 0,
  )

  const latest = releases[0] ?? null
  const latestStat = latest ? releaseStats.find((r) => r.id === latest.id) : undefined

  return {
    totalDownloads,
    totalFiles,
    releaseCount: releases.length,
    latestDownloads: latestStat?.downloads ?? 0,
    latestTag: latest?.tag_name ?? null,
    latestPublishedAt: latest?.published_at ?? null,
    platforms,
    releases: releaseStats,
    topFiles: files.sort((a, b) => b.downloads - a.downloads).slice(0, 10),
  }
}

export function formatCount(value: number): string {
  return value.toLocaleString()
}
