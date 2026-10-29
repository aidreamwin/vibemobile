import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './styles.css'
import App from './App'
import { runnerBase } from './lib/runner'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={runnerBase || '/'}>
      <App />
    </BrowserRouter>
  </StrictMode>,
)

// Registering the service worker is what makes "add to home screen" produce a
// standalone app rather than a bookmark. Skipped in dev: a worker caching
// Vite's dev-server responses causes stale-module confusion that costs far
// more than it saves.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // A failed SW registration must never break the app.
    })
  })
}
