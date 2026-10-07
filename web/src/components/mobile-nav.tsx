"use client";

import { Home, Search, Library, Heart } from "lucide-react";

import { type Page } from "@/components/sidebar";

interface Props {
  page: Page;
  onNavigate: (page: Page) => void;
  className?: string;
}

export function MobileNav({ page, onNavigate, className }: Props) {
  const tabs = [
    { id: "home", label: "Home", icon: Home },
    { id: "search", label: "Search", icon: Search },
    { id: "library", label: "Library", icon: Library },
    { id: "liked", label: "Liked", icon: Heart },
  ] as const;

  return (
    <nav className={`flex items-center justify-around px-2 py-1 ${className ?? ""}`}>
      {tabs.map((item) => {
        const Icon = item.icon;
        const on = page === item.id;
        const tabClassName =
          "flex flex-col items-center gap-1 rounded-2xl px-3 py-2 text-xs font-medium " +
          (on ? "text-foreground" : "text-muted-foreground");
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onNavigate(item.id)}
            className={tabClassName}
          >
            <Icon className="h-5 w-5" />
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}