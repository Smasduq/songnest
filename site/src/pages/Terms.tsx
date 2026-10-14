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
        These terms cover the Songnest apps and the optional hosted account
        (sign-in and liked-song sync). By creating an account or using sync,
        you agree to them.
      </p>

      <Section title="Early alpha, as-is">
        <p>
          Songnest is early alpha software: expect rough edges and breaking
          changes. It is provided as-is, without warranties of any kind. The
          app itself is open source under MIT / Apache-2.0.
        </p>
      </Section>

      <Section title="Your account">
        <ul className="list-disc space-y-1 pl-5">
          <li>Provide a valid email address and keep your credentials confidential.</li>
          <li>You are responsible for activity under your account — tell us if it is compromised.</li>
          <li>One account per person for personal use.</li>
        </ul>
      </Section>

      <Section title="Acceptable use">
        <ul className="list-disc space-y-1 pl-5">
          <li>Don't attack, probe, or abuse the API (rate limits are enforced).</li>
          <li>Don't use the service for anything unlawful.</li>
          <li>
            Don't misrepresent yourself or upload a profile photo you have no
            right to use.
          </li>
        </ul>
      </Section>

      <Section title="Music and copyright">
        <p>
          Songnest does not host, distribute, or provide any music — it is a
          player and library manager for files and sources you supply. You are
          solely responsible for complying with copyright law and the terms of
          any service you connect, and we may remove synced metadata that
          infringes.
        </p>
      </Section>

      <Section title="Changes and termination">
        <p>
          Features (including sync and social login) may change or be withdrawn
          as the alpha evolves. We may suspend accounts that breach these terms.
          You can stop using the service at any time by signing out; account
          deletion is handled as described in the Privacy Policy.
        </p>
      </Section>

      <Section title="Liability">
        <p>
          To the maximum extent permitted by law, Songnest is not liable for
          indirect, incidental, or consequential damages, including loss of
          library data — keep your own backups of anything important.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Questions about these terms: contact the maintainer privately through
          the channel listed in the repository's SECURITY.md.
        </p>
      </Section>
    </article>
  )
}
