/**
 * Prerender step (runs after `vite build` + `vite build --ssr`):
 * renders the app with the SSR bundle and writes the result into
 * dist/index.html, so crawlers and no-JS visitors get the real page.
 * Also writes a sitemap for the single canonical URL of this site.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE_URL = 'https://songnest.smasduq.xyz'

const siteDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ssrEntry = resolve(siteDir, 'dist-ssr/entry-server.js')
const distIndex = resolve(siteDir, 'dist/index.html')

const { render } = await import(ssrEntry)
const appHtml = render()
if (!appHtml.includes('id="hero-heading"')) {
  throw new Error('prerender produced no <h1> — refusing to ship an empty page')
}

const template = readFileSync(distIndex, 'utf8')
const marker = '<div id="root"></div>'
if (!template.includes(marker)) {
  throw new Error(`expected ${marker} in dist/index.html`)
}
writeFileSync(distIndex, template.replace(marker, `<div id="root">${appHtml}</div>`))

const lastmod = new Date().toISOString().slice(0, 10)
writeFileSync(
  resolve(siteDir, 'dist/sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_URL}/</loc>
    <lastmod>${lastmod}</lastmod>
  </url>
</urlset>
`,
)

console.log(`prerendered ${distIndex} (${appHtml.length} bytes of app HTML) + sitemap.xml`)
