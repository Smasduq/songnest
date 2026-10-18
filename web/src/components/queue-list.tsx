import { useRef } from "react";
import { motion, Reorder, useDragControls, useMotionValue } from "framer-motion";

import { EmptyState } from "@/components/empty-state";
import { usePlayer, type Song } from "@/player/store";
import { GripVertical, ListMusic, Play } from "lucide-react";

/**
 * Up-next queue: artwork + artist rows that swipe left to remove and
 * drag up/down (grip handle) to reorder. Shared by the desktop sidebar
 * and the mobile sheet.
 */
export function QueueList({
  queue,
  activeId,
  onPlay,
  onRemove,
}: {
  queue: Song[];
  activeId: string | null;
  onPlay: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const reorder = usePlayer((s) => s.setQueueOrder);
  const transientIds = usePlayer((s) => s.transientIds);
  const pendingQueueIds = usePlayer((s) => s.pendingQueueIds);
  const library = usePlayer((s) => s.library);
  const upNextIds = usePlayer((s) => s.upNextIds);
  const visible = pendingQueueIds
    .map((id) => queue.find((track) => track.id === id))
    .filter(
      (track): track is Song =>
        track !== undefined &&
        track.id !== activeId &&
        !transientIds.includes(track.id)
    );
  const upcomingLibrary = upNextIds
    .map((id) => library.find((track) => track.id === id))
    .filter((track): track is Song => track !== undefined && track.id !== activeId);

  if (visible.length === 0 && upcomingLibrary.length === 0) {
    return (
      <EmptyState
        icon={ListMusic}
        variant="inline"
        title="Nothing up next"
        body="Swipe a song right or use ⋯ → Add to queue."
      />
    );
  }

  return (
    <div className="space-y-1.5">
      {visible.length > 0 && (
        <Reorder.Group
          as="ul"
          axis="y"
          values={visible}
          onReorder={(v) => {
            reorder(v);
          }}
          className="space-y-1.5"
        >
          {visible.map((t) => (
            <QueueRow
              key={t.id}
              song={t}
              onPlay={() => onPlay(t.id)}
              onRemove={() => onRemove(t.id)}
            />
          ))}
        </Reorder.Group>
      )}
      {upcomingLibrary.map((song) => (
        <UpcomingLibraryRow
          key={song.id}
          song={song}
          onPlay={() => onPlay(song.id)}
        />
      ))}
    </div>
  );
}

function UpcomingLibraryRow({
  song,
  onPlay,
}: {
  song: Song;
  onPlay: () => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onPlay}
        aria-label={`Play ${song.title}`}
        className="flex w-full items-center gap-2 rounded-2xl border border-border/30 bg-background/50 px-2 py-1.5 text-left"
      >
        <span className="h-8 w-6 flex-shrink-0" aria-hidden />
        <span className="relative h-11 w-11 flex-shrink-0 overflow-hidden rounded-xl border border-border/40 bg-gradient-to-br from-foreground/30 via-foreground/10 to-transparent">
          {song.coverUrl !== "" && (
            <img
              src={song.coverUrl}
              alt={`${song.album} cover`}
              className="h-full w-full object-cover"
              loading="lazy"
              draggable={false}
            />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-foreground">
            {song.title}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            Next from library · {song.artist}
          </span>
        </span>
        <Play className="mr-2 h-4 w-4 flex-shrink-0 fill-foreground text-foreground" aria-hidden />
      </button>
    </div>
  );
}

function QueueRow({
  song,
  onPlay,
  onRemove,
}: {
  song: Song;
  onPlay: () => void;
  onRemove: () => void;
}) {
  const controls = useDragControls();
  const x = useMotionValue(0);
  const swipeCommitAt = useRef(0);
  const downAt = useRef<{ x: number; y: number } | null>(null);
  function tapGuard(e: { clientX: number; clientY: number }): boolean {
    if (Date.now() - swipeCommitAt.current < 500) return true;
    if (downAt.current !== null) {
      const dx = e.clientX - downAt.current.x;
      const dy = e.clientY - downAt.current.y;
      if (Math.hypot(dx, dy) > 12) return true;
    }
    return false;
  }

  return (
    <Reorder.Item
      value={song}
      dragListener={false}
      dragControls={controls}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="relative"
    >
      {/* swipe left removes — no reveal, the row just leaves */}
      <motion.div
        drag="x"
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.15}
        dragDirectionLock
        style={{ x }}
        onPointerDown={(e) => {
          downAt.current = { x: e.clientX, y: e.clientY };
        }}
        onDragEnd={(_, info) => {
          if (info.offset.x < -70 || info.velocity.x < -600) {
            swipeCommitAt.current = Date.now();
            onRemove();
          }
        }}
        className="relative flex touch-pan-y items-center gap-2 rounded-2xl border border-border/30 bg-background/50 px-2 py-1.5"
      >
        {/* drag handle: vertical reorder only starts here */}
        <button
          type="button"
          aria-label={`Reorder ${song.title}`}
          onPointerDown={(e) => controls.start(e)}
          className="flex h-8 w-6 flex-shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-muted-foreground hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            if (!tapGuard(e)) onPlay();
          }}
          className="relative h-11 w-11 flex-shrink-0 overflow-hidden rounded-xl border border-border/40 bg-gradient-to-br from-foreground/30 via-foreground/10 to-transparent"
        >
          {song.coverUrl !== "" && (
            <img
              src={song.coverUrl}
              alt={`${song.album} cover`}
              className="h-full w-full object-cover"
              loading="lazy"
              draggable={false}
            />
          )}
        </button>
        <button
          type="button"
          onClick={(e) => {
            if (!tapGuard(e)) onPlay();
          }}
          className="min-w-0 flex-1 text-left"
        >
          <p className="truncate text-sm font-semibold text-foreground">
            {song.title}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            Queued · {song.artist}
          </p>
        </button>
      </motion.div>
    </Reorder.Item>
  );
}
