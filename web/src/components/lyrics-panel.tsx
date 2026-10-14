import { useEffect, useRef, useState } from "react";

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
export function LyricsPanel({ track }: { track: Song }) {
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
      <p className="py-4 text-center text-sm text-muted-foreground">
        Finding lyrics…
      </p>
    );
  }
  if (status === "instrumental") {
    return (
      <p className="py-4 text-center text-sm uppercase tracking-[0.2em] text-muted-foreground">
        Instrumental
      </p>
    );
  }
  if (status === "missing") {
    return (
      <p className="py-4 text-center text-sm text-muted-foreground">
        No lyrics found
      </p>
    );
  }
  if (status === "error") {
    return (
      <p className="py-4 text-center text-sm text-muted-foreground">
        Lyrics unavailable — check connection.
      </p>
    );
  }
  if (status === "plain") {
    return (
      <div className="space-y-2">
        <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/90">
          {plain}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div
        data-no-dismiss-drag
        className="scroller max-h-64 space-y-1 overflow-y-auto rounded-2xl border border-border/40 bg-background/40 p-3"
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
              className={`block w-full rounded-lg px-2 py-1 text-left text-[15px] leading-snug transition-colors ${
                isActive
                  ? "bg-primary/10 font-semibold text-foreground"
                  : isPast
                    ? "text-muted-foreground/60"
                    : "text-muted-foreground"
              }`}
            >
              {l.text === "" ? "· · ·" : l.text}
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
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
    </div>
  );
}
