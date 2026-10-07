import { memo } from 'react'
import { Apple, ArrowDownToLine, Monitor, Smartphone } from 'lucide-react'
import { classifyAsset, formatBytes, sortAssets, type Release } from '../lib/releases.ts'

interface Props {
  latest: Release | null
  loading: boolean
  error: string | null
}

const GROUP_ORDER = ['macos-arm64', 'macos-x64', 'macos', 'windows', 'linux', 'android', 'ios'] as const

const GROUP_META: Record<string, { icon: typeof Monitor; title: string; hint: string }> = {
  'macos-arm64': { icon: Apple, title: 'macOS — Apple Silicon', hint: '.dmg arm64' },
  'macos-x64': { icon: Apple, title: 'macOS — Intel', hint: '.dmg x64' },
  macos: { icon: Apple, title: 'macOS', hint: '.dmg' },
  windows: { icon: Monitor, title: 'Windows', hint: '.msi / .exe' },
  linux: { icon: Monitor, title: 'Linux', hint: '.AppImage / .deb' },
  android: { icon: Smartphone, title: 'Android (experimental)', hint: '.apk thin client' },
  ios: { icon: Smartphone, title: 'iOS (unsigned, best-effort)', hint: '.ipa sideload only' },
}

function DownloadLatest({ latest, loading, error }: Props) {
  return (
    <section id="download" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-10" aria-labelledby="dl-heading">
      <h2 id="dl-heading" className="text-2xl font-medium tracking-tight">
        Download Songnest
      </h2>
      <p className="mt-2 max-w-2xl text-[15px] text-[#aeaeae]">
        Pick the bundle for your system. iOS builds are unsigned and only useful for local
        sideloading/testing.
      </p>
      {loading ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Loading downloads">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-36 animate-pulse rounded-[15px] bg-[#262626]" />
          ))}
        </div>
      ) : error || !latest ? (
        <div className="mt-6 rounded-[15px] border border-[#3a3a3a] bg-[#232323] p-5" role="alert">
          <p className="text-[15px]">Couldn&apos;t load release files right now.</p>
          <p className="mt-1 text-[13px] text-[#aeaeae]">
            {error ?? 'No releases found yet.'} You can still get every version directly on GitHub.
          </p>
          <a
            href="https://github.com/Smasduq/songnest/releases"
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-block rounded-full bg-[#fefefe] px-4 py-2 text-[13px] font-medium text-[#010002]"
          >
            Open GitHub releases
          </a>
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {GROUP_ORDER.map((group) => {
            const assets = sortAssets(latest.assets).filter((a) => classifyAsset(a.name).os === group)
            if (assets.length === 0) return null
            const meta = GROUP_META[group]
            const Icon = meta.icon
            return (
              <article key={group} className="rounded-[15px] border border-[#3a3a3a] bg-[#232323] p-5">
                <div className="flex items-center gap-2">
                  <Icon className="size-5" aria-hidden="true" />
                  <h3 className="text-[15px] font-medium">{meta.title}</h3>
                </div>
                <p className="mt-1 text-[13px] text-[#6a6a6a]">
                  {latest.tag_name} · {meta.hint}
                </p>
                <ul className="mt-3 space-y-2">
                  {assets.map((a) => (
                    <li key={a.id}>
                      <a
                        href={a.browser_download_url}
                        className="flex items-center justify-between gap-2 rounded-[10px] border border-[#3a3a3a] px-3 py-2 text-[13px] transition-opacity hover:opacity-80"
                      >
                        <span className="truncate" title={a.name}>
                          {a.name}
                        </span>
                        <span className="flex shrink-0 items-center gap-1 text-[#aeaeae]">
                          {a.size > 0 ? <span className="tabular-nums">{formatBytes(a.size)}</span> : null}
                          <ArrowDownToLine className="size-4" aria-hidden="true" />
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

export default memo(DownloadLatest)
