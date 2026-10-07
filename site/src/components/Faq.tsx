import { memo } from 'react'

const FAQ = [
  {
    q: 'Does this site play music?',
    a: 'No. This site only describes Songnest and links downloads. Listening happens inside the desktop/mobile app after you install it.',
  },
  {
    q: 'Which download do I need?',
    a: 'macOS Apple Silicon (arm64) for M1+, macOS Intel (x64) for older Macs, Windows .msi/.exe, Linux .AppImage/.deb, Android .apk (experimental thin client over your local network).',
  },
  {
    q: 'Is there an iOS build?',
    a: 'iOS is best-effort and unsigned — only useful for local sideloading/testing. It is not signed for the App Store.',
  },
  {
    q: 'Is Songnest free?',
    a: 'Yes, MIT or Apache-2.0. It does not host or distribute music — you are responsible for complying with copyright law and any connected service terms.',
  },
]

function Faq() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-10" aria-labelledby="faq-heading">
      <h2 id="faq-heading" className="text-2xl font-medium tracking-tight">
        Questions
      </h2>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {FAQ.map((item) => (
          <article key={item.q} className="rounded-[15px] border border-[#3a3a3a] bg-[#232323] p-5">
            <h3 className="text-[15px] font-medium">{item.q}</h3>
            <p className="mt-1 text-[13px] leading-relaxed text-[#aeaeae]">{item.a}</p>
          </article>
        ))}
      </div>
      <div className="mt-4 rounded-[15px] border border-[#3a3a3a] bg-[#232323] p-5 text-[13px] leading-relaxed text-[#aeaeae]">
        <p className="font-medium text-[#fefefe]">Responsible use</p>
        <p className="mt-1">
          Songnest does not host, distribute, or provide any music. It is a player and library
          manager. Prefer sources with licenses that allow saving copies. Not affiliated with or
          endorsed by any streaming or video service.
        </p>
      </div>
    </section>
  )
}

export default memo(Faq)
