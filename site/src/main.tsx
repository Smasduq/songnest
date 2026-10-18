import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'

const root = document.getElementById('root')
if (root) {
  // The production build prerenders the page into #root (see scripts/prerender.mjs),
  // so hydrate the server HTML instead of throwing it away. In dev, #root is empty.
  if (root.firstChild) {
    hydrateRoot(
      root,
      <StrictMode>
        <App />
      </StrictMode>,
    )
  } else {
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  }
}
