/**
 * Service worker.
 *
 * Scope is deliberately narrow. This app is useless without its server, so
 * there is no offline story to build — the only goals are installability and
 * not re-downloading the hashed bundle on every launch.
 *
 * Hard rule: never intercept /api or /ws. Caching an auth response or a
 * streamed event would be a correctness bug, not a performance win.
 */
const VERSION = 'vibemobile-v1'
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      // A single missing entry must not fail the whole install.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  // Same-origin only; anything else is not ours to cache.
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return
  if (/^\/r\/[^/]+\/(api|ws)(\/|$)/.test(url.pathname) || url.pathname.startsWith('/runner/')) return

  // Vite emits content-hashed filenames, so these can never go stale.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone()
              caches.open(VERSION).then((cache) => cache.put(request, copy))
            }
            return res
          }),
      ),
    )
    return
  }

  // Navigations and everything else: network first so a redeploy is picked up
  // immediately, falling back to the cached shell when the server is
  // unreachable (phone on the wrong network, server restarting).
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok && request.mode === 'navigate') {
          const copy = res.clone()
          caches.open(VERSION).then((cache) => cache.put('/index.html', copy))
        }
        return res
      })
      .catch(() =>
        caches
          .match(request)
          .then((hit) => hit ?? caches.match('/index.html'))
          .then(
            (hit) =>
              hit ??
              new Response('离线，且没有可用的缓存页面。', {
                status: 503,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' },
              }),
          ),
      ),
  )
})
