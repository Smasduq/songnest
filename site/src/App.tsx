import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import SiteHeader from './components/SiteHeader.tsx'
import Hero from './components/Hero.tsx'
import Features from './components/Features.tsx'
import HowItWorks from './components/HowItWorks.tsx'
import DownloadLatest from './components/DownloadLatest.tsx'
import Faq from './components/Faq.tsx'
import SiteFooter from './components/SiteFooter.tsx'
import { fetchReleases, type Release } from './lib/releases.ts'

const ReleaseList = lazy(() => import('./components/ReleaseList.tsx'))

export default function App() {
  const [releases, setReleases] = useState<Release[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let mounted = true
    fetchReleases(controller.signal)
      .then((data) => {
        if (mounted) {
          setReleases(data)
          setLoading(false)
        }
      })
      .catch((err: unknown) => {
        if (mounted && !controller.signal.aborted) {
          setError(err instanceof Error ? err.message : 'Failed to load releases')
          setLoading(false)
        }
      })
    return () => {
      mounted = false
      controller.abort()
    }
  }, [])

  const latest = useMemo(() => releases[0] ?? null, [releases])

  return (
    <div id="top" className="min-h-dvh bg-[#171717] text-[#f5f5f4]">
      <SiteHeader />
      <main>
        <Hero latest={latest} loading={loading} />
        <Features />
        <HowItWorks />
        <DownloadLatest latest={latest} loading={loading} error={error} />
        <Suspense
          fallback={
            <div className="mx-auto max-w-6xl px-4 py-10" aria-label="Loading releases section">
              <div className="h-44 animate-pulse rounded-[15px] bg-[#262626]" />
            </div>
          }
        >
          <ReleaseList releases={releases} loading={loading} error={error} />
        </Suspense>
        <Faq />
      </main>
      <SiteFooter />
    </div>
  )
}
