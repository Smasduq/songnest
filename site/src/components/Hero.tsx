import { memo, useMemo } from 'react'
import { ArrowDownToLine, MessagesSquare, MonitorDown, TriangleAlert } from 'lucide-react'
import {
  detectPlatform,
  formatBytes,
  pickAssetForPlatform,
  WHATSAPP_URL,
  type Release,
} from '../lib/releases.ts'
import { computeStats, formatCount } from '../lib/stats.ts'

interface Props {
  latest: Release | null
  loading: boolean
  error: string | null
  releases: Release[]
}

function Hero({ latest, loading, error, releases }: Props) {
  const platform = detectPlatform()
  const asset = latest ? pickAssetForPlatform(latest.assets, platform) : null
  const stats = useMemo(() => computeStats(releases), [releases])
  const pending = loading || error !== null

  return (
    <section className="mx-auto max-w-6xl px-4 pt-14 pb-10 md:pt-20" aria-labelledby="hero-heading">
      <img
        src="/songnest-logo.png"
        alt="Songnest logo"
        width={64}
        height={64}
        className="mb-5 size-16 rounded-[18px] object-cover"
      />
      <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-[#3a3a3a] bg-[#232323] px-3 py-1 text-[13px] text-[#aeaeae]">
        <TriangleAlert className="size-4" aria-hidden="true" />
        Released — desktop and Android
      </p>
      <h1
        id="hero-heading"
        className="max-w-3xl text-[41px] leading-[1.05] font-medium tracking-tight text-balance"
      >
        Your music library, on your desktop.
      </h1>
      <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-[#aeaeae] text-pretty">
        Songnest is a music player and library app for your PC and phone. Search songs, save them,
        and play them — no account needed, no subscription, no nonsense. This site just explains the
        app and lets you download it.
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        {loading ? (
          <div className="h-11 w-56 animate-pulse rounded-full bg-[#262626]" aria-label="Loading download" />
        ) : asset ? (
          <a
            href={asset.browser_download_url}
            className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-[#fefefe] px-5 py-2.5 text-[15px] font-medium text-[#010002] transition-opacity hover:opacity-90 sm:w-auto"
          >
            <ArrowDownToLine className="size-4 shrink-0" aria-hidden="true" />
            <span>
              Download {latest?.tag_name} for your device
              {asset.size > 0 ? (
                <span className="font-normal whitespace-nowrap opacity-70">
                  {' '}
                  · {formatBytes(asset.size)}
                </span>
              ) : null}
            </span>
          </a>
        ) : (
          <a
            href="#download"
            className="inline-flex items-center gap-2 rounded-full bg-[#fefefe] px-5 py-2.5 text-[15px] font-medium text-[#010002] transition-opacity hover:opacity-90"
          >
            <MonitorDown className="size-4" aria-hidden="true" />
            See downloads
          </a>
        )}
        <a
          href="#releases"
          className="rounded-full border border-[#3a3a3a] px-5 py-2.5 text-[15px] text-[#dcdcdc] transition-opacity hover:opacity-80"
        >
          Browse all versions
        </a>
        <a
          href={WHATSAPP_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded-full border border-[#3a3a3a] px-5 py-2.5 text-[15px] text-[#dcdcdc] transition-opacity hover:opacity-80"
        >
          <MessagesSquare className="size-4" aria-hidden="true" />
          Join our WhatsApp community
        </a>
      </div>
      <dl className="mt-8 grid max-w-lg grid-cols-3 gap-3 border-t border-[#3a3a3a] pt-5">
        <div className="min-w-0">
          <dt className="text-[12px] tracking-wide text-[#6a6a6a] uppercase">Downloads</dt>
          <dd className="mt-1 text-[20px] leading-none font-medium tabular-nums">
            {pending ? '—' : formatCount(stats.totalDownloads)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[12px] tracking-wide text-[#6a6a6a] uppercase">Latest</dt>
          <dd className="mt-1 truncate text-[20px] leading-none font-medium tabular-nums">
            {pending ? '—' : (stats.latestTag ?? '—')}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[12px] tracking-wide text-[#6a6a6a] uppercase">Releases</dt>
          <dd className="mt-1 text-[20px] leading-none font-medium tabular-nums">
            {pending ? '—' : formatCount(stats.releaseCount)}
          </dd>
        </div>
      </dl>
      <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-[#6a6a6a]">
        <span>Free and open source (MIT / Apache-2.0)</span>
        <a href="#analytics" className="text-[#dcdcdc] underline underline-offset-4 hover:text-white">
          See download analytics
        </a>
      </p>
    </section>
  )
}

export default memo(Hero)
