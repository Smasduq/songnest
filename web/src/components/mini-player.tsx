import { motion } from "framer-motion";

import { Button } from "@/components/ui/button";
import { Marquee } from "@/components/marquee";
import { useCurrentTrack, usePlayer } from "@/player/store";
import { Loader2, Pause, Play } from "lucide-react";

export function MiniPlayer({ onOpen }: { onOpen: () => void }) {
  const track = useCurrentTrack();
  const playing = usePlayer((s) => s.playing);
  const resolving = usePlayer((s) => s.resolving);
  if (track === undefined) return null;
  const st = usePlayer.getState();

  return (
    <motion.div
      data-testid="mini-player"
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 24 }}
      transition={{ type: "spring", stiffness: 400, damping: 35 }}
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.25}
      onDragEnd={(_, info) => {
        if (info.offset.x < -80) st.next(true);
        else if (info.offset.x > 80) st.prev();
      }}
      className="flex min-w-0 max-w-full flex-1 flex-shrink-0 cursor-grab items-center gap-3 rounded-2xl py-1 pl-1 pr-2 active:cursor-grabbing"
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        {track.coverUrl !== "" && (
          <img
            src={track.coverUrl}
            alt=""
            className="h-11 w-11 flex-shrink-0 rounded-2xl border border-border/40 object-cover"
          />
        )}
        <span className="min-w-0 flex-1">
          <Marquee
            text={track.title}
            className="text-sm font-semibold text-foreground"
          />
          {resolving ? (
            <span
              role="status"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground"
            >
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              Finding the song…
            </span>
          ) : (
            <Marquee
              text={track.artist}
              className="text-xs text-muted-foreground"
            />
          )}
        </span>
      </button>
      <Button
        onClick={() => st.toggle()}
        className="h-10 w-10 flex-shrink-0 rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
      >
        {playing ? (
          <Pause className="h-4 w-4" />
        ) : (
          <Play className="h-4 w-4" />
        )}
      </Button>
    </motion.div>
  );
}
