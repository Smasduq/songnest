import { Check, Monitor, Moon, Sun, Wrench, CircleUserRound, Palette } from "lucide-react";
import type { Theme } from "@/components/header";

const THEMES: { id: Theme; label: string; icon: typeof Sun }[] = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: Monitor },
];

function Section({ icon: Icon, title, children }: { icon: typeof Sun; title: string; children: React.ReactNode }) {
  return (
    <section>
      <p className="flex items-center gap-1.5 px-2 pb-2 text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {title}
      </p>
      {children}
    </section>
  );
}

export function SettingsPanel({
  theme,
  onPickTheme,
  accountEmail,
  onOpenAccount,
  onOpenDiagnostics,
}: {
  theme: Theme;
  onPickTheme: (t: Theme) => void;
  accountEmail: string | null;
  onOpenAccount: () => void;
  onOpenDiagnostics: () => void;
}) {
  return (
    <div className="space-y-5">
      <Section icon={Palette} title="Appearance">
        <div
          role="group"
          aria-label="Theme"
          className="grid grid-cols-3 gap-1 rounded-2xl bg-foreground/5 p-1"
        >
          {THEMES.map((o) => {
            const Icon = o.icon;
            const on = theme === o.id;
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => onPickTheme(o.id)}
                aria-pressed={on}
                className={`flex items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-xs font-medium transition-colors ${
                  on
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {o.label}
                {on && <Check className="h-3 w-3" aria-hidden />}
              </button>
            );
          })}
        </div>
      </Section>

      <Section icon={CircleUserRound} title="Account">
        <button
          type="button"
          onClick={onOpenAccount}
          className="flex w-full items-center gap-2.5 rounded-2xl bg-foreground/5 px-4 py-3 text-left text-sm text-foreground hover:text-foreground"
        >
          <CircleUserRound className="h-4 w-4 text-muted-foreground" aria-hidden />
          <span className="flex-1 truncate">
            {accountEmail ?? "Sign in / Sign up"}
          </span>
        </button>
      </Section>

      <button
        type="button"
        onClick={onOpenDiagnostics}
        className="flex w-full items-center gap-2.5 rounded-2xl bg-foreground/5 px-4 py-3 text-left text-sm text-muted-foreground hover:text-foreground"
      >
        <Wrench className="h-4 w-4" aria-hidden />
        Downloader diagnostics
      </button>
    </div>
  );
}
