import { useEffect, useRef, useState } from "react";

import { formatTime } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Seek bar with hover preview (fine pointers) and drag-to-seek
 * (touch + mouse). Dragging shows a ghost at the drag position and
 * commits on release; taps seek instantly. No animation.
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
  const [dragPos, setDragPos] = useState<number | null>(null);
  const dragging = useRef(false);
  // Hover preview is mouse-only: taps on touch fire mouse events too and
  // would leave the tooltip stuck. Gate hover behind fine pointers.
  const [fine, setFine] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(pointer: fine)");
    setFine(mq.matches);
    const fn = (e: MediaQueryListEvent) => {
      setFine(e.matches);
      if (!e.matches) setHover(null);
    };
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);

  function ratioOf(clientX: number): number {
    const bar = barRef.current;
    if (!bar) return 0;
    const rect = bar.getBoundingClientRect();
    if (rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }

  const shown = dragPos ?? Math.min(1, Math.max(0, value));
  const ahead = fine && dragging.current === false && hover !== null && duration > 0 && hover > value;
  // keep the time pill inside the bar edges
  const tipAt = dragPos ?? hover;
  const tipLeft = tipAt === null ? 0 : Math.min(92, Math.max(8, tipAt * 100));
  const showTip = duration > 0 && (dragPos !== null || (fine && hover !== null));

  function beginDrag(e: React.PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragPos(ratioOf(e.clientX));
  }

  function moveDrag(e: React.PointerEvent) {
    if (!dragging.current) {
      if (fine) setHover(ratioOf(e.clientX));
      return;
    }
    setDragPos(ratioOf(e.clientX));
  }

  function endDrag(commit: boolean) {
    if (!dragging.current) return;
    dragging.current = false;
    if (commit && dragPos !== null) onSeek(dragPos);
    setDragPos(null);
  }

  return (
    <div className={className}>
      <div
        ref={barRef}
        onClick={(e) => {
          // taps (no real drag) seek instantly; drags commit on release
          if (dragPos === null) onSeek(ratioOf(e.clientX));
        }}
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={() => endDrag(true)}
        onPointerCancel={() => endDrag(false)}
        onMouseLeave={() => setHover(null)}
        data-no-dismiss-drag={noDrag || undefined}
        className={cn(
          "group/seek relative w-full cursor-pointer touch-none rounded-full bg-muted",
          barClassName
        )}
      >
        {/* played fill (freezes on the drag ghost while dragging) */}
        <div
          className={cn(
            "h-full rounded-full bg-gradient-to-r from-primary to-primary/40",
            fillClassName
          )}
          style={{ width: `${shown * 100}%` }}
        />
        {/* hover-ahead preview: theme-aware light segment */}
        {ahead && hover !== null && (
          <div
            aria-hidden
            className="absolute inset-y-0 rounded-full bg-foreground/20"
            style={{
              left: `${value * 100}%`,
              width: `${(hover - value) * 100}%`,
            }}
          />
        )}
        {/* knob + time pill */}
        {showTip && tipAt !== null && (
          <>
            <span
              aria-hidden
              className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground"
              style={{ left: `${tipAt * 100}%` }}
            />
            <span
              aria-hidden
              className="absolute -top-7 -translate-x-1/2 whitespace-nowrap rounded-full bg-foreground px-2 py-0.5 text-xs tabular-nums text-background"
              style={{ left: `${tipLeft}%` }}
            >
              {formatTime(tipAt * duration)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
