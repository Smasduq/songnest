import { memo } from 'react'
import { REPO_URL } from '../lib/releases.ts'

function SiteFooter() {
  return (
    <footer className="border-t border-[#3a3a3a]">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-[13px] text-[#6a6a6a] md:flex-row md:items-center md:justify-between">
        <p>Songnest — desktop-first music library and player. MIT / Apache-2.0.</p>
        <nav className="flex gap-4" aria-label="Footer">
          <a className="hover:text-white" href={REPO_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a className="hover:text-white" href={`${REPO_URL}/releases`} target="_blank" rel="noreferrer">
            Releases
          </a>
          <a className="hover:text-white" href={`${REPO_URL}/blob/main/SECURITY.md`} target="_blank" rel="noreferrer">
            Security
          </a>
        </nav>
      </div>
    </footer>
  )
}

export default memo(SiteFooter)
