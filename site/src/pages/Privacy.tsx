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
        Songnest is a desktop-first music library and player with an optional
        hosted account for signing in and syncing liked songs across devices.
        This policy explains what data the app and this site handle, and what
        stays on your device.
      </p>

      <Section title="Data that stays on your device">
        <p>
          Your music files, downloads, library database, playback history, and
          app settings live on your own device. Songnest does not host,
          distribute, or provide any music, and our servers never see your
          audio files, streams, or downloads.
        </p>
      </Section>

      <Section title="Account data (only if you sign in)">
        <p>The app works fully without an account. If you create one, we store:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Your email address and a salted Argon2id hash of your password — never the password itself.</li>
          <li>
            If you sign in with GitHub or Google: the provider account identifier
            and email needed to link your Songnest account. We never see your
            provider password.
          </li>
          <li>Your profile display name and profile photo, if you set them.</li>
          <li>
            Your liked songs (track identifiers, like/unlike timestamps, and the
            titles/artists you see), synced so every device shows the same library.
          </li>
        </ul>
      </Section>

      <Section title="How sign-in sessions work">
        <p>
          Short-lived access tokens (15 minutes) and rotating refresh tokens
          (30 days) keep you signed in. Tokens live in your operating system's
          credential store (with a browser-storage fallback in web development).
          Signing out revokes the refresh token.
        </p>
      </Section>

      <Section title="Where account data lives">
        <p>
          Account data is stored with Neon (Postgres database plus object storage
          for profile photos) in the AWS US East region, and served through our
          API hosted on Vercel. Data in transit is always encrypted with TLS.
        </p>
      </Section>

      <Section title="What we don't do">
        <ul className="list-disc space-y-1 pl-5">
          <li>No advertising, analytics beacons, or cross-site trackers in the app or on this site.</li>
          <li>We don't sell personal data or share it with third parties, except the infrastructure above that stores and serves it.</li>
          <li>This static site only fetches public release metadata from the GitHub API to show downloads.</li>
        </ul>
      </Section>

      <Section title="Your choices">
        <p>
          You can change your display name, email, and photo, or remove your
          photo, at any time in the app's profile page. Signing out stops all
          syncing. There is no self-serve delete-account button yet — to have
          your account data deleted, contact the maintainer privately through
          the channel listed in the repository's SECURITY.md and it will be
          removed, including the profile photo.
        </p>
      </Section>

      <Section title="Children">
        <p>
          Songnest is not directed at children under 13, and we do not knowingly
          collect their data. If you believe a child has created an account,
          contact us and we will delete it.
        </p>
      </Section>

      <Section title="Changes">
        <p>
          If this policy changes materially, the new version will be posted here
          with a new date. Continued use of an account after changes means you
          accept them.
        </p>
      </Section>
    </article>
  )
}
