import fs from 'node:fs';
import http from 'node:http';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Keep-alive agent so the dev proxy REUSES the TCP connection to the Node
// backend instead of opening (and TLS-less handshaking) a fresh socket per
// request — that per-request connect cost was adding ~200ms to every /api call.
const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });

// The backend prefers 3001 but falls back to the next free port if it is taken,
// and writes whatever it bound to .backend-port. Read that so the dev proxy
// points at the running backend instead of a hardcoded guess.
const PORT_FILE = resolve(__dirname, '.backend-port');

function backendPort() {
  const fromEnv = Number(process.env.VITE_BACKEND_PORT || process.env.BACKEND_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  try {
    const port = Number(fs.readFileSync(PORT_FILE, 'utf8').trim());
    if (Number.isInteger(port) && port > 0) return port;
  } catch {
    /* backend not started yet — fall through to the default */
  }
  return 3001;
}

// Re-point a proxy rule when the backend restarts on a different port, so the
// dev server doesn't have to be restarted alongside it. http-proxy re-reads its
// options object per request, so mutating target is enough.
function followBackendPort(protocol) {
  return (_proxy, options) => {
    fs.watchFile(PORT_FILE, { interval: 1000 }, () => {
      const target = `${protocol}://127.0.0.1:${backendPort()}`;
      if (target !== options.target) {
        options.target = target;
        console.log(`[vite] backend moved — proxying to ${target}`);
      }
    });
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        // 127.0.0.1 (not "localhost") avoids the Windows IPv6-then-IPv4 fallback
        // that added connection latency.
        target: `http://127.0.0.1:${backendPort()}`,
        changeOrigin: true,
        agent: keepAliveAgent,
        configure: followBackendPort('http'),
      },
      // The broker market-data WebSocket (/ws/feed) — ws:true makes Vite forward
      // the HTTP Upgrade handshake to the backend. Without this the browser's
      // /ws/feed socket hangs at "connecting…" because the dev server never
      // upgrades it. No keep-alive agent here: a WS is a long-lived socket.
      '/ws': {
        target: `ws://127.0.0.1:${backendPort()}`,
        ws: true,
        changeOrigin: true,
        configure: followBackendPort('ws'),
      },
    },
  },
  build: {
    // The root (index.html) IS the AlphaHedge Core admin panel — one link.
    // admin.html is kept as an alias to the same app; legacy.html serves the old
    // multi-trade console for reference.
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin.html'),
        legacy: resolve(__dirname, 'legacy.html'),
      },
    },
  },
});
