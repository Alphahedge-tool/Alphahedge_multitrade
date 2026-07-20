// Service worker for the AlphaHedge Mini Chain PWA.
//
// Its ONLY job is to make the app installable so the mini chain can run as a
// standalone desktop window with its own taskbar icon. It is deliberately
// conservative about caching:
//
//   • /api and /ws are NEVER cached — this is live market data. A stale premium
//     is worse than no premium, so those always go straight to the network.
//   • Everything else (the JS/CSS bundle) is network-first with a cache
//     fallback, so the window opens fast and a redeploy is picked up on the
//     next load rather than being pinned to an old bundle.

const CACHE = 'alphahedge-shell-v1'

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(caches.open(CACHE))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  // Live data and the market-data socket must never be served from cache.
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Only cache complete, same-origin successes; opaque/partial responses
        // would poison the shell cache.
        if (response.ok && response.type === 'basic') {
          const copy = response.clone()
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {})
        }
        return response
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('/index.html')))
  )
})
