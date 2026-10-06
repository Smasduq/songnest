import { useEffect, useRef, useState } from "react";
import { motion, useDragControls } from "framer-motion";

import { Button } from "@/components/ui/button";
import { formatTime } from "@/lib/api";
import { useCurrentTrack, usePlayer, useTime } from "@/player/store";
import {
  ChevronDown,
  ListMusic,
  Pause,
  Play,
  Repeat,
  Repeat1,
  SkipBack,
  SkipForward,
  X,
} from "lucide-react";

export function NowPlayingSheet({ onClose }: { onClose: () => void }) {
  const track = useCurrentTrack();
  const playing = usePlayer((s) => s.playing);
  const repeat = usePlayer((s) => s.repeat);
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const { currentTime, duration } = useTime();
  const [showQueue, setShowQueue] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const controls = useDragControls();
  const st = usePlayer.getState();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function seek(clientX: number) {
    const bar = barRef.current;
    if (!bar || !duration) return;
    const rect = bar.getBoundingClientRect();
    st.seekTo(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)));
  }

  function dismiss(_: unknown, info: { offset: { y: number }; velocity: { y: number } }) {
    if (
      info.offset.y > window.innerHeight * 0.25 ||
      info.velocity.y > 600
    ) {
      onClose();
    }
    // otherwise the constraints spring it back automatically
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={onClose}
        className="fixed inset-0 z-[80] bg-background/60 backdrop-blur-sm"
      />
      <motion.section
        data-testid="now-playing-sheet"
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", stiffness: 400, damping: 35 }}
        drag="y"
        dragListener={false}
        dragControls={controls}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={0.3}
        onDragEnd={dismiss}
        className="fixed inset-x-0 bottom-0 top-10 z-[90] flex flex-col gap-4 overflow-hidden rounded-t-3xl border border-border/40 bg-background/95 px-6 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] backdrop-blur-2xl"
      >
        {/* drag handle: only this strip starts the dismiss gesture */}
        <div
          onPointerDown={(e) => controls.start(e)}
          className="flex cursor-grab touch-none justify-center pb-1 pt-3 active:cursor-grabbing"
        >
          <span className="h-1.5 w-12 rounded-full bg-muted" />
        </div>

        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close player"
            className="h-9 w-9 rounded-full text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className="h-5 w-5" />
          </Button>
          <p className="text-xs font-medium uppercase tracking-[0.25em] text-muted-foreground">
            Now playing
          </p>
          <span className="w-9" />
        </div>

        {track !== undefined ? (
          <>
            {track.coverUrl !== "" ? (
              <img
                src={track.coverUrl}
                alt={`${track.album} cover`}
                width={640}
                height={640}
                className="mx-auto aspect-square w-full max-w-sm flex-shrink rounded-3xl border border-border/40 object-cover"
              />
            ) : (
              <div className="mx-auto aspect-square w-full max-w-sm rounded-3xl border border-border/40 bg-gradient-to-br from-foreground/30 via-foreground/10 to-transparent" />
            )}

            <div className="text-center">
              <h2 className="truncate text-2xl font-semibold tracking-tight text-foreground">
                {track.title}
              </h2>
              <p className="truncate text-base text-muted-foreground">
                {track.artist} · {track.album}
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs tabular-nums text-muted-foreground">
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(duration || track.duration)}</span>
              </div>
              <div
                ref={barRef}
                onClick={(e) => seek(e.clientX)}
                className="h-2 w-full cursor-pointer rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-gradient-to-r from-primary to-primary/40 will-change-transform"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>

            <div className="flex items-center justify-center gap-5">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => st.prev()}
                className="h-11 w-11 rounded-full text-foreground/80 hover:text-foreground"
              >
                <SkipBack className="h-5 w-5" />
              </Button>
              <Button
                onClick={() => st.toggle()}
                className="h-14 w-14 rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {playing ? (
                  <Pause className="h-6 w-6" />
                ) : (
                  <Play className="h-6 w-6" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => st.next(true)}
                className="h-11 w-11 rounded-full text-muted-foreground hover:text-foreground"
              >
                <SkipForward className="h-5 w-5" />
              </Button>
            </div>

            <div className="flex items-center justify-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => st.cycleRepeat()}
                className={`h-9 rounded-full px-4 text-xs uppercase tracking-[0.2em] ${
                  repeat === "off"
                    ? "text-muted-foreground"
                    : "text-foreground"
                }`}
              >
                {repeat === "one" ? (
                  <Repeat1 className="h-4 w-4" />
                ) : (
                  <Repeat className="h-4 w-4" />
                )}
                {repeat === "off" ? "Repeat off" : `Repeat ${repeat}`}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowQueue((v) => !v)}
                className="h-9 rounded-full px-4 text-xs uppercase tracking-[0.2em] text-muted-foreground"
              >
                <ListMusic className="h-4 w-4" />
                Queue ({queue.length})
              </Button>
            </div>

            {showQueue && (
              <div className="scroller min-h-0 flex-1 space-y-1.5 pb-4">
                {queue.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Queue is empty — swipe a song right or use ⋯ → Add to
                    queue.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {queue.map((t, i) => (
                      <li
                        key={t.id}
                        className={`flex items-center gap-2 rounded-2xl border px-3 py-2 ${
                          i === index
                            ? "border-primary/40 bg-primary/10"
                            : "border-border/30 bg-background/50"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => st.playTrack(t)}
                          className="min-w-0 flex-1 truncate text-left text-sm text-foreground"
                        >
                          {t.title} · {t.artist}
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove ${t.title}`}
                          onClick={() => st.removeFromQueue(t.id)}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        ) : (
          <p className="py-16 text-center text-muted-foreground">
            Nothing playing yet.
          </p>
        )}
      </motion.section>
    </>
  );
}
