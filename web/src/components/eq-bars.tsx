import { cn } from "@/lib/utils";

/**
 * Sound-wave playing indicator: bars bouncing up and down across the
 * full width of the artwork. Runs only while `playing`; freezes (and
 * goes static under prefers-reduced-motion) otherwise.
 * Transform-only animation.
 */
export function EqBars({
  playing,
  count = 14,
  className,
}: {
  playing: boolean;
  count?: number;
  className?: string;
}) {
  const seeds = [0.9, 0.55, 1.15, 0.7, 0.95, 0.5, 1.05, 0.8];
  return (
    <span aria-hidden className={cn("flex h-full w-full items-end gap-0.5", className)}>
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className="eq-bar h-full w-full rounded-full bg-primary max-md:[&:nth-child(3n)]:hidden"
          style={{
            animationDuration: `${seeds[i % seeds.length]}s`,
            animationDelay: `${(i % 5) * 0.11}s`,
            animationPlayState: playing ? "running" : "paused",
          }}
        />
      ))}
    </span>
  );
}

/** Bare Spotify-style waves strip along the artwork's bottom edge. */
export function EqChip({
  playing,
  className,
}: {
  playing: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute inset-x-0 bottom-0 h-2/5 drop-shadow max-md:h-3/5",
        className
      )}
    >
      <EqBars playing={playing} />
    </span>
  );
}
