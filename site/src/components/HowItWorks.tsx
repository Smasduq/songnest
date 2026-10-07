import { memo } from 'react'

const STEPS = [
  {
    title: '1. Catalog metadata',
    body: 'Track metadata comes from a public catalog API — no hosting of music by Songnest.',
  },
  {
    title: '2. Pluggable sources',
    body: 'A source layer matches catalog entries to playable audio, caching matches and stream URLs.',
  },
  {
    title: '3. Local library',
    body: 'Saved tracks live as tagged audio files plus a local SQLite library. The UI talks to a local server over HTTP.',
  },
]

function HowItWorks() {
  return (
    <section
      id="how-it-works"
      className="mx-auto max-w-6xl scroll-mt-20 px-4 py-10"
      aria-labelledby="how-heading"
    >
      <h2 id="how-heading" className="text-2xl font-medium tracking-tight">
        How it works
      </h2>
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {STEPS.map((s) => (
          <article key={s.title} className="rounded-[15px] border border-[#3a3a3a] bg-[#232323] p-5">
            <h3 className="text-[17px] font-medium">{s.title}</h3>
            <p className="mt-1 text-[13px] leading-relaxed text-[#aeaeae]">{s.body}</p>
          </article>
        ))}
      </div>
      <figure className="mt-6 overflow-hidden rounded-[15px] border border-[#3a3a3a]">
        <img
          src="/screenshot-library.png"
          alt="Songnest desktop library view prototype"
          loading="lazy"
          className="h-auto w-full"
          width={1920}
          height={1080}
        />
        <figcaption className="bg-[#232323] px-4 py-2 text-[13px] text-[#6a6a6a]">
          Current prototype — desktop library view.
        </figcaption>
      </figure>
    </section>
  )
}

export default memo(HowItWorks)
