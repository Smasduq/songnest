const LAST_UPDATED = 'October 14, 2026'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold text-[#f5f5f4]">{title}</h2>
      <div className="mt-2 space-y-3 text-[15px] leading-relaxed text-[#b5b5b5]">{children}</div>
    </section>
  )
}

export default function Terms() {
  return (
    <article className="mx-auto max-w-3xl px-4 py-12">
      <a href="#top" className="text-sm text-[#8a8a8a] hover:text-white">
        ← Back to home
      </a>
      <h1 className="mt-4 text-3xl font-bold text-[#f5f5f4]">Terms of Service</h1>
      <p className="mt-2 text-sm text-[#6a6a6a]">Last updated: {LAST_UPDATED}</p>
      <p className="mt-4 text-[15px] leading-relaxed text-[#b5b5b5]">
        These terms cover the Songnest apps and the optional account (sign-in and liked-song sync).
        By creating an account or using sync, you agree to them.
      </p>

      <Section title="It's a work in progress">
        <p>
          Songnest is still being actively developed — things might change between versions. It's
          provided as-is, with no guarantees. The app is open source under MIT / Apache-2.0.
        </p>
      </Section>

      <Section title="Your account">
        <ul className="list-disc space-y-1 pl-5">
          <li>Use a real email address and keep your password private.</li>
          <li>You're responsible for what happens under your account — let us know if it gets compromised.</li>
          <li>One account per person, personal use only.</li>
        </ul>
      </Section>

      <Section title="Don't be a jerk">
        <ul className="list-disc space-y-1 pl-5">
          <li>Don't attack or abuse the API — rate limits are enforced.</li>
          <li>Don't use the service for anything illegal.</li>
          <li>Don't pretend to be someone else or upload a photo you don't have the right to use.</li>
        </ul>
      </Section>

      <Section title="Music and copyright">
        <p>
          Songnest doesn't host or distribute any music — it's a player for files and sources you
          supply. You're responsible for making sure you're allowed to use whatever you're
          accessing. We may remove synced metadata that infringes on copyright.
        </p>
      </Section>

      <Section title="Changes and shutdowns">
        <p>
          Features (including sync and social login) may change or go away as the app evolves. We
          can suspend accounts that break these rules. You can stop using the service anytime by
          signing out. Account deletion is handled as described in the Privacy Policy.
        </p>
      </Section>

      <Section title="Liability">
        <p>
          To the extent allowed by law, Songnest isn't liable for any lost data or damages —
          including your music library. Back up anything important yourself.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Questions about these terms? Contact the maintainer privately through the channel in the
          repository's SECURITY.md.
        </p>
      </Section>
    </article>
  )
}
