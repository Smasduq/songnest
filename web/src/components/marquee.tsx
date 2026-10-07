import { useEffect, useRef, useState, type CSSProperties } from "react";

// Below this many overflowing pixels we stay truncated: a 5px drift
// back-and-forth reads as a glitch, not a marquee.
const SCROLL_THRESHOLD_PX = 24;

interface Props {
  text: string;
  className?: string;
}

/**
 * Spotify-style marquee: short text renders truncated, overflowing text
 * scrolls right-to-left with a pause at each end, then loops. The scroll
 * is transform-only (compositor) and disabled entirely under
 * prefers-reduced-motion (stays truncated). The measuring structure is
 * always mounted so overflow is detected on first paint, not just on
 * updates; a ResizeObserver keeps it correct across font loads and
 * viewport changes.
 */
export function Marquee({ text, className }: Props) {
  const outer = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);

  useEffect(() => {
    function measure() {
      const o = outer.current;
      const i = inner.current;
      if (o === null || i === null) return;
      // Re-read both nodes: fonts and layout settle after mount.
      const overflow = i.scrollWidth - o.clientWidth;
      const next = overflow > SCROLL_THRESHOLD_PX ? overflow : 0;
      setDistance((prev) => (prev === next ? prev : next));
    }
    measure();
    const o = outer.current;
    const i = inner.current;
    if (o === null || i === null) return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(o);
    ro.observe(i);
    return () => ro.disconnect();
  }, [text]);

  const cls = className ?? "";
  if (distance === 0) {
    return (
      <span
        // Remount per song/text so a new title re-measures from scratch.
        key={text}
        ref={outer}
        className={`block overflow-hidden ${cls}`}
      >
        <span ref={inner} title={text} className="block truncate">
          {text}
        </span>
      </span>
    );
  }
  // ~45px/s scroll with a 1.4s rest at each end.
  const duration = 2.8 + distance / 45;
  const style = {
    "--marquee-distance": `${distance}px`,
    animationDuration: `${duration}s`,
  } as CSSProperties;
  return (
    <span key={text} ref={outer} className={`block overflow-hidden ${cls}`}>
      <span
        ref={inner}
        title={text}
        style={style}
        className="marquee-inner inline-block whitespace-nowrap will-change-transform"
      >
        {text}
      </span>
    </span>
  );
}
