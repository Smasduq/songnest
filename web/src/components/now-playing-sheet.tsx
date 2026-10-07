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
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";

export function NowPlayingSheet({ onClose }: { onClose: () => void }) {
  const track = useCurrentTrack();
  const playing = usePlayer((s) => s.playing);
  const repeat = usePlayer((s) => s.repeat);
  const shuffle = usePlayer((s) => s.shuffle);
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const { currentTime, duration } = useTime();
  const [showQueue, setShowQueue] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const volRef = useRef<HTMLDivElement>(null);
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

  // volume slider (same click-to-set bar as the PC player bar)
  function setVol(clientX: number) {
    const bar = volRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    st.setVolume(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)));
  }

  function nudgeVol(delta: number) {
    // setVolume unmutes by itself when the level is above 0
    st.setVolume(Math.min(1, Math.max(0, (muted ? 0 : volume) + delta)));
  }

  // swipe-down anywhere except controls, seek bar, and the queue list
  // starts the dismiss drag (buttons still tap fine when nothing moves)
  function maybeStartDismiss(e: React.PointerEvent) {
    const t = e.target as HTMLElement | null;
    if (t !== null && t.closest("button, input, a, [data-no-dismiss-drag]") !== null) return;
    controls.start(e);
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
        onPointerDown={maybeStartDismiss}
        className="fixed inset-x-0 bottom-0 top-10 z-[90] flex flex-col gap-4 overflow-hidden rounded-t-3xl border border-border/40 bg-background/95 px-6 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] backdrop-blur-2xl"
      >
        {/* drag handle (section-level swipe handles it too) */}
        <div className="flex cursor-grab touch-none justify-center pb-1 pt-3 active:cursor-grabbing">
          <span className="h-1.5 w-12 rounded-full bg-muted" />
        </div>

        <div className="flex touch-none select-none items-center justify-between">
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
          // scrolls only when the content is taller than the sheet
          <div
            data-no-dismiss-drag
            className="scroller min-h-0 flex-1 space-y-4 pb-4"
          >
            {track.coverUrl !== "" ? (
              <img
                src={track.coverUrl}
                alt={`${track.album} cover`}
                width={640}
                height={640}
                draggable={false}
                className="mx-auto aspect-square w-full max-w-sm flex-shrink select-none rounded-3xl border border-border/40 object-cover"
              />
            ) : (
              <div className="mx-auto aspect-square w-full max-w-sm select-none rounded-3xl border border-border/40 bg-gradient-to-br from-foreground/30 via-foreground/10 to-transparent" />
            )}

            <div className="select-none text-center">
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
                data-no-dismiss-drag
                onClick={(e) => seek(e.clientX)}
                className="h-2 w-full cursor-pointer rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-gradient-to-r from-primary to-primary/40 will-change-transform"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>

            <div className="flex items-center justify-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => st.toggleShuffle()}
                title={shuffle ? "Shuffle on" : "Shuffle off"}
                aria-label={shuffle ? "Shuffle on" : "Shuffle off"}
                aria-pressed={shuffle}
                className={`h-11 w-11 rounded-full hover:text-foreground ${
                  shuffle ? "text-foreground" : "text-muted-foreground"
                }`}
              >
                <Shuffle className="h-5 w-5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => st.prev()}
                aria-label="Previous track"
                className="h-11 w-11 rounded-full text-foreground/80 hover:text-foreground"
              >
                <SkipBack className="h-5 w-5" />
              </Button>
              <Button
                onClick={() => st.toggle()}
                aria-label={playing ? "Pause" : "Play"}
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
                aria-label="Next track"
                className="h-11 w-11 rounded-full text-muted-foreground hover:text-foreground"
              >
                <SkipForward className="h-5 w-5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => st.cycleRepeat()}
                title={`Repeat: ${repeat}`}
                aria-label={`Repeat: ${repeat}`}
                className={`h-11 w-11 rounded-full hover:text-foreground ${
                  repeat === "off" ? "text-muted-foreground" : "text-foreground"
                }`}
              >
                {repeat === "one" ? (
                  <Repeat1 className="h-5 w-5" />
                ) : (
                  <Repeat className="h-5 w-5" />
                )}
              </Button>
            </div>
            {/* volume: mute toggle + slider + keyboard stepping */}
            <div className="flex items-center justify-center gap-2 px-6">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => st.toggleMute()}
                title={muted ? "Unmute" : "Mute"}
                aria-label={muted ? "Unmute" : "Mute"}
                aria-pressed={muted}
                className="h-9 w-9 flex-shrink-0 rounded-full text-muted-foreground hover:text-foreground"
              >
                {muted || volume === 0 ? (
                  <VolumeX className="h-4 w-4" />
                ) : (
                  <Volume2 className="h-4 w-4" />
                )}
              </Button>
              <div
                ref={volRef}
                role="slider"
                tabIndex={0}
                aria-label="Volume"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round((muted ? 0 : volume) * 100)}
                data-no-dismiss-drag
                onClick={(e) => setVol(e.clientX)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
                    e.preventDefault();
                    nudgeVol(-0.05);
                  } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
                    e.preventDefault();
                    nudgeVol(0.05);
                  } else if (e.key === "Home") {
                    e.preventDefault();
                    st.setVolume(0);
                  } else if (e.key === "End") {
                    e.preventDefault();
                    st.setVolume(1);
                  }
                }}
                className="h-2 flex-1 cursor-pointer rounded-full bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                <div
                  className="h-full rounded-full bg-gradient-to-r from-primary to-primary/40"
                  style={{ width: `${(muted ? 0 : volume) * 100}%` }}
                />
              </div>
              <span className="w-10 flex-shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {Math.round((muted ? 0 : volume) * 100)}
              </span>
            </div>
            <div className="flex items-center justify-center">
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
              <div className="space-y-1.5">
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
          </div>
        ) : (
          <p className="py-16 text-center text-muted-foreground">
            Nothing playing yet.
          </p>
        )}
      </motion.section>
    </>
  );
}
