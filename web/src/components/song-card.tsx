import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useMotionValueEvent,
  useTransform,
} from "framer-motion";

import { formatTime, type Song } from "@/lib/api";
import { haptic } from "@/native/haptics";
import {
  Check,
  Clock,
  Download,
  Heart,
  ListPlus,
  Loader2,
  MoreVertical,
  Play,
  RotateCcw,
  Trash2,
} from "lucide-react";

export type DlState = "idle" | "queued" | "working" | "done" | "error";

/** Swipe-left action, picked by context: library deletes, downloaded songs
 *  elsewhere like/unlike, everything else downloads. */
export type SwipeLeftKind = "download" | "delete" | "like";

export type SongCardVariant = "card" | "list";

interface Props {
  song: Song;
  /** dz id when the song is downloadable (suggestions/search hits). */
  downloadableDz: number | null;
  liked: boolean;
  dl: DlState;
  dlProgress: number;
  active?: boolean;
  /** yt-dlp is resolving this song's stream (shows a spinner on the art). */
  resolving?: boolean;
  swipeLeft: SwipeLeftKind;
  onToggleLike: () => void;
  onDownload: () => void;
  onDelete: (() => void) | null;
  onSwipeLeft: () => void;
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
  resolving = false,
  swipeLeft,
  onToggleLike,
  onDownload,
  onDelete,
  onSwipeLeft,
  onAddToQueue,
  onPlay,
}: Props) {
  const [open, setOpen] = useState(false);
  // "button": opened from ⋯ (anchor under it); "cursor": right-click /
  // long-press (positioned at the pointer by openAt, never re-anchored)
  const [anchor, setAnchor] = useState<"button" | "cursor">("button");
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number }>({
    top: 0,
    right: 0,
  });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pressTimer = useRef<number | undefined>(undefined);
  // touchend is followed ~300ms later by a synthetic mousedown; without
  // this guard the long-press menu would close the instant it opens
  const lastTouchEnd = useRef(0);
  // swipe bookkeeping: threshold-crossed side (for haptics), edge-zone start
  const rowRef = useRef<HTMLDivElement>(null);
  const crossedRef = useRef<"left" | "right" | null>(null);
  const edgeStartRef = useRef(false);
  // swipe distances drive the action reveals; both sides mirror each other
  // (same 90px commit, same spring back) so left feels like swipe-to-queue
  const x = useMotionValue(0);
  const actionOpacity = useTransform(x, [0, 90], [0, 1]);
  const actionScale = useTransform(x, [0, 90], [0.6, 1]);
  const stripOpacity = useTransform(x, [-90, 0], [1, 0]);
  const stripScale = useTransform(x, [-90, 0], [1, 0.6]);

  // haptic tick the moment either threshold is crossed
  useMotionValueEvent(x, "change", (v) => {
    const crossed = crossedRef.current;
    if (crossed === null) {
      if (v < -90) {
        crossedRef.current = "left";
        void haptic("medium");
      } else if (v > 90) {
        crossedRef.current = "right";
        void haptic("medium");
      }
    } else if (crossed === "left" && v > -78) {
      crossedRef.current = null;
    } else if (crossed === "right" && v < 78) {
      crossedRef.current = null;
    }
  });

  const leftLabel =
    swipeLeft === "delete" ? "Delete" : swipeLeft === "like" ? (liked ? "Unlike" : "Like") : "Download";

  // portal menu: escapes the scroll container so cards below can't cover it
  useEffect(() => {
    if (!open) return;
    function place() {
      const r = btnRef.current?.getBoundingClientRect();
      if (r === undefined) return;
      setPos({ top: r.bottom + 8, right: window.innerWidth - r.right, left: undefined });
    }
    // ⋯ opens anchor under the button; cursor opens keep openAt's position
    if (anchor === "button") place();
    function close(e: MouseEvent) {
      if (Date.now() - lastTouchEnd.current < 500) return;
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
  }, [open, anchor]);

  function pick(fn: () => void) {
    setOpen(false);
    fn();
  }

  // w-48 menu (192px) + margins; height varies with actions, 260 covers it
  function openAt(clientX: number, clientY: number, fromTouch = false) {
    const W = 200;
    const H = 260;
    const maxLeft = Math.max(8, window.innerWidth - W);
    const maxTop = Math.max(8, window.innerHeight - H);
    // mouse (Win/Mac/Linux incl. Ctrl+click): top-left at the cursor,
    // flipped inside when near an edge. touch: open above the finger
    // so it stays visible instead of under it.
    const top = fromTouch ? clientY - H : clientY;
    setPos({
      top: Math.max(8, Math.min(top, maxTop)),
      left: Math.max(8, Math.min(clientX, maxLeft)),
      right: undefined,
    });
    setAnchor("cursor");
    setOpen(true);
  }

  // long-press (~400ms without moving) opens the context menu in place
  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    // left 40px belongs to edge-swipe-back: never start a row swipe there
    edgeStartRef.current = t.clientX < 40;
    const sx = t.clientX;
    const sy = t.clientY;
    window.clearTimeout(pressTimer.current);
    pressTimer.current = window.setTimeout(() => openAt(sx, sy, true), 400);
    const cancel = (ev: TouchEvent) => {
      const m = ev.touches[0];
      if (m !== undefined && Math.hypot(m.clientX - sx, m.clientY - sy) > 10) {
        window.clearTimeout(pressTimer.current);
      }
    };
    const up = () => {
      window.clearTimeout(pressTimer.current);
      lastTouchEnd.current = Date.now();
      document.removeEventListener("touchmove", cancel);
      document.removeEventListener("touchend", up);
    };
    document.addEventListener("touchmove", cancel, { passive: true });
    document.addEventListener("touchend", up);
  }

  return (
    <div
      className="relative"
      onTouchStart={onTouchStart}
      onContextMenu={(e) => {
        // supported on Win/Mac/Linux browsers + Tauri webviews
        // (macOS Ctrl+click synthesizes this event)
        e.preventDefault();
        openAt(e.clientX, e.clientY);
      }}
    >
      {/* revealed while swiping right — add-to-queue action */}
      <motion.div
        style={{ opacity: actionOpacity, scale: actionScale }}
        className="pointer-events-none absolute inset-y-0 left-0 flex w-24 items-center justify-center gap-1.5 rounded-2xl bg-primary text-primary-foreground sm:rounded-3xl"
      >
        <ListPlus className="h-5 w-5" />
        <span className="text-xs font-semibold">Queue</span>
      </motion.div>
      {/* revealed while swiping left — action depends on context.
          Scale sits on the pill itself (like the queue pill) so the whole
          button grows under the finger, not just its content. */}
      <motion.div
        style={{ opacity: stripOpacity, scale: stripScale }}
        className="pointer-events-none absolute inset-y-0 right-0 flex w-28 items-center justify-center gap-1.5 rounded-2xl bg-primary text-primary-foreground sm:rounded-3xl"
      >
        <span className="flex items-center gap-1.5">
          {swipeLeft === "delete" ? (
            <Trash2 className="h-5 w-5" />
          ) : swipeLeft === "like" ? (
            <Heart className={`h-5 w-5 ${liked ? "fill-background" : ""}`} />
          ) : (
            <Download className="h-5 w-5" />
          )}
          <span className="text-xs font-semibold">{leftLabel}</span>
        </span>
      </motion.div>
      <motion.div
        ref={rowRef}
        drag="x"
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.15}
        dragDirectionLock
        style={{ x }}
        onDragStart={() => {
          crossedRef.current = null;
        }}
        onDragEnd={(_, info) => {
          // edge-back zone owns this gesture: bounce back, do nothing
          if (edgeStartRef.current) {
            edgeStartRef.current = false;
            return;
          }
          if (info.offset.x > 90 || info.velocity.x > 600) {
            onAddToQueue();
          } else if (info.offset.x < -90 || info.velocity.x < -600) {
            if (swipeLeft === "download") {
              // already have it (or busy): rubber-band bounce only
              if (
                downloadableDz === null ||
                (dl !== "idle" && dl !== "error")
              ) {
                return;
              }
            }
            onSwipeLeft();
          }
        }}
        className={`group/card relative flex touch-pan-y cursor-grab items-center gap-3 overflow-hidden rounded-2xl p-3 backdrop-blur-xl active:cursor-grabbing sm:gap-4 sm:rounded-3xl sm:p-4 ${
          active
            ? "border border-foreground/40 bg-foreground/[0.08]"
            : "border border-transparent bg-transparent hover:border-border/40 hover:bg-background/60"
        }`}
      ><button
        type="button"
        onClick={onPlay}
        aria-label={`Play ${song.title}`}
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
        <span
          aria-hidden
          className="absolute inset-0 flex items-center justify-center bg-background/50 opacity-0 transition-opacity duration-150 group-hover/card:opacity-100 group-focus-within/card:opacity-100"
        >
          <Play className="h-5 w-5 fill-foreground text-foreground" />
        </span>
        {resolving && (
          <span
            role="status"
            aria-label="Resolving audio"
            className="absolute inset-0 flex items-center justify-center bg-background/60"
          >
            <Loader2 className="h-5 w-5 animate-spin text-foreground" />
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={onPlay}
        className="min-w-0 flex-1 text-left"
      >
        <p className="truncate text-sm font-semibold text-foreground">
          {song.title}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {song.artist} · {song.album}
        </p>
        <p className="mt-0.5 text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
          {formatTime(song.duration)}
        </p>
      </button>
      {liked && <Heart className="h-4 w-4 flex-shrink-0 fill-foreground text-foreground" />}
      {dl === "working" && (
        <span title={`Downloading ${dlProgress}%`} className="flex-shrink-0">
          <svg viewBox="0 0 16 16" className="h-4 w-4 -rotate-90">
            <circle cx="8" cy="8" r="7" fill="none" strokeWidth="2" className="stroke-foreground/15" />
            <circle
              cx="8"
              cy="8"
              r="7"
              fill="none"
              strokeWidth="2"
              strokeLinecap="round"
              className="stroke-foreground"
              strokeDasharray={43.98}
              strokeDashoffset={43.98 * (1 - dlProgress / 100)}
            />
          </svg>
        </span>
      )}
      {dl === "queued" && (
        <span title="Queued — waiting for a download slot" className="flex flex-shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <Clock className="h-4 w-4" />
          Queued
        </span>
      )}
      {dl === "done" && (
        <span title="Downloaded" className="flex flex-shrink-0">
          <Check className="h-4 w-4 text-foreground" />
        </span>
      )}
      {dl === "error" && (
        <button
          type="button"
          title="Retry download"
          aria-label="Retry download"
          onClick={onDownload}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-border/40 text-muted-foreground hover:text-foreground"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      )}
      <div className="relative flex-shrink-0">
        <button
          ref={btnRef}
          type="button"
          aria-label="More actions"
          aria-expanded={open}
          onClick={() => {
            setAnchor("button");
            setOpen((o) => !o);
          }}
          className={`flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground sm:h-9 sm:w-9 ${
            open
              ? "border border-border/40 bg-background/60 backdrop-blur"
              : "border border-transparent bg-transparent hover:border-border/40 hover:bg-background/60 hover:backdrop-blur focus-visible:border-border/40 focus-visible:bg-background/60"
          }`}
        >
          <MoreVertical className="h-4 w-4" />
        </button>
        {createPortal(
          <AnimatePresence>
            {open && (
              <motion.div
                key="song-menu"
                ref={menuRef}
                style={{
                  top: pos.top,
                  ...(pos.left !== undefined ? { left: pos.left } : { right: pos.right ?? 0 }),
                }}
                initial={{ opacity: 0, scale: 0.96, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ type: "spring", stiffness: 400, damping: 35 }}
                className="fixed z-[100] w-48 overflow-hidden rounded-2xl border border-border/50 bg-background/95 p-1.5 shadow-[0_20px_60px_rgba(15,23,42,0.35)] backdrop-blur-2xl"
              >
            <button
              type="button"
              onClick={() => pick(onToggleLike)}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm text-foreground hover:bg-primary/5"
            >
              <Heart
                className={`h-4 w-4 ${liked ? "fill-foreground text-foreground" : ""}`}
              />
              {liked ? "Unlike" : "Like"}
            </button>
            <button
              type="button"
              disabled={
                downloadableDz === null ||
                dl === "working" ||
                dl === "queued" ||
                dl === "done"
              }
              onClick={() => pick(onDownload)}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm text-foreground hover:bg-primary/5 disabled:opacity-40"
            >
              {dl === "done" ? (
                <Check className="h-4 w-4" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {dl === "working"
                ? `Downloading ${dlProgress}%`
                : dl === "queued"
                  ? "Queued"
                  : dl === "done"
                    ? "Downloaded"
                    : dl === "error"
                      ? "Retry download"
                      : "Download"}
            </button>
            <button
              type="button"
              onClick={() => pick(onAddToQueue)}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm text-foreground hover:bg-primary/5"
            >
              <ListPlus className="h-4 w-4" />
              Add to queue
            </button>
            {onDelete !== null && (
              <button
                type="button"
                onClick={() => pick(onDelete)}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm text-foreground hover:bg-primary/5"
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </button>
            )}
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
