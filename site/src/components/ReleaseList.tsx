import { memo, useMemo, useState } from 'react'
import { ArrowDownToLine, ArrowUpRight } from 'lucide-react'
import {
  classifyAsset,
  formatBytes,
  formatDate,
  sortAssets,
  type OsKey,
  type Release,
} from '../lib/releases.ts'

interface Props {
  releases: Release[]
  loading: boolean
  error: string | null
}

const FILTERS: { key: OsKey | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'windows', label: 'Windows' },
  { key: 'linux', label: 'Linux' },
  { key: 'macos-arm64', label: 'macOS Arm' },
  { key: 'macos-x64', label: 'macOS Intel' },
  { key: 'android', label: 'Android' },
]

function ReleaseCard({ release, filter }: { release: Release; filter: OsKey | 'all' }) {
  const [expanded, setExpanded] = useState(false)
  const assets = useMemo(() => {
    const sorted = sortAssets(release.assets)
    if (filter === 'all') return sorted
    return sorted.filter((a) => {
      const os = classifyAsset(a.name).os
      if (filter === 'macos-arm64') return os === 'macos-arm64' || os === 'macos'
      if (filter === 'macos-x64') return os === 'macos-x64' || os === 'macos'
      return os === filter
    })
  }, [release.assets, filter])

  const totalDownloads = release.assets.reduce((sum, a) => sum + a.download_count, 0)

  return (
    <article className="rounded-[15px] border border-[#3a3a3a] bg-[#232323] p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[17px] font-medium tabular-nums">{release.tag_name}</h3>
        {release.prerelease ? (
          <span className="rounded-full border border-[#838486] px-2 py-0.5 text-[11px] text-[#aeaeae]">
            pre-release
          </span>
        ) : (
          <span className="rounded-full bg-[#fefefe] px-2 py-0.5 text-[11px] font-medium text-[#010002]">
            stable
          </span>
        )}
        <span className="text-[13px] text-[#6a6a6a]">
          {formatDate(release.published_at)}
          {totalDownloads > 0 ? ` · ${totalDownloads.toLocaleString()} downloads` : ''}
        </span>
        <a
          href={release.html_url}
          target="_blank"
          rel="noreferrer"
          aria-label={`View ${release.tag_name} on GitHub`}
          className="ml-auto inline-flex items-center gap-1 text-[13px] text-[#aeaeae] transition-opacity hover:opacity-80"
        >
          Notes <ArrowUpRight className="size-4" aria-hidden="true" />
        </a>
      </div>
      {release.body ? (
        <div className="mt-2">
          <p
            className={`text-[13px] leading-relaxed whitespace-pre-line text-[#aeaeae] ${expanded ? '' : 'line-clamp-3'}`}
          >
            {release.body.slice(0, 1200)}
          </p>
          {release.body.length > 220 ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 text-[13px] text-[#fefefe] underline underline-offset-4"
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          ) : null}
        </div>
      ) : null}
      {assets.length === 0 ? (
        <p className="mt-3 text-[13px] text-[#6a6a6a]">No files for this filter in {release.tag_name}.</p>
      ) : (
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {assets.map((a) => {
            const { label } = classifyAsset(a.name)
            return (
              <li key={a.id}>
                <a
                  href={a.browser_download_url}
                  className="flex items-center justify-between gap-2 rounded-[10px] border border-[#3a3a3a] px-3 py-2 text-[13px] transition-opacity hover:opacity-80"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium" title={a.name}>
                      {a.name}
                    </span>
                    <span className="block text-[11px] text-[#6a6a6a]">
                      {label}
                      {a.size > 0 ? ` · ${formatBytes(a.size)}` : ''}
                      {a.download_count > 0 ? ` · ${a.download_count.toLocaleString()}` : ''}
                    </span>
                  </span>
                  <ArrowDownToLine className="size-4 shrink-0" aria-hidden="true" />
                </a>
              </li>
            )
          })}
        </ul>
      )}
    </article>
  )
}

const MemoCard = memo(ReleaseCard)

function ReleaseList({ releases, loading, error }: Props) {
  const [filter, setFilter] = useState<OsKey | 'all'>('all')
  const [showStableOnly, setShowStableOnly] = useState(false)

  const visible = useMemo(
    () => (showStableOnly ? releases.filter((r) => !r.prerelease) : releases),
    [releases, showStableOnly],
  )

  return (
    <section id="releases" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-10" aria-labelledby="releases-heading">
      <h2 id="releases-heading" className="text-2xl font-medium tracking-tight">
        Every release
      </h2>
      <p className="mt-2 max-w-2xl text-[15px] text-[#aeaeae]">
        Download any version you want, straight from GitHub Releases. Counts and files update
        automatically.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label="Filter by system">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            aria-pressed={filter === f.key}
            className={`rounded-full px-3 py-1.5 text-[13px] transition-opacity ${
              filter === f.key
                ? 'bg-[#fefefe] font-medium text-[#010002]'
                : 'border border-[#3a3a3a] text-[#aeaeae] hover:opacity-80'
            }`}
          >
            {f.label}
          </button>
        ))}
        <label className="ml-1 inline-flex cursor-pointer items-center gap-2 text-[13px] text-[#aeaeae]">
          <input
            type="checkbox"
            checked={showStableOnly}
            onChange={(e) => setShowStableOnly(e.target.checked)}
            className="size-4 accent-white"
          />
          Stable only
        </label>
      </div>
      {loading ? (
        <div className="mt-6 space-y-4" aria-label="Loading releases">
          {[0, 1].map((i) => (
            <div key={i} className="h-44 animate-pulse rounded-[15px] bg-[#262626]" />
          ))}
        </div>
      ) : error ? (
        <div className="mt-6 rounded-[15px] border border-[#3a3a3a] bg-[#232323] p-5" role="alert">
          <p className="text-[15px]">Couldn&apos;t load the release list.</p>
          <p className="mt-1 text-[13px] text-[#aeaeae]">{error}</p>
        </div>
      ) : visible.length === 0 ? (
        <p className="mt-6 rounded-[15px] border border-[#3a3a3a] bg-[#232323] p-5 text-[13px] text-[#aeaeae]">
          No releases match this filter yet.
        </p>
      ) : (
        <div className="mt-6 space-y-4">
          {visible.map((r) => (
            <MemoCard key={r.id} release={r} filter={filter} />
          ))}
        </div>
      )}
    </section>
  )
}

export default memo(ReleaseList)
