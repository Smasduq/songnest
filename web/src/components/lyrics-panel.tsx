import { useEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";

import {
  activeLyricIndex,
  fetchLyrics,
  setLyricOffset,
  type LyricLine,
  type Song,
} from "@/lib/api";
import {
  nativePositionSmooth,
  nativeSeek,
  preferNativeTransport,
} from "@/native/background-player";
import { audio, usePlayer } from "@/player/store";
import { SparklesText } from "@/components/ui/sparkles-text";
import { useArtworkColors } from "@/lib/artwork-colors";

type Status =
  | "loading"
  | "synced"
  | "plain"
  | "instrumental"
  | "missing"
  | "error";

function playerPositionMs(): number {
  return preferNativeTransport()
    ? nativePositionSmooth() * 1000
    : audio.currentTime * 1000;
}

function seekToMs(ms: number): void {
  const secs = Math.max(0, ms / 1000);
  if (preferNativeTransport()) {
    void nativeSeek(secs);
    return;
  }
  try {
    audio.currentTime = secs;
  } catch {
    // element not ready — ignore
  }
}

/**
 * Time-synced lyrics view. Driven by requestAnimationFrame while playing
 * (timeupdate is too coarse at ~4Hz); position = player + user offset.
 */
export function LyricsPanel({
  track,
  scrollClassName,
  size = "compact",
}: {
  track: Song;
  /** override the scroll-container height (page uses a taller one) */
  scrollClassName?: string;
  /** large: roomy editorial lyrics for the desktop page; compact: mobile sheet */
  size?: "compact" | "large";
}) {
  const large = size === "large";
  // Sparkles borrow their palette from the current artwork.
  const artworkColors = useArtworkColors(track.coverUrl);
  const playing = usePlayer((s) => s.playing);
  const [status, setStatus] = useState<Status>("loading");
  const [lines, setLines] = useState<LyricLine[]>([]);
  const [plain, setPlain] = useState<string | null>(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const [active, setActive] = useState(-1);
  const [saving, setSaving] = useState(false);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const prevPos = useRef(0);

  // Fetch per track; stale responses are dropped.
  useEffect(() => {
    let alive = true;
    setStatus("loading");
    setLines([]);
    setPlain(null);
    setActive(-1);
    prevPos.current = 0;
    fetchLyrics(track)
      .then((res) => {
        if (!alive) return;
        setOffsetMs(res.offset_ms ?? 0);
        if (res.instrumental) {
          setStatus("instrumental");
        } else if (res.synced !== null && res.synced.length > 0) {
          setLines(res.synced);
          setStatus("synced");
        } else if (res.plain !== null && res.plain.trim() !== "") {
          setPlain(res.plain);
          setStatus("plain");
        } else {
          setStatus("missing");
        }
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setStatus(
          e instanceof Error && e.message === "No lyrics found"
            ? "missing"
            : "error"
        );
      });
    return () => {
      alive = false;
    };
  }, [track]);

  // A seek jumps the highlight: reset to -1 so it re-lands correctly.
  useEffect(() => {
    const reset = () => setActive(-1);
    audio.addEventListener("seeked", reset);
    return () => audio.removeEventListener("seeked", reset);
  }, []);

  // rAF sync loop: only while playing with synced lines.
  useEffect(() => {
    if (!playing || lines.length === 0) return;
    let raf = 0;
    function tick() {
      const pos = playerPositionMs() + offsetMs;
      // Jump = seek or track change: clear first, recompute next frame.
      if (Math.abs(pos - prevPos.current) > 1200) {
        prevPos.current = pos;
        setActive(-1);
        raf = requestAnimationFrame(tick);
        return;
      }
      prevPos.current = pos;
      setActive((cur) => {
        const next = activeLyricIndex(lines, pos);
        return next === cur ? cur : next;
      });
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, lines, offsetMs]);

  // Paused: pin the highlight to the current position once.
  useEffect(() => {
    if (playing || lines.length === 0) return;
    setActive(activeLyricIndex(lines, playerPositionMs() + offsetMs));
  }, [playing, lines, offsetMs, track]);

  // Keep the active line centered.
  useEffect(() => {
    if (active < 0) return;
    rowRefs.current[active]?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, [active]);

  async function nudge(delta: number) {
    const next = Math.min(5000, Math.max(-5000, offsetMs + delta));
    setOffsetMs(next);
    setSaving(true);
    try {
      const saved = await setLyricOffset(track.id, next);
      setOffsetMs(saved);
    } catch {
      // offline: keep the local value for this session
    } finally {
      setSaving(false);
    }
  }

  if (status === "loading") {
    return (
      <p
        className={
          large
            ? "py-16 text-center text-[15px] text-muted-foreground"
            : "py-4 text-center text-sm text-muted-foreground"
        }
      >
        Finding lyrics…
      </p>
    );
  }
  if (status === "instrumental") {
    return (
      <div className={large ? "flex justify-center py-16" : "flex justify-center py-4"}>
        <SparklesText
          text="Instrumental"
          sparklesCount={large ? 12 : 8}
          colors={artworkColors}
          className={
            large
              ? "text-center text-2xl font-medium uppercase tracking-[0.2em] text-muted-foreground"
              : "text-center text-sm font-bold uppercase tracking-[0.2em] text-muted-foreground"
          }
        />
      </div>
    );
  }
  if (status === "missing") {
    return (
      <p
        className={
          large
            ? "py-16 text-center text-[15px] text-muted-foreground"
            : "py-4 text-center text-sm text-muted-foreground"
        }
      >
        No lyrics found
      </p>
    );
  }
  if (status === "error") {
    return (
      <p
        className={
          large
            ? "py-16 text-center text-[15px] text-muted-foreground"
            : "py-4 text-center text-sm text-muted-foreground"
        }
      >
        Lyrics unavailable — check connection.
      </p>
    );
  }
  if (status === "plain") {
    return (
      <div className="space-y-2">
        <p
          className={
            large
              ? "max-w-2xl whitespace-pre-line text-lg leading-loose text-foreground/90 md:text-xl"
              : "whitespace-pre-line text-sm leading-relaxed text-foreground/90"
          }
        >
          {plain}
        </p>
      </div>
    );
  }
  return (
    <div className={large ? "space-y-4" : "space-y-2"}>
      <div
        data-no-dismiss-drag
        className={
          large
            ? `scroller space-y-1 overflow-y-auto bg-transparent [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_bottom,transparent,black_6%,black_94%,transparent)] ${scrollClassName ?? "max-h-64"}`
            : `scroller space-y-1 overflow-y-auto rounded-2xl border border-border/40 bg-background/40 p-3 ${scrollClassName ?? "max-h-64"}`
        }
      >
        {lines.map((l, i) => {
          const isActive = i === active;
          const isPast = i < active;
          return (
            <button
              key={`${l.ms}-${i}`}
              ref={(el) => {
                rowRefs.current[i] = el;
              }}
              type="button"
              onClick={() => {
                setActive(-1);
                seekToMs(l.ms);
              }}
              className={
                large
                  ? `block w-full rounded-2xl px-4 py-2 text-left text-2xl font-medium tracking-tight transition-all duration-300 md:text-[28px] md:leading-[1.35] ${
                      isActive
                        ? "scale-[1.01] text-foreground"
                        : isPast
                          ? "text-muted-foreground/40"
                          : "text-muted-foreground/75 hover:text-muted-foreground"
                    }`
                  : `block w-full rounded-lg px-2 py-1 text-left text-[15px] leading-snug transition-colors ${
                      isActive
                        ? "bg-primary/10 font-semibold text-foreground"
                        : isPast
                          ? "text-muted-foreground/60"
                          : "text-muted-foreground"
                    }`
              }
            >
              {isActive ? (
                <SparklesText
                  as={<span />}
                  text={l.text === "" ? "· · ·" : l.text}
                  sparklesCount={large ? 10 : 6}
                  colors={artworkColors}
                  className={
                    large
                      ? "text-2xl font-semibold tracking-tight md:text-[28px] md:leading-[1.35]"
                      : "text-[15px] leading-snug"
                  }
                />
              ) : (
                l.text === "" ? "· · ·" : l.text
              )}
            </button>
          );
        })}
      </div>
      {large ? (
        <div className="flex items-center justify-between pt-2 text-[13px]">
          <button
            type="button"
            disabled={saving}
            onClick={() => void nudge(-100)}
            className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/60 px-3.5 py-1.5 font-medium text-muted-foreground backdrop-blur transition hover:border-border hover:text-foreground active:scale-95 disabled:opacity-50"
          >
            <Minus className="size-3.5" aria-hidden="true" />
            100ms
          </button>
          <span className="tabular-nums text-muted-foreground/70">
            {offsetMs === 0 ? "in sync" : `${offsetMs > 0 ? "+" : ""}${offsetMs}ms`}
          </span>
          <button
            type="button"
            disabled={saving}
            onClick={() => void nudge(100)}
            className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/60 px-3.5 py-1.5 font-medium text-muted-foreground backdrop-blur transition hover:border-border hover:text-foreground active:scale-95 disabled:opacity-50"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            100ms
          </button>
        </div>
      ) : (
      <div
        className="flex items-center justify-center gap-2 text-xs text-muted-foreground"
      >
        <span className="tabular-nums">
          {offsetMs === 0 ? "in sync" : `${offsetMs > 0 ? "+" : ""}${offsetMs}ms`}
        </span>
        <button
          type="button"
          disabled={saving}
          onClick={() => void nudge(-100)}
          className="rounded-full border border-border/40 px-2.5 py-1 hover:text-foreground disabled:opacity-50"
        >
          −100ms
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => void nudge(100)}
          className="rounded-full border border-border/40 px-2.5 py-1 hover:text-foreground disabled:opacity-50"
        >
          +100ms
        </button>
      </div>
      )}
    </div>
  );
}
