import { useEffect } from "react";
import { motion, useDragControls } from "framer-motion";

import { SettingsPanel } from "@/components/settings-panel";
import type { Theme } from "@/components/header";
import { Button } from "@/components/ui/button";
import { ChevronDown } from "lucide-react";

export function SettingsSheet({
  onClose,
  theme,
  onPickTheme,
  accountEmail,
  onOpenAccount,
  onOpenDiagnostics,
}: {
  onClose: () => void;
  theme: Theme;
  onPickTheme: (t: Theme) => void;
  accountEmail: string | null;
  onOpenAccount: () => void;
  onOpenDiagnostics: () => void;
}) {
  const controls = useDragControls();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function maybeStartDismiss(e: React.PointerEvent) {
    const t = e.target as HTMLElement | null;
    if (t !== null && t.closest("button, input, a, [data-no-dismiss-drag]") !== null) return;
    controls.start(e);
  }

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={onClose}
        className="fixed inset-0 z-[80] bg-background/60 backdrop-blur-sm"
      />
      <motion.section
        data-testid="settings-sheet"
        role="dialog"
        aria-label="Settings"
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", stiffness: 400, damping: 35 }}
        drag="y"
        dragListener={false}
        dragControls={controls}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={0.3}
        onDragEnd={(_, info) => {
          if (info.offset.y > 80 || info.velocity.y > 600) onClose();
        }}
        onPointerDown={maybeStartDismiss}
        className="fixed inset-x-0 bottom-0 top-16 z-[90] flex flex-col overflow-hidden rounded-t-3xl border border-border/40 bg-background/80 backdrop-blur-2xl"
      >
        <div className="relative z-10 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]">
          <div className="flex cursor-grab touch-none justify-center pb-1 pt-3 active:cursor-grabbing">
            <span className="h-1.5 w-12 rounded-full bg-muted" />
          </div>

          <div className="flex touch-none select-none items-center justify-between">
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label="Close settings"
              className="h-9 w-9 rounded-full text-muted-foreground hover:text-foreground"
            >
              <ChevronDown className="h-5 w-5" />
            </Button>
            <p className="text-xs font-medium uppercase tracking-[0.25em] text-muted-foreground">
              Settings
            </p>
            <span className="w-9" />
          </div>

          <SettingsPanel
            theme={theme}
            onPickTheme={onPickTheme}
            accountEmail={accountEmail}
            onOpenAccount={() => {
              onOpenAccount();
              onClose();
            }}
            onOpenDiagnostics={() => {
              onOpenDiagnostics();
              onClose();
            }}
          />
        </div>
      </motion.section>
    </>
  );
}
