import { REPO_URL } from '../lib/releases.ts'

export default function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-[#3a3a3a] bg-[#171717]/90 backdrop-blur">
      <div className="mx-auto flex h-15 max-w-6xl items-center justify-between px-4">
        <a href="#top" className="flex items-center gap-2" aria-label="Songnest home">
          <img
            src="/songnest-logo.png"
            alt="Songnest logo"
            width={32}
            height={32}
            className="size-8 rounded-[10px] object-cover"
          />
          <span className="text-[17px] font-semibold tracking-tight">Songnest</span>
          <span className="rounded-full border border-[#3a3a3a] px-2 py-0.5 text-[11px] text-[#aeaeae]">
            alpha
          </span>
        </a>
        <nav className="hidden items-center gap-5 text-[13px] text-[#aeaeae] md:flex" aria-label="Primary">
          <a className="transition-opacity hover:text-white hover:opacity-90" href="#features">
            Features
          </a>
          <a className="transition-opacity hover:text-white hover:opacity-90" href="#how-it-works">
            How it works
          </a>
          <a className="transition-opacity hover:text-white hover:opacity-90" href="#download">
            Download
          </a>
          <a className="transition-opacity hover:text-white hover:opacity-90" href="#releases">
            All releases
          </a>
        </nav>
        <div className="flex items-center gap-2">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded-full border border-[#3a3a3a] px-3 py-1.5 text-[13px] text-[#dcdcdc] transition-opacity hover:opacity-80"
          >
            GitHub
          </a>
          <a
            href="#download"
            className="rounded-full bg-[#fefefe] px-4 py-1.5 text-[13px] font-medium text-[#010002] transition-opacity hover:opacity-90"
          >
            Get the app
          </a>
        </div>
      </div>
    </header>
  )
}
