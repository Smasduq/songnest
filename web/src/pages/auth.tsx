import { AuthComponent } from "@/components/ui/sign-up";

/**
 * Songnest sign-in / sign-up page.
 *
 * Props/data:
 * - No props required; renders full-screen. Pass `logo`/`brandName`
 *   through to AuthComponent when rebranding.
 * State:
 * - All form state (email -> password -> confirm) lives inside
 *   AuthComponent; this page is stateless apart from the optional
 *   back navigation.
 * Assets:
 * - Uses the existing `/songnest-logo.png` (public/) with the
 *   theme-adaptive `.logo-mark` class — no new images needed.
 * Responsive:
 * - AuthComponent is full-screen (min-h-screen w-screen) and centers
 *   a 280-300px column; works on mobile and desktop as-is.
 */

function SongnestLogo() {
  return (
    <img
      src="/songnest-logo.png"
      alt="Songnest"
      className="logo-mark h-8 w-8 rounded-full object-cover"
    />
  );
}

export default function AuthPage({ onBack }: { onBack?: () => void }) {
  return (
    <div className="relative">
      {onBack !== undefined && (
        <button
          type="button"
          onClick={onBack}
          className="fixed left-4 top-16 z-30 rounded-full border border-border/60 bg-background/80 px-3 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur hover:text-foreground md:top-4 md:left-auto md:right-4"
        >
          ← Back to app
        </button>
      )}
      <AuthComponent logo={<SongnestLogo />} brandName="Songnest" />
    </div>
  );
}
