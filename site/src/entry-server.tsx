/**
 * Server entry used only at build time: renders <App /> to an HTML string so
 * the landing page ships real content (headings, text, links) instead of an
 * empty #root div. See scripts/prerender.mjs.
 */
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import App from './App.tsx'

export function render(): string {
  return renderToString(createElement(App))
}
