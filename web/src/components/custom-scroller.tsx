import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Custom scrollbar for the main page (fine pointers only — touch keeps
 * native scrolling). Native bar is hidden; this renders its own 4px-grid
 * track + draggable thumb that flashes on scroll and shows on hover.
 */
export function CustomScroller({
  className,
  children,
  scrollRef,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
}: {
  className?: string;
  children: React.ReactNode;
  scrollRef?: React.Ref<HTMLElement>;
  onTouchStart?: (e: React.TouchEvent) => void;
  onTouchMove?: (e: React.TouchEvent) => void;
  onTouchEnd?: () => void;
}) {
  const innerRef = useRef<HTMLElement | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [fine, setFine] = useState(false);
  const [geom, setGeom] = useState({ height: 32, top: 0, fits: true });
  const [lit, setLit] = useState(false);
  const drag = useRef<{ y: number; top: number } | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const mq = window.matchMedia("(pointer: fine)");
    setFine(mq.matches);
    const fn = (e: MediaQueryListEvent) => setFine(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);

  const flash = useCallback(() => {
    setLit(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (drag.current === null) setLit(false);
    }, 1200);
  }, []);

  const measure = useCallback(() => {
    const el = innerRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    // track is inset 8px top + bottom (top-2 bottom-2)
    const trackH = Math.max(1, clientHeight - 16);
    if (scrollHeight <= clientHeight + 1) {
      setGeom({ height: 0, top: 0, fits: true });
      return;
    }
    const height = Math.max(32, (clientHeight / scrollHeight) * trackH);
    const top =
      ((scrollTop / (scrollHeight - clientHeight)) * (trackH - height)) || 0;
    setGeom({ height, top, fits: false });
  }, []);

  useEffect(() => {
    measure();
    flash();
    const el = innerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, flash, children]);

  function scrollByThumb(clientY: number) {
    const d = drag.current;
    const el = innerRef.current;
    const track = trackRef.current;
    if (!d || !el || !track) return;
    const trackH = track.clientHeight;
    const ratio =
      (el.scrollHeight - el.clientHeight) /
      Math.max(1, trackH - geom.height);
    el.scrollTop = d.top + (clientY - d.y) * ratio;
  }

  function jumpTrack(e: React.MouseEvent) {
    const el = innerRef.current;
    const track = trackRef.current;
    if (!el || !track) return;
    const rect = track.getBoundingClientRect();
    const ratio = (e.clientY - rect.top - geom.height / 2) / rect.height;
    el.scrollTo({
      top: ratio * (el.scrollHeight - el.clientHeight),
      behavior: "smooth",
    });
  }

  const showBar = fine && !geom.fits;

  return (
    <div className="group/bar relative min-h-0 min-w-0 flex-1 overflow-hidden">
      <main
        ref={(n) => {
          innerRef.current = n;
          if (typeof scrollRef === "function") scrollRef(n);
          else if (scrollRef && "current" in (scrollRef as object)) {
            (scrollRef as React.MutableRefObject<HTMLElement | null>).current = n;
          }
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onScroll={() => {
          measure();
          flash();
        }}
        className={`${className ?? ""} h-full w-full overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`}
      >
        {children}
      </main>
      {showBar && (
        <div
          ref={trackRef}
          onClick={jumpTrack}
          className="absolute bottom-2 right-1 top-2 w-2 cursor-pointer rounded-full bg-transparent transition-colors hover:bg-foreground/10"
        >
          <div
            role="scrollbar"
            aria-orientation="vertical"
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
              drag.current = { y: e.clientY, top: innerRef.current?.scrollTop ?? 0 };
              setLit(true);
            }}
            onPointerMove={(e) => {
              if (drag.current !== null) scrollByThumb(e.clientY);
            }}
            onPointerUp={() => {
              drag.current = null;
              flash();
            }}
            onPointerCancel={() => {
              drag.current = null;
              flash();
            }}
            style={{ height: geom.height, top: geom.top }}
            className={`absolute left-0 w-2 touch-none rounded-full bg-foreground/25 transition-opacity duration-200 hover:bg-foreground/45 ${
              lit ? "opacity-100" : "opacity-0 group-hover/bar:opacity-100"
            }`}
          />
        </div>
      )}
    </div>
  );
}
