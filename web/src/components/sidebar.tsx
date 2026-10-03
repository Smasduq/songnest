import { Heart, Home, Library, Search } from "lucide-react";

export type Page = "home" | "library" | "liked";

interface Props {
  page: Page;
  onNavigate: (page: Page) => void;
  onSearchFocus: () => void;
  libraryCount: number;
  likedCount: number;
}

const linkCls = (on: boolean) =>
  `flex w-full items-center gap-3 rounded-2xl px-4 py-2.5 text-sm font-medium transition-colors ${
    on
      ? "bg-foreground/[0.08] text-foreground"
      : "text-foreground/60 hover:bg-foreground/5 hover:text-foreground"
  }`;

export function Sidebar({
  page,
  onNavigate,
  onSearchFocus,
  libraryCount,
  likedCount,
}: Props) {
  return (
    <aside className="flex h-full w-60 flex-shrink-0 flex-col gap-1 overflow-y-auto rounded-3xl border border-border/40 bg-background/60 p-3 backdrop-blur-xl">
      <button type="button" onClick={() => onNavigate("home")} className={linkCls(page === "home")}>
        <Home className="h-4 w-4" />
        Home
      </button>
      <button type="button" onClick={onSearchFocus} className={linkCls(false)}>
        <Search className="h-4 w-4" />
        Search
      </button>
      <button
        type="button"
        onClick={() => onNavigate("library")}
        className={linkCls(page === "library")}
      >
        <Library className="h-4 w-4" />
        Your Library
        <span className="ml-auto text-xs text-foreground/40">{libraryCount}</span>
      </button>
      <button
        type="button"
        onClick={() => onNavigate("liked")}
        className={linkCls(page === "liked")}
      >
        <Heart className="h-4 w-4" />
        Liked Songs
        <span className="ml-auto text-xs text-foreground/40">{likedCount}</span>
      </button>
      <div className="mt-auto px-3 pb-1 pt-4 text-[11px] leading-relaxed text-foreground/40">
        Downloads live in your library. Streams play from the server on :8787.
      </div>
    </aside>
  );
}
