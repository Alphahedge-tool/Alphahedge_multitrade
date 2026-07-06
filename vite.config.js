import http from 'node:http';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Keep-alive agent so the dev proxy REUSES the TCP connection to the Node
// backend instead of opening (and TLS-less handshaking) a fresh socket per
// request — that per-request connect cost was adding ~200ms to every /api call.
const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        // 127.0.0.1 (not "localhost") avoids the Windows IPv6-then-IPv4 fallback
        // that added connection latency.
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
        agent: keepAliveAgent,
      },
      // The broker market-data WebSocket (/ws/feed) — ws:true makes Vite forward
      // the HTTP Upgrade handshake to the backend. Without this the browser's
      // /ws/feed socket hangs at "connecting…" because the dev server never
      // upgrades it. No keep-alive agent here: a WS is a long-lived socket.
      '/ws': {
        target: 'ws://127.0.0.1:3001',
        ws: true,
        changeOrigin: true,
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
