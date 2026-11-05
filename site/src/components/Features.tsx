import { memo } from 'react'
import { Activity, Heart, ListMusic, MonitorSmartphone, Play, ShieldCheck } from 'lucide-react'

const FEATURES = [
  {
    icon: ListMusic,
    title: 'Search any song',
    body: 'Find tracks and get suggestions. Like songs to build your own library.',
  },
  {
    icon: Play,
    title: 'Play your music',
    body: 'Play songs you've saved. Songs you haven't saved yet stream automatically.',
  },
  {
    icon: Heart,
    title: 'Download queue',
    body: 'Saves up to 2 songs at a time, with progress and automatic retries.',
  },
  {
    icon: Activity,
    title: 'Health check screen',
    body: 'See if everything is running fine — versions, status, and cooldown timers all in one place.',
  },
  {
    icon: MonitorSmartphone,
    title: 'PC and Android',
    body: 'Full desktop app on Windows, Mac, and Linux. Android works as a connected client.',
  },
  {
    icon: ShieldCheck,
    title: 'Your files, your device',
    body: 'Everything stays on your machine. Nothing is uploaded. You're in control.',
  },
]

function Features() {
  return (
    <section id="features" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-10" aria-labelledby="features-heading">
      <h2 id="features-heading" className="text-2xl font-medium tracking-tight">
        What Songnest does
      </h2>
      <p className="mt-2 max-w-2xl text-[15px] text-[#aeaeae]">
        All of this works right now. Local file import and volume normalization are coming soon.
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
