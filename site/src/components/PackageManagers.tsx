import { memo } from 'react'
import { Terminal } from 'lucide-react'

const MANAGERS: { title: string; hint: string; commands: string[] }[] = [
  {
    title: 'Debian / Ubuntu',
    hint: 'apt repo, all versions kept',
    commands: [
      'echo "deb [trusted=yes] https://raw.githubusercontent.com/Smasduq/songnest/pkg stable main" | sudo tee /etc/apt/sources.list.d/songnest.list',
      'sudo apt update && sudo apt install songnest',
    ],
  },
  {
    title: 'Fedora / RHEL',
    hint: 'dnf repo, all versions kept',
    commands: [
      'sudo dnf config-manager --add-repo https://raw.githubusercontent.com/Smasduq/songnest/pkg/songnest.repo',
      'sudo dnf install songnest',
    ],
  },
  {
    title: 'Arch Linux',
    hint: 'AUR binary package',
    commands: ['yay -S songnest-bin'],
  },
  {
    title: 'Rust',
    hint: 'crates.io backend binary',
    commands: ['cargo install songnest-cli'],
  },
]

function PackageManagers() {
  return (
    <section id="install" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-10" aria-labelledby="pm-heading">
      <h2 id="pm-heading" className="flex items-center gap-2 text-2xl font-medium tracking-tight">
        <Terminal className="size-6" aria-hidden="true" />
        Install with a package manager
      </h2>
      <p className="mt-2 max-w-2xl text-[15px] text-[#aeaeae]">
        Prefer the terminal? Every published version stays installable — pin any version, e.g.{' '}
        <code className="rounded bg-[#262626] px-1.5 py-0.5 text-[13px] text-[#fefefe]">
          sudo apt install songnest=0.1.0-alpha.1
        </code>
      </p>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {MANAGERS.map((m) => (
          <article key={m.title} className="rounded-[15px] border border-[#3a3a3a] bg-[#232323] p-5">
            <h3 className="text-[15px] font-medium">{m.title}</h3>
            <p className="mt-0.5 text-[13px] text-[#6a6a6a]">{m.hint}</p>
            <div className="mt-3 space-y-2">
              {m.commands.map((c) => (
                <pre
                  key={c}
                  className="overflow-x-auto rounded-[10px] bg-[#010002] p-3 text-[13px] leading-relaxed text-[#dcdcdc] tabular-nums"
                >
                  <code>{c}</code>
                </pre>
              ))}
            </div>
          </article>
        ))}
      </div>
      <p className="mt-3 text-[13px] text-[#6a6a6a]">
        Repos rebuild automatically from each release. Signing key + details in{' '}
        <code className="rounded bg-[#262626] px-1.5 py-0.5 text-[#fefefe]">pkg/README.md</code>.
      </p>
    </section>
  )
}

export default memo(PackageManagers)
