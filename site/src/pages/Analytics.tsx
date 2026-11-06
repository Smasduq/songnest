import { useMemo } from 'react'
import { BarChart3, Download, FileArchive, Tags } from 'lucide-react'
import { formatDate, type Release } from '../lib/releases.ts'
import { computeStats, formatCount } from '../lib/stats.ts'
import { CumulativeChart, DonutChart } from '../components/Chart.tsx'

interface Props {
  releases: Release[]
  loading: boolean
  error: string | null
}

function Kpi({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Download
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="min-w-0 rounded-[15px] border border-[#3a3a3a] bg-[#232323] p-4 sm:p-5">
      <div className="flex items-center gap-2 text-[13px] text-[#6a6a6a]">
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        {label}
      </div>
      <p className="mt-2 text-[28px] leading-none font-medium tabular-nums">{value}</p>
      {hint ? <p className="mt-2 text-[13px] text-[#6a6a6a]">{hint}</p> : null}
    </div>
  )
}

function Bar({ value, max }: { value: number; max: number }) {
  const width = max > 0 ? Math.max(1, Math.round((value / max) * 100)) : 0
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#262626]">
      <div className="h-full rounded-full bg-[#fefefe]" style={{ width: `${width}%` }} />
    </div>
  )
}

export default function Analytics({ releases, loading, error }: Props) {
  const stats = useMemo(() => computeStats(releases), [releases])
  const maxRelease = useMemo(
    () => stats.releases.reduce((max, r) => Math.max(max, r.downloads), 0),
    [stats.releases],
  )
  const cumulative = useMemo(() => {
    const ordered = [...stats.releases].sort((a, b) =>
      (a.publishedAt ?? '').localeCompare(b.publishedAt ?? ''),
    )
    let running = 0
    return ordered.map((r) => {
      running += r.downloads
      return { label: r.tag, value: running, date: r.publishedAt }
    })
  }, [stats.releases])

  return (
    <article className="mx-auto max-w-6xl px-4 py-12">
      <a href="#top" className="text-sm text-[#8a8a8a] hover:text-white">
        ← Back to home
      </a>
      <h1 className="mt-4 flex items-center gap-2 text-2xl font-bold text-[#f5f5f4] sm:text-3xl">
        <BarChart3 className="size-6 shrink-0 sm:size-7" aria-hidden="true" />
        Download analytics
      </h1>
      <p className="mt-2 max-w-2xl text-[15px] text-[#aeaeae]">
        Every file on every release, counted straight from GitHub. Updated hourly, cached in your
        browser for an hour.
      </p>

      {loading ? (
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Loading analytics">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-[15px] bg-[#262626]" />
          ))}
        </div>
      ) : error ? (
        <div className="mt-8 rounded-[15px] border border-[#3a3a3a] bg-[#232323] p-5" role="alert">
          <p className="text-[15px]">Couldn&apos;t load download stats.</p>
          <p className="mt-1 text-[13px] text-[#aeaeae]">{error}</p>
          <a
            href="https://github.com/Smasduq/songnest/releases"
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-block rounded-full bg-[#fefefe] px-4 py-2 text-[13px] font-medium text-[#010002]"
          >
            See the numbers on GitHub
          </a>
        </div>
      ) : releases.length === 0 ? (
        <div className="mt-8 rounded-[15px] border border-[#3a3a3a] bg-[#232323] p-5">
          <p className="text-[15px]">No release data yet.</p>
          <p className="mt-1 text-[13px] text-[#aeaeae]">
            Statistics appear as soon as the first release is published.
          </p>
        </div>
      ) : (
        <>
          <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Kpi
              icon={Download}
              label="Total downloads"
              value={formatCount(stats.totalDownloads)}
              hint="All versions, all files"
            />
            <Kpi
              icon={Tags}
              label="Latest release"
              value={stats.latestTag ?? '—'}
              hint={`${formatCount(stats.latestDownloads)} downloads · ${formatDate(stats.latestPublishedAt)}`}
            />
            <Kpi
              icon={FileArchive}
              label="Files published"
              value={formatCount(stats.totalFiles)}
              hint={`Across ${formatCount(stats.releaseCount)} releases`}
            />
            <Kpi
              icon={BarChart3}
              label="Platforms"
              value={String(stats.platforms.length)}
              hint={stats.platforms.map((p) => p.label).join(' · ')}
            />
          </div>

          <div className="mt-8 grid gap-6 lg:grid-cols-2 lg:gap-8">
            <section className="min-w-0" aria-labelledby="platform-heading">
              <h2 id="platform-heading" className="text-xl font-medium tracking-tight">
                Downloads by platform
              </h2>
              <p className="mt-1 text-[13px] text-[#6a6a6a]">
                Grouped from the file names GitHub lists for each release.
              </p>
              <div className="mt-4 rounded-[15px] border border-[#3a3a3a] bg-[#232323] p-5">
                <DonutChart
                  slices={stats.platforms.map((p) => ({ label: p.label, value: p.downloads }))}
                />
              </div>
            </section>

            <section className="min-w-0" aria-labelledby="growth-heading">
              <h2 id="growth-heading" className="text-xl font-medium tracking-tight">
                Cumulative downloads
              </h2>
              <p className="mt-1 text-[13px] text-[#6a6a6a]">
                Each version&apos;s total added at its publish date. GitHub has no per-day history, so
                read this as an outline, not a daily log.
              </p>
              <div className="mt-4 rounded-[15px] border border-[#3a3a3a] bg-[#232323] p-5">
                <CumulativeChart points={cumulative} />
              </div>
            </section>
          </div>

          <section className="mt-8" aria-labelledby="releases-heading">
            <h2 id="releases-heading" className="text-xl font-medium tracking-tight">
              Downloads by release
            </h2>
            <p className="mt-1 text-[13px] text-[#6a6a6a]">
              Newest first. Counts stay with the files, so old versions keep their numbers.
            </p>
            <div className="mt-4 space-y-3 rounded-[15px] border border-[#3a3a3a] bg-[#232323] p-5">
              {stats.releases.map((r) => (
                <div key={r.id} className="min-w-0">
                  <div className="flex items-baseline justify-between gap-3 text-[13px]">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate font-medium tabular-nums">{r.tag}</span>
                      {r.prerelease ? (
                        <span className="shrink-0 rounded-full border border-[#838486] px-1.5 py-0.5 text-[10px] text-[#aeaeae]">
                          pre
                        </span>
                      ) : null}
                      <span className="hidden shrink-0 text-[#6a6a6a] sm:inline">
                        {formatDate(r.publishedAt)}
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums text-[#aeaeae]">
                      {formatCount(r.downloads)}
                      <span className="ml-2 text-[#6a6a6a]">
                        {r.files} {r.files === 1 ? 'file' : 'files'}
                      </span>
                    </span>
                  </div>
                  <div className="mt-1.5">
                    <Bar value={r.downloads} max={maxRelease} />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="mt-8" aria-labelledby="files-heading">
            <h2 id="files-heading" className="text-xl font-medium tracking-tight">
              Top files
            </h2>
            <p className="mt-1 text-[13px] text-[#6a6a6a]">The ten most downloaded assets.</p>
            <ol className="mt-4 divide-y divide-[#3a3a3a] rounded-[15px] border border-[#3a3a3a] bg-[#232323]">
              {stats.topFiles.map((f, i) => (
                <li key={f.id} className="flex min-w-0 items-center gap-3 p-4">
                  <span className="w-5 shrink-0 text-[13px] tabular-nums text-[#6a6a6a]">
                    {i + 1}
                  </span>
                  <a
                    href={f.url}
                    className="min-w-0 flex-1 transition-opacity hover:opacity-80"
                    title={f.name}
                  >
                    <span className="block truncate text-[13px] font-medium">{f.name}</span>
                    <span className="block text-[11px] text-[#6a6a6a]">
                      {f.platform} · {f.release}
                    </span>
                  </a>
                  <span className="shrink-0 text-[13px] tabular-nums text-[#aeaeae]">
                    {formatCount(f.downloads)}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <p className="mt-6 text-[13px] text-[#6a6a6a]">
            Numbers come from the GitHub Releases API. A download only counts when someone takes a
            file from the release page or a direct link — not when the page is viewed.
          </p>
        </>
      )}
    </article>
  )
}
