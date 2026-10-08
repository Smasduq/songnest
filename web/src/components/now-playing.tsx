import { BurstButton } from "@/components/burst-button";
import { EmptyState } from "@/components/empty-state";
import { QueueList } from "@/components/queue-list";
import { formatTime, type Song } from "@/lib/api";
import { Marquee } from "@/components/marquee";
import { Download, Heart, ListMusic, Loader2, Music, RefreshCw } from "lucide-react";
import { motion } from "framer-motion";

interface Props {
  track: Song | undefined;
  resolving: boolean;
  buffering: boolean;
  liked: boolean;
  downloadable: boolean;
  downloading: boolean;
  onToggleLike: () => void;
  onRetryMatch: () => void;
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
  resolving,
  buffering,
  liked,
  downloadable,
  downloading,
  onToggleLike,
  onRetryMatch,
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
            <Marquee
              text={track.title}
              className="text-lg font-semibold text-foreground"
            />
            <Marquee
              text={`${track.artist} · ${track.album}`}
              className="text-sm text-muted-foreground"
            />
            {resolving || buffering ? (
              <p
                role="status"
                className="mt-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                {resolving ? "Finding the song…" : "Getting the song ready…"}
              </p>
            ) : (
              <p className="mt-1 text-xs uppercase tracking-[0.2em] text-muted-foreground">
                {formatTime(track.duration)}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <BurstButton
              layout="pill"
              label={liked ? "Unlike" : "Like"}
              pressed={liked}
              burstOn="activate"
              onAction={onToggleLike}
              idleIcon={
                <Heart
                  className={`h-4 w-4 ${liked ? "fill-foreground" : ""}`}
                  aria-hidden
                />
              }
              text={liked ? "Liked" : "Like"}
              particleClassName="bg-rose-500"
              ringClassName="border-rose-500"
            />
            {downloadable && (
              <BurstButton
                layout="pill"
                label="Download"
                busyLabel="Downloading"
                busy={downloading}
                onAction={onDownload}
                idleIcon={<Download className="h-4 w-4" aria-hidden />}
                text="Download"
                busyText="Working…"
              />
            )}
          </div>
          {downloadable && !resolving && (
            <button
              type="button"
              onClick={onRetryMatch}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              Not the right song? Try another match
            </button>
          )}
        </div>
      ) : (
        <EmptyState
          icon={Music}
          variant="inline"
          title="Pick a song to start listening"
        />
      )}

      <div className="space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold tracking-wide text-muted-foreground">
          <ListMusic className="h-4 w-4" />
          Up next
        </h3>
        <QueueList
          queue={queue}
          activeId={activeQueueId}
          onPlay={onPlayQueued}
          onRemove={onRemoveFromQueue}
        />
      </div>
    </aside>
  );
}
