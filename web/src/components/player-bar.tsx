import { useEffect, useRef } from "react";
import { motion } from "framer-motion";

import { Button } from "@/components/ui/button";
import { formatTime } from "@/lib/api";
import { useCurrentTrack, usePlayer, useTime } from "@/player/store";
import {
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";

export function PlayerBar() {
  const track = useCurrentTrack();
  const playing = usePlayer((s) => s.playing);
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const repeat = usePlayer((s) => s.repeat);
  const error = usePlayer((s) => s.error);
  const { currentTime, duration } = useTime();
  const barRef = useRef<HTMLDivElement>(null);

  const { toggle, next, prev, seekTo, setVolume, toggleMute, cycleRepeat } =
    usePlayer.getState();

  // PC shortcuts (ignored while typing): Space play/pause, ←/→ seek 5s,
  // N/P next/previous, M mute. "/" focuses search (handled in App).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el !== null && (el.tagName === "INPUT" || el.tagName === "TEXTAREA"))
        return;
      const s = usePlayer.getState();
      switch (e.key) {
        case " ":
          e.preventDefault();
          s.toggle();
          break;
        case "ArrowRight":
          s.seekBy(5);
          break;
        case "ArrowLeft":
          s.seekBy(-5);
          break;
        case "n":
        case "N":
          s.next(true);
          break;
        case "p":
        case "P":
          s.prev();
          break;
        case "m":
        case "M":
          s.toggleMute();
          break;
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function seek(clientX: number) {
    const bar = barRef.current;
    if (!bar || !duration) return;
    const rect = bar.getBoundingClientRect();
    seekTo(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)));
  }

  const volRef = useRef<HTMLDivElement>(null);

  function setVol(clientX: number) {
    const bar = volRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    // setVolume unmutes by itself when the level is above 0
    setVolume(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)));
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const volPct = (muted ? 0 : volume) * 100;

  return (
    <footer className="hidden h-20 flex-shrink-0 items-center gap-3 rounded-3xl border border-border/40 bg-background/70 px-3 pb-[env(safe-area-inset-bottom)] backdrop-blur-2xl sm:h-24 sm:gap-4 sm:px-5 md:flex">
      <motion.div
        drag="x"
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.25}
        onDragEnd={(_, info) => {
          if (info.offset.x < -80) next(true);
          else if (info.offset.x > 80) prev();
        }}
        className="flex min-w-0 flex-1 cursor-grab items-center gap-3 active:cursor-grabbing sm:w-64 sm:flex-none"
      >
        {track !== undefined ? (
          <>
            <img
              src={track.coverUrl}
              alt=""
              className="h-11 w-11 flex-shrink-0 rounded-xl border border-border/40 object-cover sm:h-14 sm:w-14"
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground/90">
                {track.title}
              </p>
              <p className="truncate text-xs text-foreground/60">
                {track.artist}
              </p>
            </div>
          </>
        ) : (
          <p className="text-sm text-foreground/40">Nothing playing</p>
        )}
      </motion.div>

      <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="hidden h-8 w-8 rounded-full text-foreground/60 hover:text-foreground sm:inline-flex"
          >
            <Shuffle className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => prev()}
            className="h-8 w-8 rounded-full text-foreground/70 hover:text-foreground"
          >
            <SkipBack className="h-4 w-4" />
          </Button>
          <Button
            onClick={() => toggle()}
            className="h-10 w-10 rounded-full bg-foreground text-background hover:bg-foreground/90"
          >
            {playing ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => next(true)}
            className="h-8 w-8 rounded-full text-foreground/70 hover:text-foreground"
          >
            <SkipForward className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => cycleRepeat()}
            title={`Repeat: ${repeat}`}
            className={`hidden h-8 w-8 rounded-full hover:text-foreground sm:inline-flex ${
              repeat === "off" ? "text-foreground/60" : "text-foreground"
            }`}
          >
            {repeat === "one" ? (
              <Repeat1 className="h-4 w-4" />
            ) : (
              <Repeat className="h-4 w-4" />
            )}
          </Button>
        </div>
        <div className="flex w-full max-w-xl items-center gap-2">
          <span className="w-10 text-right text-[11px] tabular-nums text-foreground/50">
            {formatTime(currentTime)}
          </span>
          <div
            ref={barRef}
            onClick={(e) => seek(e.clientX)}
            className="h-1.5 flex-1 cursor-pointer rounded-full bg-foreground/10"
          >
            <div
              className="h-full rounded-full bg-gradient-to-r from-foreground to-foreground/40"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="w-10 text-[11px] tabular-nums text-foreground/50">
            {formatTime(duration || track?.duration || 0)}
          </span>
        </div>
        {error !== null && (
          <p className="text-[11px] text-foreground/60">{error}</p>
        )}
      </div>

      <div className="hidden w-48 items-center gap-2 md:flex">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => toggleMute()}
          className="h-8 w-8 rounded-full text-foreground/60 hover:text-foreground"
        >
          {muted ? (
            <VolumeX className="h-4 w-4" />
          ) : (
            <Volume2 className="h-4 w-4" />
          )}
        </Button>
        {/* same bar as the song seek: click-to-set, gradient fill */}
        <div
          ref={volRef}
          onClick={(e) => setVol(e.clientX)}
          className="h-1.5 flex-1 cursor-pointer rounded-full bg-foreground/10"
        >
          <div
            className="h-full rounded-full bg-gradient-to-r from-foreground to-foreground/40"
            style={{ width: `${volPct}%` }}
          />
        </div>
      </div>
    </footer>
  );
}
