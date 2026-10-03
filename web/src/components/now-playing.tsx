import { Button } from "@/components/ui/button";
import { formatTime, type Song } from "@/lib/api";
import { Download, Heart, ListMusic, X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

interface Props {
  track: Song | undefined;
  liked: boolean;
  downloadable: boolean;
  downloading: boolean;
  onToggleLike: () => void;
  onDownload: () => void;
  queue: Song[];
  activeQueueId: string | null;
  onRemoveFromQueue: (id: string) => void;
  onPlayQueued: (id: string) => void;
  onNext: () => void;
  onPrev: () => void;
}

export function NowPlaying({
  track,
  liked,
  downloadable,
  downloading,
  onToggleLike,
  onDownload,
  queue,
  activeQueueId,
  onRemoveFromQueue,
  onPlayQueued,
  onNext,
  onPrev,
}: Props) {
  return (
    <aside className="scroller hidden h-full w-80 flex-shrink-0 flex-col gap-4 rounded-3xl border border-border/40 bg-background/60 p-5 backdrop-blur-xl xl:flex">
      <h2 className="text-sm font-semibold tracking-wide text-foreground/80">
        Now playing
      </h2>
      {track !== undefined ? (
        <div className="space-y-4">
          {track.coverUrl !== "" ? (
            <motion.img
              src={track.coverUrl}
              alt={`${track.album} cover`}
              drag="x"
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.25}
              onDragEnd={(_, info) => {
                if (info.offset.x < -80) onNext();
                else if (info.offset.x > 80) onPrev();
              }}
              className="aspect-square w-full cursor-grab rounded-2xl border border-border/40 object-cover active:cursor-grabbing"
            />
          ) : (
            <div className="aspect-square w-full rounded-2xl border border-border/40 bg-gradient-to-br from-foreground/30 via-foreground/10 to-transparent" />
          )}
          <div>
            <p className="truncate text-lg font-semibold text-foreground">
              {track.title}
            </p>
            <p className="truncate text-sm text-foreground/60">
              {track.artist} · {track.album}
            </p>
            <p className="mt-1 text-xs uppercase tracking-[0.2em] text-foreground/50">
              {formatTime(track.duration)}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onToggleLike}
              className="h-9 flex-1 rounded-full"
            >
              <Heart
                className={`h-4 w-4 ${liked ? "fill-foreground" : ""}`}
              />
              {liked ? "Liked" : "Like"}
            </Button>
            {downloadable && (
              <Button
                variant="outline"
                size="sm"
                disabled={downloading}
                onClick={onDownload}
                className="h-9 flex-1 rounded-full"
              >
                <Download className="h-4 w-4" />
                {downloading ? "Working…" : "Download"}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-foreground/50">
          Pick a song to start listening.
        </p>
      )}

      <div className="space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold tracking-wide text-foreground/80">
          <ListMusic className="h-4 w-4" />
          Up next
        </h3>
        {queue.length === 0 ? (
          <p className="text-xs text-foreground/50">
            Queue is empty — use ⋯ → Add to queue on any song.
          </p>
        ) : (
          <ul className="space-y-1.5">
            <AnimatePresence initial={false}>
              {queue.map((t) => (
                <motion.li
                  key={t.id}
                  layout
                  initial={{ opacity: 0, x: 24 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 24 }}
                  transition={{ duration: 0.18 }}
                className={`flex items-center gap-2 rounded-2xl border px-3 py-2 ${
                  t.id === activeQueueId
                    ? "border-foreground/40 bg-foreground/[0.08]"
                    : "border-border/30 bg-background/50"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onPlayQueued(t.id)}
                  className="min-w-0 flex-1 truncate text-left text-xs text-foreground/85"
                >
                  {t.title} · {t.artist}
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${t.title}`}
                  onClick={() => onRemoveFromQueue(t.id)}
                  className="text-foreground/40 hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </aside>
  );
}
