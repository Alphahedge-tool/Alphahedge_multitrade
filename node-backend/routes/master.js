// /api/master/* — the global instrument master (symtoken) API.
//   GET  /api/master/status                         -> what's loaded per broker
//   POST /api/master/refresh   {broker?, force?}     -> reload public masters
//   POST /api/master/refresh-session {broker, ...}   -> reload Nubra/Kotak (needs session creds)
//   GET  /api/master/resolve?symbol=&exchange=&broker= -> one broker's token
//   GET  /api/master/route?symbol=&exchange=          -> ALL brokers' tokens for one symbol
//   GET  /api/master/search?broker=&q=&limit=         -> autocomplete

import { route, readJSON, ApiError } from '../server.js';
import { status, resolve, getToken, search, ensurePublicMasters, loadSessionMaster } from '../master/manager.js';
import { brokerList } from '../master/store.js';

route('GET', '/api/master/status', () => ({ status: true, masters: status() }));

route('POST', '/api/master/refresh', async (req) => {
  const b = await readJSON(req);
  const res = await ensurePublicMasters({ force: b.force !== false });
  return { status: true, result: res, masters: status() };
});

// Reload a session-gated master (Nubra needs sessionToken+deviceId; Kotak needs
// accessToken+baseUrl). Normally called automatically after that broker's login.
route('POST', '/api/master/refresh-session', async (req) => {
  const b = await readJSON(req);
  if (!b.broker) throw new ApiError('broker required', 400);
  try {
    const r = await loadSessionMaster(b.broker, b, { force: b.force !== false });
    return { status: true, result: r, masters: status() };
  } catch (e) {
    throw new ApiError(e.message, 400);
  }
});

// Resolve ONE broker's token for a canonical symbol.
route('GET', '/api/master/resolve', (req, res, { query }) => {
  const symbol = query.get('symbol');
  const exchange = query.get('exchange') || '';
  const broker = query.get('broker');
  if (!symbol || !broker) throw new ApiError('symbol and broker required', 400);
  const hit = getToken(broker, symbol, exchange);
  if (!hit) return { status: false, message: `Not found for ${broker}: ${symbol} ${exchange}` };
  return { status: true, broker, symbol, exchange, ...hit, row: undefined };
});

// Route ONE canonical symbol across ALL loaded brokers — the core "global feed"
// lookup: give a symbol, get each broker's token.
route('GET', '/api/master/route', (req, res, { query }) => {
  const symbol = query.get('symbol');
  const exchange = query.get('exchange') || '';
  if (!symbol) throw new ApiError('symbol required', 400);
  const tokens = {};
  for (const broker of brokerList()) {
    const row = resolve(broker, symbol, exchange);
    tokens[broker] = row ? { token: row.token, brsymbol: row.brsymbol, lotsize: row.lotsize } : null;
  }
  return { status: true, symbol, exchange, tokens };
});

route('GET', '/api/master/search', (req, res, { query }) => {
  const broker = query.get('broker');
  const q = query.get('q') || '';
  const limit = Number(query.get('limit')) || 30;
  if (!broker) throw new ApiError('broker required', 400);
  return { status: true, results: search(broker, q, limit) };
});
