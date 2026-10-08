import type { ReactNode } from "react";
import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const PARTICLE_COUNT = 12;

interface Particle {
  x: number;
  y: number;
  size: number;
  delay: number;
}

interface Burst {
  id: number;
  particles: Particle[];
}

function makeBurst(id: number): Burst {
  return {
    id,
    particles: Array.from({ length: PARTICLE_COUNT }, (_, i) => {
      const angle = (i / PARTICLE_COUNT) * Math.PI * 2 + Math.random() * 0.5;
      const dist = 26 + Math.random() * 24;
      return {
        x: Math.cos(angle) * dist,
        y: Math.sin(angle) * dist,
        size: 3 + Math.random() * 3,
        delay: Math.random() * 0.06,
      };
    }),
  };
}

interface Props {
  /** ghost icon (mobile sheet) or outline pill (desktop sidebar) */
  layout: "icon" | "pill";
  /** accessible name when idle */
  label: string;
  /** accessible name while busy */
  busyLabel?: string;
  /** spinner state (download in flight) */
  busy?: boolean;
  /** toggle state (liked) — also drives aria-pressed */
  pressed?: boolean;
  disabled?: boolean;
  onAction: () => void;
  idleIcon: ReactNode;
  /** pill text when idle */
  text?: string;
  /** pill text while busy */
  busyText?: string;
  iconClassName?: string;
  /** particle + ring color, e.g. "bg-primary" / "bg-rose-500" */
  particleClassName?: string;
  ringClassName?: string;
  /** "always" celebrates every tap; "activate" only when turning on */
  burstOn?: "always" | "activate";
  className?: string;
}

/** Action button with a tap punch, icon pop, and particle burst.
 *  Particles animate transform/opacity only and are skipped entirely
 *  under prefers-reduced-motion. */
export function BurstButton({
  layout,
  label,
  busyLabel,
  busy,
  pressed,
  disabled,
  onAction,
  idleIcon,
  text,
  busyText,
  iconClassName,
  particleClassName,
  ringClassName,
  burstOn,
  className,
}: Props) {
  const reduceMotion = useReducedMotion();
  const [bursts, setBursts] = useState<Burst[]>([]);
  const [punches, setPunches] = useState(0);
  const blocked = disabled === true || busy;

  function handleClick() {
    if (blocked) return;
    const celebrate = burstOn !== "activate" || pressed !== true;
    if (!reduceMotion && celebrate) {
      const id = Date.now() + Math.random();
      setBursts((b) => [...b, makeBurst(id)]);
      setPunches((p) => p + 1);
    }
    onAction();
  }

  function dismissBurst(id: number) {
    setBursts((b) => b.filter((x) => x.id !== id));
  }

  const particle = particleClassName ?? "bg-primary";
  const ring = ringClassName ?? "border-primary";

  return (
    <motion.span
      whileTap={reduceMotion ? undefined : { scale: 0.82 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      className="relative inline-flex flex-shrink-0"
    >
      {layout === "icon" ? (
        <Button
          variant="ghost"
          size="icon"
          disabled={blocked}
          onClick={handleClick}
          aria-pressed={pressed}
          aria-label={busy ? (busyLabel ?? label) : label}
          className={cn(
            "h-11 w-11 rounded-full text-muted-foreground hover:text-foreground",
            className
          )}
        >
          <motion.span
            key={punches}
            initial={punches > 0 ? { scale: 0.5 } : false}
            animate={{ scale: 1 }}
            transition={{ type: "spring", stiffness: 600, damping: 20 }}
            className="inline-flex"
          >
            {busy ? (
              <Loader2 className={cn("animate-spin", iconClassName ?? "h-5 w-5")} aria-hidden />
            ) : (
              idleIcon
            )}
          </motion.span>
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          disabled={blocked}
          onClick={handleClick}
          aria-pressed={pressed}
          aria-label={busy ? (busyLabel ?? label) : label}
          className={cn("h-9 flex-1 rounded-full", className)}
        >
          <motion.span
            key={punches}
            initial={punches > 0 ? { scale: 0.5 } : false}
            animate={{ scale: 1 }}
            transition={{ type: "spring", stiffness: 600, damping: 20 }}
            className="inline-flex items-center gap-2"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              idleIcon
            )}
            {busy ? (busyText ?? text) : text}
          </motion.span>
        </Button>
      )}
      <AnimatePresence>
        {bursts.map((burst) => (
          <span
            key={burst.id}
            aria-hidden
            className="pointer-events-none absolute inset-0 z-10"
          >
            {/* expanding ring */}
            <motion.span
              initial={{ scale: 0.4, opacity: 0.7 }}
              animate={{ scale: 1.6, opacity: 0 }}
              transition={{ duration: 0.5, ease: "easeOut" }}
              onAnimationComplete={() => dismissBurst(burst.id)}
              style={{ left: "calc(50% - 20px)", top: "calc(50% - 20px)" }}
              className={cn("absolute block h-10 w-10 rounded-full border-2", ring)}
            />
            {burst.particles.map((p, i) => (
              <motion.span
                key={i}
                initial={{ x: 0, y: 0, scale: 1, opacity: 1 }}
                animate={{ x: p.x, y: p.y, scale: 0.2, opacity: 0 }}
                transition={{ duration: 0.65, ease: "easeOut", delay: p.delay }}
                style={{
                  width: p.size,
                  height: p.size,
                  left: "50%",
                  top: "50%",
                  marginLeft: -p.size / 2,
                  marginTop: -p.size / 2,
                }}
                className={cn("absolute block rounded-full", particle)}
              />
            ))}
          </span>
        ))}
      </AnimatePresence>
    </motion.span>
  );
}
