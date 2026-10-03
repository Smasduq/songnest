import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useMotionValue, useTransform } from "framer-motion";

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
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // swipe-right distance drives the queue action reveal
  const x = useMotionValue(0);
  const actionOpacity = useTransform(x, [0, 90], [0, 1]);
  const actionScale = useTransform(x, [0, 90], [0.6, 1]);

  // portal menu: escapes the scroll container so cards below can't cover it
  useEffect(() => {
    if (!open) return;
    function place() {
      const r = btnRef.current?.getBoundingClientRect();
      if (r === undefined) return;
      setPos({ top: r.bottom + 8, right: window.innerWidth - r.right });
    }
    place();
    function close(e: MouseEvent) {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !btnRef.current?.contains(t))
        setOpen(false);
    }
    function dismiss() {
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open ]);

  function pick(fn: () => void) {
    setOpen(false);
    fn();
  }

  return (
    <div className="relative">
      {/* revealed while swiping right — Spotify style */}
      <motion.div
        style={{ opacity: actionOpacity, scale: actionScale }}
        className="pointer-events-none absolute inset-y-0 left-0 flex w-24 items-center justify-center gap-1.5 rounded-2xl bg-foreground text-background sm:rounded-3xl"
      >
        <ListPlus className="h-5 w-5" />
        <span className="text-xs font-semibold">Queue</span>
      </motion.div>
      <motion.div
        drag="x"
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.15}
        dragDirectionLock
        style={{ x }}
        onDragEnd={(_, info) => {
          if (info.offset.x > 90) onAddToQueue();
        }}
        className={`relative flex cursor-grab items-center gap-3 overflow-hidden rounded-2xl border bg-background/85 p-3 backdrop-blur-xl active:cursor-grabbing sm:gap-4 sm:rounded-3xl sm:p-4 ${
          active
            ? "border-foreground/40 bg-foreground/[0.08]"
            : "border-border/40 bg-background/60"
        }`}
      ><button
        type="button"
        onClick={onPlay}
        className="relative h-12 w-12 flex-shrink-0 overflow-hidden rounded-xl border border-border/40 bg-gradient-to-br from-foreground/30 via-foreground/10 to-transparent sm:h-16 sm:w-16 sm:rounded-2xl"
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
      <div className="relative flex-shrink-0">
        <button
          ref={btnRef}
          type="button"
          aria-label="More actions"
          onClick={() => setOpen((o) => !o)}
          className="flex h-8 w-8 items-center justify-center rounded-full border border-border/40 bg-background/60 text-foreground/70 backdrop-blur hover:text-foreground sm:h-9 sm:w-9"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {createPortal(
          <AnimatePresence>
            {open && (
              <motion.div
                key="song-menu"
                ref={menuRef}
                style={{ top: pos.top, right: pos.right }}
                initial={{ opacity: 0, scale: 0.96, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ type: "spring", stiffness: 400, damping: 35 }}
                className="fixed z-[100] w-48 overflow-hidden rounded-2xl border border-border/50 bg-background/95 p-1.5 shadow-[0_20px_60px_rgba(15,23,42,0.35)] backdrop-blur-2xl"
              >
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
              </motion.div>
            )}
          </AnimatePresence>,
          document.body
        )}
      </div>
      </motion.div>
    </div>
  );
}
