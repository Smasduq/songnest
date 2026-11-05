const LAST_UPDATED = 'October 14, 2026'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold text-[#f5f5f4]">{title}</h2>
      <div className="mt-2 space-y-3 text-[15px] leading-relaxed text-[#b5b5b5]">{children}</div>
    </section>
  )
}

export default function Privacy() {
  return (
    <article className="mx-auto max-w-3xl px-4 py-12">
      <a href="#top" className="text-sm text-[#8a8a8a] hover:text-white">
        ← Back to home
      </a>
      <h1 className="mt-4 text-3xl font-bold text-[#f5f5f4]">Privacy Policy</h1>
      <p className="mt-2 text-sm text-[#6a6a6a]">Last updated: {LAST_UPDATED}</p>
      <p className="mt-4 text-[15px] leading-relaxed text-[#b5b5b5]">
        Songnest is a music player and library app. You can optionally create an account to sync
        your liked songs across devices. Here's what we do (and don't do) with your data.
      </p>

      <Section title="What stays on your device">
        <p>
          Your music files, downloads, and app settings all live on your own device.
          We never see your audio files, downloads, or streams. Ever.
        </p>
      </Section>

      <Section title="If you create an account">
        <p>You don't need an account. But if you make one, we store:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Your email address and a secure hash of your password — never the password itself.</li>
          <li>
            If you sign in with GitHub or Google: just your account ID and email to link your
            Songnest account. We never see your passwords from those services.
          </li>
          <li>Your display name and profile photo, if you set them.</li>
          <li>
            Your liked songs (track IDs, like/unlike timestamps, titles, and artists) so every
            device shows the same library.
          </li>
        </ul>
      </Section>

      <Section title="How sign-in works">
        <p>
          You get a short-lived login token (15 min) and a rotating session token (30 days) that
          keep you signed in. They're stored in your OS's secure credential store. Signing out
          wipes the session token.
        </p>
      </Section>

      <Section title="Where your account data lives">
        <p>
          Account data is stored in a Postgres database and object storage (for profile photos) in
          the AWS US East region, served through our API on Vercel. Everything in transit is
          encrypted with TLS.
        </p>
      </Section>

      <Section title="What we don't do">
        <ul className="list-disc space-y-1 pl-5">
          <li>No ads, no trackers, no analytics beacons — in the app or on this site.</li>
          <li>We don't sell your data or share it with anyone except the infrastructure above.</li>
          <li>This site only fetches public release data from GitHub to show download links.</li>
        </ul>
      </Section>

      <Section title="Your choices">
        <p>
          You can update your name, email, and photo anytime in the app's profile page. Signing
          out stops syncing. There's no self-serve delete button yet — to delete your account,
          contact the maintainer privately via SECURITY.md and it'll be gone.
        </p>
      </Section>

      <Section title="Kids">
        <p>
          Songnest isn't for kids under 13. If you think a child made an account, contact us and
          we'll delete it.
        </p>
      </Section>

      <Section title="Changes">
        <p>
          If this policy changes in a meaningful way, the new version will be posted here with a
          new date. Keeping your account after a change means you're okay with it.
        </p>
      </Section>
    </article>
  )
}
