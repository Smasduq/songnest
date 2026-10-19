import { memo } from 'react'
import { REPO_URL, WHATSAPP_URL } from '../lib/releases.ts'

function SiteFooter() {
  return (
    <footer className="border-t border-[#3a3a3a]">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-[13px] text-[#6a6a6a] md:flex-row md:flex-wrap md:items-center md:justify-between">
        <p>Songnest — desktop-first music library and player. MIT / Apache-2.0.</p>
        <nav className="flex flex-wrap gap-4" aria-label="Footer">
          <a className="hover:text-white" href={WHATSAPP_URL} target="_blank" rel="noreferrer">
            WhatsApp community
          </a>
          <a className="hover:text-white" href={REPO_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a className="hover:text-white" href={`${REPO_URL}/releases`} target="_blank" rel="noreferrer">
            Releases
          </a>
          <a className="hover:text-white" href={`${REPO_URL}/blob/main/SECURITY.md`} target="_blank" rel="noreferrer">
            Security
          </a>
          <a className="hover:text-white" href="#privacy">
            Privacy
          </a>
          <a className="hover:text-white" href="#terms">
            Terms
          </a>
        </nav>
        <nav className="flex flex-wrap gap-4" aria-label="Other projects by Smasduq">
          <a className="hover:text-white" href="https://smasduq.xyz">
            Smasduq.xyz — software developer &amp; founder
          </a>
          <a className="hover:text-white" href="https://link.smasduq.xyz">
            LinkBio — link-in-bio pages
          </a>
          <a className="hover:text-white" href="https://ani-pull.smasduq.xyz">
            Ani-pull — terminal anime downloader
          </a>
        </nav>
      </div>
    </footer>
  )
}

export default memo(SiteFooter)
