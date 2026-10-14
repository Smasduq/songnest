import { useEffect } from "react";
import { motion } from "framer-motion";

import { SettingsPanel } from "@/components/settings-panel";
import type { Theme } from "@/components/header";
import { Button } from "@/components/ui/button";
import { ChevronLeft } from "lucide-react";

export function SettingsSheet({
  onClose,
  theme,
  onPickTheme,
  onOpenAccount,
  onOpenDiagnostics,
  onOpenUpdates,
}: {
  onClose: () => void;
  theme: Theme;
  onPickTheme: (t: Theme) => void;
  onOpenAccount: () => void;
  onOpenDiagnostics: () => void;
  onOpenUpdates: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

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
        aria-modal="true"
        aria-label="Settings"
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ duration: 0.28, ease: [0.22, 0.61, 0.36, 1] }}
        className="fixed inset-0 z-[90] flex flex-col overflow-hidden bg-background"
      >
        <div className="relative z-10 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-[calc(env(safe-area-inset-top)+0.5rem)]">
          <div className="flex min-h-11 items-center justify-between">
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label="Close settings"
              className="h-11 w-11 rounded-full text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="h-5 w-5" />
            </Button>
            <p className="text-xs font-medium uppercase tracking-[0.25em] text-muted-foreground">
              Settings
            </p>
            <span className="w-11" />
          </div>

          <SettingsPanel
            theme={theme}
            onPickTheme={onPickTheme}
            showProfileLabel
            onOpenAccount={() => {
              onOpenAccount();
              onClose();
            }}
            onOpenDiagnostics={() => {
              onOpenDiagnostics();
              onClose();
            }}
            onOpenUpdates={() => {
              onOpenUpdates();
              onClose();
            }}
          />
        </div>
      </motion.section>
    </>
  );
}
