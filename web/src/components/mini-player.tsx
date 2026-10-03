import { motion } from "framer-motion";

import { Button } from "@/components/ui/button";
import { useCurrentTrack, usePlayer } from "@/player/store";
import { Pause, Play } from "lucide-react";

export function MiniPlayer({ onOpen }: { onOpen: () => void }) {
  const track = useCurrentTrack();
  const playing = usePlayer((s) => s.playing);
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
      className="flex flex-shrink-0 cursor-grab items-center gap-3 rounded-2xl py-1 pl-1 pr-2 active:cursor-grabbing"
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
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-foreground/90">
            {track.title}
          </span>
          <span className="block truncate text-xs text-foreground/60">
            {track.artist}
          </span>
        </span>
      </button>
      <Button
        onClick={() => st.toggle()}
        className="h-10 w-10 flex-shrink-0 rounded-full bg-foreground text-background hover:bg-foreground/90"
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
