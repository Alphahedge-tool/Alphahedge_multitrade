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

import http from 'node:http';

const PORT = Number(process.env.PORT || process.env.BACKEND_PORT || 3001);

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

  const url = new URL(req.url, `http://localhost:${PORT}`);
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

export function start(port = PORT) {
  const server = createServer();
  server.listen(port, () => {
    console.log(`Alphahedge Node backend listening on http://localhost:${port}`);
    console.log(`  health: http://localhost:${port}/api/health`);
    console.log(`  routes: ${[...routes.keys()].sort().join(', ')}`);
  });
  return server;
}

// Note: this file intentionally does NOT register routes or listen on import —
// that would create an import cycle with the route modules (which import these
// helpers) and a top-level await. The entry point is main.js, which imports the
// routes first and then calls start().
