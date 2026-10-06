import { Heart, Home, Library, Search, Wrench } from "lucide-react";

export type Page = "home" | "library" | "liked" | "search" | "diagnostics";

interface Props {
  page: Page;
  onNavigate: (page: Page) => void;
  libraryCount: number;
  likedCount: number;
}

const linkCls = (on: boolean) =>
  `flex w-full items-center gap-3 rounded-2xl px-4 py-2.5 text-sm font-medium transition-colors ${
    on
      ? "bg-primary/10 text-primary"
      : "text-muted-foreground hover:bg-primary/5 hover:text-primary"
  }`;

export function Sidebar({
  page,
  onNavigate,
  libraryCount,
  likedCount,
}: Props) {
  return (
    <aside className="scroller flex h-full w-60 flex-shrink-0 flex-col gap-1 rounded-3xl border border-border/40 bg-background/60 p-3 backdrop-blur-xl">
      <button type="button" onClick={() => onNavigate("home")} className={linkCls(page === "home")}>
        <Home className="h-4 w-4" />
        Home
      </button>
      <button type="button" onClick={() => onNavigate("search")} className={linkCls(page === "search")}>
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
        <span className="ml-auto text-xs text-muted-foreground">{libraryCount}</span>
      </button>
      <button
        type="button"
        onClick={() => onNavigate("liked")}
        className={linkCls(page === "liked")}
      >
        <Heart className="h-4 w-4" />
        Liked Songs
        <span className="ml-auto text-xs text-muted-foreground">{likedCount}</span>
      </button>
      <button
        type="button"
        onClick={() => onNavigate("diagnostics")}
        className={linkCls(page === "diagnostics")}
      >
        <Wrench className="h-4 w-4" />
        Diagnostics
      </button>
      <div className="mt-auto px-3 pb-1 pt-4 text-xs leading-relaxed text-muted-foreground">
        Downloads live in your library. Streams play from the server on :8787.
      </div>
    </aside>
  );
}
