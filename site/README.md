# Songnest site

Static landing page + release downloads for Songnest. Informational only — no music
playback here. Listening happens inside the installed desktop/mobile app.

## Dev

```sh
cd site
npm install
npm run dev
```

## Build

```sh
npm run build   # outputs to dist/
npm run preview
```

## Deploy to Vercel

- Import the repo, set **Root Directory** to `site`, framework preset **Vite**.
- Build command `npm run build`, output `dist` (already in `vercel.json`).
- No env vars needed. Release data loads at runtime from
  `https://api.github.com/repos/Smasduq/songnest/releases` with 1h localStorage cache.
- Update the canonical / OG URLs in `index.html`, `public/sitemap.xml`, and
  `public/robots.txt` if you use a custom domain.

## Notes

- No releases published yet on GitHub (API returns `[]`), so the page shows the
  GitHub fallback state until the first `v0.1.0-alpha.*` tag build runs.
- iOS builds (when present) are unsigned, best-effort — sideloading only.
