// Alphahedge Node backend — plain node:http, zero dependencies.
//
// Serves the same /api/* routes the React frontend already calls (the Go backend
// defines the shape), so the frontend needs no changes: point Vite's proxy /
// .env at this server's port and it just works.
//
// This file is Step 1: the server skeleton only — CORS, JSON helpers, a route
// table, and /api/health. Broker routes are registered in later steps.
//
// Run: node --env-file-if-exists=.env node-backend/server.js

import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || process.env.BACKEND_PORT || 3001);

// If the preferred port is taken (a stale backend, another app), walk upwards to
// the next free one instead of dying with EADDRINUSE. Set PORT_STRICT=1 to keep
// the old behaviour and fail hard.
const PORT_TRIES = Number(process.env.PORT_TRIES || 20);
const PORT_STRICT = /^(1|true|yes)$/i.test(process.env.PORT_STRICT || '');

// The port actually bound. Everything that needs to build a self-URL (OAuth
// redirect URIs, logs) must read this, not PORT — they can differ.
let boundPort = PORT;
export function getPort() {
  return boundPort;
}

// Vite's dev proxy and any tooling discover the live port through this file, so
// a shifted port doesn't mean hand-editing configs.
const PORT_FILE = fileURLToPath(new URL('../.backend-port', import.meta.url));

function publishPort(port) {
  try {
    fs.writeFileSync(PORT_FILE, String(port));
  } catch (err) {
    console.warn(`Could not write ${PORT_FILE}: ${err.message}`);
    return;
  }

  // Only remove the file if it still names OUR port — a newer backend may have
  // claimed it while this one was shutting down.
  const cleanup = () => {
    try {
      if (fs.readFileSync(PORT_FILE, 'utf8').trim() === String(port)) fs.unlinkSync(PORT_FILE);
    } catch {
      /* already gone — nothing to clean up */
    }
  };

  process.on('exit', cleanup);
  // Signals don't run 'exit' handlers on their own, and Ctrl-C is how this
  // server is normally stopped.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      cleanup();
      process.exit(0);
    });
  }
}

// --- Route table -------------------------------------------------------------
// Keyed by "METHOD /path". Handlers are async (req, res, ctx) => any. Returning
// a value JSON-encodes it with 200; throw an ApiError to control the status.
const routes = new Map();

export function route(method, path, handler) {
  routes.set(`${method.toUpperCase()} ${path}`, handler);
}

// ApiError lets a handler set the HTTP status of a failure (defaults to 500).
export class ApiError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// --- helpers -----------------------------------------------------------------

// readJSON buffers and parses a JSON request body. Empty body -> {}. A malformed
// body is a 400 so a bad client never crashes the server.
export async function readJSON(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new ApiError('Request body too large', 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError('Invalid JSON body', 400);
  }
}

function writeJSON(res, status, body) {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

// CORS parity with the Go backend's withCORS: permissive, handles preflight.
function applyCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-device-id');
}

function errBody(err) {
  return { status: false, message: err?.message || 'Internal error' };
}

// --- request dispatch --------------------------------------------------------

async function handle(req, res) {
  applyCORS(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${boundPort}`);
  const key = `${req.method} ${url.pathname}`;
  const handler = routes.get(key);

  if (!handler) {
    return writeJSON(res, 404, { status: false, message: `No route for ${key}` });
  }

  try {
    const result = await handler(req, res, { url, query: url.searchParams });
    // A handler that wrote the response itself (e.g. streaming) returns
    // undefined and we leave it alone; otherwise JSON-encode its return value.
    if (result !== undefined && !res.writableEnded) writeJSON(res, 200, result);
  } catch (err) {
    if (res.writableEnded) return;
    const status = err instanceof ApiError ? err.status : err?.status || 500;
    writeJSON(res, Number.isInteger(status) ? status : 500, errBody(err));
  }
}

// --- built-in routes ---------------------------------------------------------

route('GET', '/api/health', () => ({ status: true, service: 'alphahedge-node', ts: Date.now() }));

// --- server ------------------------------------------------------------------

export function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.writableEnded) writeJSON(res, 500, errBody(err));
    });
  });
}

// start binds the preferred port, or — if it is occupied — the next free port
// above it (up to PORT_TRIES attempts). The server object is returned
// synchronously so callers can attach the WebSocket upgrade handler right away;
// the retries happen on the same object, before it is ever listening.
export function start(port = PORT) {
  const server = createServer();
  const first = port;
  let attempt = 0;

  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE' || PORT_STRICT || attempt >= PORT_TRIES - 1) {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${first + attempt} is in use and no free port was found. ` +
          'Free it, or set PORT / PORT_TRIES.');
      }
      throw err;
    }
    attempt += 1;
    const next = first + attempt;
    console.warn(`Port ${first + attempt - 1} in use — trying ${next}…`);
    server.listen(next);
  });

  server.on('listening', () => {
    boundPort = server.address().port;
    publishPort(boundPort);
    console.log(`Alphahedge Node backend listening on http://localhost:${boundPort}`);
    console.log(`  health: http://localhost:${boundPort}/api/health`);
    if (boundPort !== first) {
      console.warn(`  note: port ${first} was busy. Broker OAuth redirect URIs registered ` +
        `against ${first} will not match — set ZERODHA_REDIRECT_URI / UPSTOX_REDIRECT_URI ` +
        'if you need the OAuth flow on this port.');
    }
    console.log(`  routes: ${[...routes.keys()].sort().join(', ')}`);
  });

  server.listen(first);
  return server;
}

// Note: this file intentionally does NOT register routes or listen on import —
// that would create an import cycle with the route modules (which import these
// helpers) and a top-level await. The entry point is main.js, which imports the
// routes first and then calls start().
