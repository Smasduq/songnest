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
  // play-now placeholders never appear: only explicitly added songs do
  const visible = queue.filter((t) => !transientIds.includes(t.id));

  if (visible.length === 0) {
    return (
      <EmptyState
        icon={ListMusic}
        variant="inline"
        title="Queue is empty"
        body="Swipe a song right or use ⋯ → Add to queue."
      />
    );
  }

  return (
    <Reorder.Group
      as="ul"
      axis="y"
      values={visible}
      onReorder={(v) => {
        // keep placeholders pinned at the head, reorder the rest
        const pinned = queue.filter((t) => transientIds.includes(t.id));
        reorder([...pinned, ...v]);
      }}
      className="space-y-1.5"
    >
      {visible.map((t) => (
        <QueueRow
          key={t.id}
          song={t}
          active={t.id === activeId}
          onPlay={() => onPlay(t.id)}
          onRemove={() => onRemove(t.id)}
        />
      ))}
    </Reorder.Group>
  );
}

function QueueRow({
  song,
  active,
  onPlay,
  onRemove,
}: {
  song: Song;
  active: boolean;
  onPlay: () => void;
  onRemove: () => void;
}) {
  const controls = useDragControls();
  const x = useMotionValue(0);

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
        onDragEnd={(_, info) => {
          if (info.offset.x < -70 || info.velocity.x < -600) onRemove();
        }}
        className={`relative flex touch-pan-y items-center gap-2 rounded-2xl border px-2 py-1.5 ${
          active
            ? "border-primary/40 bg-primary/10"
            : "border-border/30 bg-background/50"
        }`}
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
          onClick={onPlay}
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
          {active && (
            <span
              aria-hidden
              className="absolute inset-0 flex items-center justify-center bg-background/50"
            >
              <Play className="h-4 w-4 fill-foreground text-foreground" />
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
            {song.artist}
          </p>
        </button>
      </motion.div>
    </Reorder.Item>
  );
}
