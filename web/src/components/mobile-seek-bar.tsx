"use client";

import { SeekBar } from "@/components/seek-bar";
import { usePlayer, useTime } from "@/player/store";

/** In-flow tappable seek bar for the mobile bottom stack. Sits between
 *  the mini player and the navbar; hidden when nothing is playing. */
export function MobileSeekBar() {
  const playing = usePlayer((s) => s.playing);
  const { currentTime, duration } = useTime();
  const st = usePlayer.getState();

  if (!playing || !duration) return null;

  return (
    <div className="px-4 py-1.5">
      <SeekBar
        value={currentTime / duration}
        duration={duration}
        onSeek={(r) => st.seekTo(r)}
        barClassName="h-1.5 bg-foreground/10"
        fillClassName="bg-gradient-to-r from-foreground to-foreground/40"
      />
    </div>
  );
}
