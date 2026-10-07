import { WifiOff, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Spotify-style empty / offline state.
 *
 * Tokens (see spotify-ui-skills): surface-base #171717 (page, dark),
 * surface-overlay #010002 (badge + focus), raised #FEFEFE, 4px grid
 * (gap-5 / px-8 / py-16), radius scale (24px badge, 15px default,
 * 22px+ pills), Inter primary, heading 41px/500 text-balance (hero),
 * body 13px/400 text-pretty, focus 2px + 2px offset, disabled 0.5.
 * Animations: none (transform/opacity only if ever added, <=200ms).
 */
export function EmptyState({
  icon: Icon,
  title,
  body,
  detail,
  actionLabel,
  onAction,
  variant = "hero",
  className,
}: {
  icon: LucideIcon;
  title: string;
  body?: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
  variant?: "hero" | "inline";
  className?: string;
}) {
  const hero = variant === "hero";
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-center justify-center text-center",
        hero ? "gap-5 px-8 py-16" : "gap-2 px-4 py-8",
        className,
      )}
      style={{ fontFamily: 'Inter, -apple-system, system-ui, sans-serif' }}
    >
      <span
        aria-hidden
        className={cn(
          "flex items-center justify-center border",
          hero ? "size-16 rounded-[24px]" : "size-10 rounded-[15px]",
          // Near-black badge: #010002 overlay token; #FEFEFE icon (~20:1).
          "border-[#838486]/40 bg-[#010002] text-[#FEFEFE]",
        )}
      >
        <Icon className={hero ? "size-8" : "size-5"} strokeWidth={1.75} />
      </span>
      <h3
        className={cn("text-balance", hero ? null : "text-sm font-semibold")}
        style={
          hero
            ? { fontSize: "clamp(20px, 5vw, 24px)", fontWeight: 600, lineHeight: 1.2 }
            : undefined
        }
      >
        {title}
      </h3>
      {body !== undefined && (
        <p
          className="max-w-sm text-pretty text-muted-foreground"
          style={{ fontSize: 13, fontWeight: 400 }}
        >
          {body}
        </p>
      )}
      {detail !== undefined && (
        <p
          className="max-w-sm text-pretty tabular-nums text-muted-foreground/80"
          style={{ fontSize: 13, fontWeight: 400 }}
        >
          {detail}
        </p>
      )}
      {actionLabel !== undefined && onAction !== undefined && (
        <Button
          type="button"
          onClick={onAction}
          className="mt-1 h-9 rounded-full px-4 text-xs outline-2 outline-offset-2"
        >
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

/** Big centered offline state: "Bro, you are offline". */
export function OfflineState({
  detail,
  onRetry,
  className,
}: {
  detail?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <EmptyState
      icon={WifiOff}
      title="Bro, you are offline"
      body="Check your connection and try again."
      detail={detail}
      actionLabel={onRetry !== undefined ? "Retry" : undefined}
      onAction={onRetry}
      className={className}
    />
  );
}
