import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { formatTime, type Song } from "@/lib/api";
import {
  Pause,
  Play,
  Repeat,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";

interface Props {
  track: Song | undefined;
  onNext: () => void;
  onPrev: () => void;
  onEnded: () => void;
}

export function PlayerBar({ track, onNext, onPrev, onEnded }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0.9);

  function toggle() {
    const audio = audioRef.current;
    if (!audio || track === undefined) return;
    if (audio.paused) {
      if (audio.src === "") audio.src = track.streamUrl;
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }

  function seek(clientX: number) {
    const audio = audioRef.current;
    const bar = barRef.current;
    if (!audio || !bar || !audio.duration) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    audio.currentTime = ratio * audio.duration;
  }

  function changeVolume(v: number) {
    const audio = audioRef.current;
    setVolume(v);
    setMuted(v === 0);
    if (audio) {
      audio.volume = v;
      audio.muted = v === 0;
    }
  }

  function toggleMute() {
    const audio = audioRef.current;
    const next = !muted;
    setMuted(next);
    if (audio) audio.muted = next;
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <footer className="flex h-24 flex-shrink-0 items-center gap-4 rounded-3xl border border-border/40 bg-background/70 px-5 backdrop-blur-2xl">
      <audio
        ref={audioRef}
        src={track?.streamUrl ?? ""}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          setDuration(e.currentTarget.duration);
          setCurrentTime(0);
          e.currentTarget.play().catch(() => {});
        }}
        onEnded={onEnded}
      />

      <div className="flex w-64 min-w-0 items-center gap-3">
        {track !== undefined ? (
          <>
            <img
              src={track.coverUrl}
              alt=""
              className="h-14 w-14 flex-shrink-0 rounded-xl border border-border/40 object-cover"
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
      </div>

      <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full text-foreground/60 hover:text-foreground"
          >
            <Shuffle className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onPrev}
            className="h-8 w-8 rounded-full text-foreground/70 hover:text-foreground"
          >
            <SkipBack className="h-4 w-4" />
          </Button>
          <Button
            onClick={toggle}
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
            onClick={onNext}
            className="h-8 w-8 rounded-full text-foreground/70 hover:text-foreground"
          >
            <SkipForward className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full text-foreground/60 hover:text-foreground"
          >
            <Repeat className="h-4 w-4" />
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
      </div>

      <div className="hidden w-48 items-center gap-2 md:flex">
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleMute}
          className="h-8 w-8 rounded-full text-foreground/60 hover:text-foreground"
        >
          {muted ? (
            <VolumeX className="h-4 w-4" />
          ) : (
            <Volume2 className="h-4 w-4" />
          )}
        </Button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={muted ? 0 : volume}
          onChange={(e) => changeVolume(Number(e.target.value))}
          className="h-1 w-full accent-foreground"
        />
      </div>
    </footer>
  );
}
