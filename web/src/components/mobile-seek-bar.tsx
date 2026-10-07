"use client";

import { usePlayer, useTime } from "@/player/store";

/** In-flow tappable seek bar for the mobile bottom stack. Sits between
 *  the mini player and the navbar; hidden when nothing is playing. */
export function MobileSeekBar() {
  const playing = usePlayer((s) => s.playing);
  const { currentTime, duration } = useTime();
  const st = usePlayer.getState();

  if (!playing || !duration) return null;

  const progress = (currentTime / duration) * 100;

  function seek(clientX: number) {
    const bar = document.getElementById("mobile-seek-bar");
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    st.seekTo(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)));
  }

  return (
    <div className="px-4 py-1.5">
      <div
        id="mobile-seek-bar"
        onClick={(e) => seek(e.clientX)}
        className="h-1.5 cursor-pointer rounded-full bg-foreground/10"
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-foreground to-foreground/40"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}
