import { memo } from 'react'
import { ArrowDownToLine, MonitorDown, TriangleAlert } from 'lucide-react'
import {
  detectPlatform,
  formatBytes,
  pickAssetForPlatform,
  type Release,
} from '../lib/releases.ts'

interface Props {
  latest: Release | null
  loading: boolean
}

function Hero({ latest, loading }: Props) {
  const platform = detectPlatform()
  const asset = latest ? pickAssetForPlatform(latest.assets, platform) : null

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
        Early alpha — expect breaking changes
      </p>
      <h1
        id="hero-heading"
        className="max-w-3xl text-[41px] leading-[1.05] font-medium tracking-tight text-balance"
      >
        Your music library, on your desktop.
      </h1>
      <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-[#aeaeae] text-pretty">
        Songnest is a desktop-first music library and player with a pluggable source system, built
        with Tauri, Rust, and React. Search metadata, keep a local library, and play saved tracks —
        no web account, no subscription. This site only describes the app and links downloads.
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        {loading ? (
          <div className="h-11 w-56 animate-pulse rounded-full bg-[#262626]" aria-label="Loading download" />
        ) : asset ? (
          <a
            href={asset.browser_download_url}
            className="inline-flex items-center gap-2 rounded-full bg-[#fefefe] px-5 py-2.5 text-[15px] font-medium text-[#010002] transition-opacity hover:opacity-90"
          >
            <ArrowDownToLine className="size-4" aria-hidden="true" />
            Download {latest?.tag_name} for your device
            {asset.size > 0 ? <span className="font-normal opacity-70">· {formatBytes(asset.size)}</span> : null}
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
      </div>
      <p className="mt-3 text-[13px] text-[#6a6a6a]">
        {latest
          ? `Latest: ${latest.tag_name}${latest.prerelease ? ' (pre-release)' : ''} · Free and open source (MIT / Apache-2.0)`
          : 'Free and open source (MIT / Apache-2.0)'}
      </p>
    </section>
  )
}

export default memo(Hero)
