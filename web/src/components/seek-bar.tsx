import { useRef, useState } from "react";

import { formatTime } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Seek bar with hover preview (fine pointers only — touch taps to seek).
 * Hovering ahead of progress shows a theme-aware preview segment plus the
 * hovered time in a pill. Instant show/hide, no animation.
 */
export function SeekBar({
  value,
  duration,
  onSeek,
  className,
  barClassName,
  fillClassName,
  noDrag,
}: {
  /** 0..1 playback progress */
  value: number;
  /** total seconds (tooltip + clamping) */
  duration: number;
  /** user committed to this 0..1 position */
  onSeek: (ratio: number) => void;
  className?: string;
  barClassName?: string;
  fillClassName?: string;
  /** skip drag-to-seek affordances (attribute passthrough) */
  noDrag?: boolean;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  function ratioOf(clientX: number): number {
    const bar = barRef.current;
    if (!bar) return 0;
    const rect = bar.getBoundingClientRect();
    if (rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }

  const ahead = hover !== null && duration > 0 && hover > value;
  // keep the time pill inside the bar edges
  const tipLeft = hover === null ? 0 : Math.min(92, Math.max(8, hover * 100));

  return (
    <div className={className}>
      <div
        ref={barRef}
        onClick={(e) => onSeek(ratioOf(e.clientX))}
        onMouseMove={(e) => setHover(ratioOf(e.clientX))}
        onMouseLeave={() => setHover(null)}
        data-no-dismiss-drag={noDrag || undefined}
        className={cn(
          "group/seek relative w-full cursor-pointer rounded-full bg-muted",
          barClassName
        )}
      >
        {/* played fill */}
        <div
          className={cn(
            "h-full rounded-full bg-gradient-to-r from-primary to-primary/40",
            fillClassName
          )}
          style={{ width: `${Math.min(1, Math.max(0, value)) * 100}%` }}
        />
        {/* hover-ahead preview: theme-aware light segment */}
        {ahead && (
          <div
            aria-hidden
            className="absolute inset-y-0 rounded-full bg-foreground/20"
            style={{
              left: `${value * 100}%`,
              width: `${(hover - value) * 100}%`,
            }}
          />
        )}
        {/* knob + time pill, hover only */}
        {hover !== null && duration > 0 && (
          <>
            <span
              aria-hidden
              className="absolute top-1/2 hidden size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground group-hover/seek:block"
              style={{ left: `${hover * 100}%` }}
            />
            <span
              aria-hidden
              className="absolute -top-7 hidden -translate-x-1/2 whitespace-nowrap rounded-full bg-foreground px-2 py-0.5 text-xs tabular-nums text-background group-hover/seek:block"
              style={{ left: `${tipLeft}%` }}
            >
              {formatTime(hover * duration)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
