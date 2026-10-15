import { MicVocal } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { LyricsPanel } from "@/components/lyrics-panel";
import { useCurrentTrack } from "@/player/store";

/**
 * Full lyrics page (desktop). Mobile keeps the compact panel inside the
 * now-playing sheet.
 *
 * Just the lyrics floating over an ambient wash of the current artwork —
 * no header, no song details (now playing already shows those).
 */
export default function LyricsPage() {
  const track = useCurrentTrack();

  if (track === undefined) {
    return (
      <section className="mx-auto w-full max-w-3xl px-1">
        <EmptyState
          icon={MicVocal}
          title="No song playing"
          body="Pick a song and its lyrics land here."
        />
      </section>
    );
  }

  return (
    <section className="relative mx-auto w-full max-w-3xl px-1 pb-8">
      {/* ambient: current artwork as a full-bleed wash behind the lyrics */}
      {track.coverUrl !== "" && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden"
        >
          <img
            key={track.coverUrl}
            src={track.coverUrl}
            alt=""
            draggable={false}
            className="h-full w-full scale-125 object-cover opacity-20 blur-3xl saturate-150"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-background via-background/20 to-background" />
          <div className="absolute inset-0 bg-gradient-to-r from-background via-transparent to-background" />
        </div>
      )}

      <div className="relative">
        <LyricsPanel
          track={track}
          size="large"
          scrollClassName="max-h-[70vh]"
        />
      </div>
    </section>
  );
}
