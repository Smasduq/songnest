import { useEffect, useRef, useState } from "react";

import { formatTime, type Song } from "@/lib/api";
import { Check, Download, Heart, ListPlus, MoreHorizontal } from "lucide-react";

export type DlState = "idle" | "working" | "done" | "error";

interface Props {
  song: Song;
  /** dz id when the song is downloadable (suggestions/search hits). */
  downloadableDz: number | null;
  liked: boolean;
  dl: DlState;
  dlProgress: number;
  active?: boolean;
  onToggleLike: () => void;
  onDownload: () => void;
  onAddToQueue: () => void;
  onPlay: () => void;
}

export function SongCard({
  song,
  downloadableDz,
  liked,
  dl,
  dlProgress,
  active = false,
  onToggleLike,
  onDownload,
  onAddToQueue,
  onPlay,
}: Props) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function close(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open ]);

  function pick(fn: () => void) {
    setOpen(false);
    fn();
  }

  return (
    <div
      className={`group relative flex items-center gap-4 rounded-3xl border p-4 backdrop-blur-xl transition-all duration-300 hover:-translate-y-0.5 ${
        active
          ? "border-foreground/40 bg-foreground/[0.08]"
          : "border-border/40 bg-background/60 hover:border-border/60"
      }`}
    ><button
        type="button"
        onClick={onPlay}
        className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-2xl border border-border/40 bg-gradient-to-br from-foreground/30 via-foreground/10 to-transparent"
      >
        {song.coverUrl !== "" && (
          <img
            src={song.coverUrl}
            alt={`${song.album} cover`}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        )}
      </button>
      <button
        type="button"
        onClick={onPlay}
        className="min-w-0 flex-1 text-left"
      >
        <p className="truncate text-sm font-semibold text-foreground/90">
          {song.title}
        </p>
        <p className="truncate text-xs text-foreground/60">
          {song.artist} · {song.album}
        </p>
        <p className="mt-0.5 text-xs font-medium uppercase tracking-[0.2em] text-foreground/50">
          {formatTime(song.duration)}
        </p>
      </button>
      {liked && <Heart className="h-4 w-4 flex-shrink-0 fill-foreground text-foreground" />}
      <div ref={menuRef} className="relative flex-shrink-0">
        <button
          type="button"
          aria-label="More actions"
          onClick={() => setOpen((o) => !o)}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-border/40 bg-background/60 text-foreground/70 backdrop-blur hover:text-foreground"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {open && (
          <div className="absolute right-0 top-11 z-30 w-48 overflow-hidden rounded-2xl border border-border/50 bg-background/95 p-1.5 shadow-[0_20px_60px_rgba(15,23,42,0.35)] backdrop-blur-2xl">
            <button
              type="button"
              onClick={() => pick(onToggleLike)}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm text-foreground/80 hover:bg-foreground/5"
            >
              <Heart
                className={`h-4 w-4 ${liked ? "fill-foreground text-foreground" : ""}`}
              />
              {liked ? "Unlike" : "Like"}
            </button>
            <button
              type="button"
              disabled={downloadableDz === null || dl === "working" || dl === "done"}
              onClick={() => pick(onDownload)}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm text-foreground/80 hover:bg-foreground/5 disabled:opacity-40"
            >
              {dl === "done" ? (
                <Check className="h-4 w-4" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {dl === "working"
                ? `Downloading ${dlProgress}%`
                : dl === "done"
                  ? "Downloaded"
                  : dl === "error"
                    ? "Retry download"
                    : "Download"}
            </button>
            <button
              type="button"
              onClick={() => pick(onAddToQueue)}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm text-foreground/80 hover:bg-foreground/5"
            >
              <ListPlus className="h-4 w-4" />
              Add to queue
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
