import { memo } from 'react'

const FAQ = [
  {
    q: 'Does this site play music?',
    a: 'Nope. This site just tells you about Songnest and links the download. You listen inside the app after installing it.',
  },
  {
    q: 'Which download do I need?',
    a: 'Mac with M1 or newer → arm64. Older Mac → x64. Windows → .msi or .exe. Linux → .AppImage or .deb. Android → .apk.',
  },
  {
    q: 'Is there an iOS build?',
    a: 'Not really. There's an unsigned build for sideloading/testing only — it's not on the App Store.',
  },
  {
    q: 'Is Songnest free?',
    a: 'Yes, 100% free and open source. Songnest doesn't host or distribute music — you're responsible for what you play.',
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
          Songnest doesn't host or distribute any music — it's just a player. Use sources you're
          actually allowed to use. Not affiliated with any streaming service.
        </p>
      </div>
    </section>
  )
}

export default memo(Faq)
