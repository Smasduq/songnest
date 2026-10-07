import { memo } from 'react'
import { Activity, Heart, ListMusic, MonitorSmartphone, Play, ShieldCheck } from 'lucide-react'

const FEATURES = [
  {
    icon: ListMusic,
    title: 'Metadata search + suggestions',
    body: 'Find tracks in the public catalog and grow a local library with likes.',
  },
  {
    icon: Play,
    title: 'Saved-track playback',
    body: 'Play tagged audio files stored in your data directory. Unsaved tracks stream via proxy.',
  },
  {
    icon: Heart,
    title: 'Save-to-library queue',
    body: 'Paced queue (max 2 at a time) with progress, retries, and rate-limit handling.',
  },
  {
    icon: Activity,
    title: 'Source health + diagnostics',
    body: 'Backend versions, update status, and cooldown state on one screen.',
  },
  {
    icon: MonitorSmartphone,
    title: 'Desktop app, mobile experimental',
    body: 'Tauri desktop spawns and manages the backend. Android is a thin client over LAN.',
  },
  {
    icon: ShieldCheck,
    title: 'You own your files',
    body: 'Local SQLite library. Optional yt-dlp is yours to install — never bundled.',
  },
]

function Features() {
  return (
    <section id="features" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-10" aria-labelledby="features-heading">
      <h2 id="features-heading" className="text-2xl font-medium tracking-tight">
        What Songnest does
      </h2>
      <p className="mt-2 max-w-2xl text-[15px] text-[#aeaeae]">
        What works today in alpha. Local-file import and loudness normalization are planned.
      </p>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <article key={f.title} className="rounded-[15px] border border-[#3a3a3a] bg-[#232323] p-5">
            <f.icon className="size-5 text-[#fefefe]" aria-hidden="true" />
            <h3 className="mt-3 text-[17px] font-medium">{f.title}</h3>
            <p className="mt-1 text-[13px] leading-relaxed text-[#aeaeae]">{f.body}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

export default memo(Features)
