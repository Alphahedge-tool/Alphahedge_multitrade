// /api/ws/feed/* — REST control for the broker WebSocket feeds (the openalgo
// websocket_proxy, Node edition). The feeds auto-start when Feed Master logs a
// broker in; these routes let the UI (and curl) inspect and drive them.
//
//   GET  /api/ws/feed/status                 -> adapter state per broker + client count
//   POST /api/ws/feed/start   {broker?}      -> start one broker (or all logged-in)
//   POST /api/ws/feed/stop    {broker}       -> stop one broker's adapter
//   POST /api/ws/feed/subscribe   {broker, mode?, instruments:[{exchange,token,symbol?}]}
//   POST /api/ws/feed/unsubscribe {broker, instruments}
//
// Live ticks stream over the WebSocket endpoint ws://<host>/ws/feed.

import { route, readJSON, ApiError } from '../server.js';
import {
  startBroker,
  startAll,
  stopBroker,
  managerStatus,
  getAdapter,
  clientSubscribe,
  clientUnsubscribe,
} from '../ws/feedManager.js';
import { clientCount } from '../ws/wsServer.js';
import { resolve as resolveMaster } from '../master/store.js';

route('GET', '/api/ws/feed/status', () => ({
  status: true,
  brokers: managerStatus(),
  clients: clientCount(),
}));

route('POST', '/api/ws/feed/start', async (req) => {
  const b = await readJSON(req);
  try {
    if (b.broker) return { status: true, started: { [b.broker]: startBroker(b.broker) } };
    return { status: true, started: startAll() };
  } catch (err) {
    throw new ApiError(err.message, 400);
  }
});

route('POST', '/api/ws/feed/stop', async (req) => {
  const b = await readJSON(req);
  if (!b.broker) throw new ApiError('broker required', 400);
  return { status: true, stopped: stopBroker(b.broker) };
});

route('POST', '/api/ws/feed/subscribe', async (req) => {
  const b = await readJSON(req);
  if (!b.broker) throw new ApiError('broker required', 400);
  if (!Array.isArray(b.instruments) || !b.instruments.length) {
    throw new ApiError('instruments required', 400);
  }
  try {
    const snapshot = clientSubscribe(b.broker, b.instruments, Number(b.mode) || 2);
    return { status: true, broker: b.broker, subscribed: b.instruments.length, snapshot };
  } catch (err) {
    throw new ApiError(err.message, 400);
  }
});

route('POST', '/api/ws/feed/unsubscribe', async (req) => {
  const b = await readJSON(req);
  if (!b.broker) throw new ApiError('broker required', 400);
  clientUnsubscribe(b.broker, b.instruments || []);
  return { status: true, broker: b.broker };
});

// Map a loaded chain's canonical option symbols to ANOTHER broker's WebSocket
// tokens, aligned to the same call/put arrays. The Option Chain uses this to
// stream Upstox Bid/Ask live over /ws/feed for symbols the REST option-chain
// endpoint can't enrich (e.g. MCX commodities), where the Upstox token is only
// discoverable per-contract via the instrument master.
//
//   POST /api/ws/feed/map-tokens
//     { broker:'upstox', exchange:'MCX', callSymbols:[...], putSymbols:[...] }
//   -> { callTokens:[upstoxKey|null...], putTokens:[...], exchange:'MCX' }
route('POST', '/api/ws/feed/map-tokens', async (req) => {
  const b = await readJSON(req);
  const broker = String(b.broker || 'upstox').toLowerCase();
  const exchange = String(b.exchange || 'MCX').toUpperCase();
  const mapOne = (sym) => {
    if (!sym) return null;
    const row = resolveMaster(broker, sym, exchange);
    return row?.token || null; // e.g. "MCX_FO|570229"
  };
  return {
    status: true,
    broker,
    exchange,
    callTokens: (b.callSymbols || []).map(mapOne),
    putTokens: (b.putSymbols || []).map(mapOne),
  };
});

// Latest cached tick for one instrument — handy for polling consumers that
// don't hold a WebSocket open.
route('GET', '/api/ws/feed/ltp', (req, res, { query }) => {
  const broker = query.get('broker');
  const exchange = (query.get('exchange') || 'NSE').toUpperCase();
  const token = query.get('token');
  if (!broker || !token) throw new ApiError('broker and token required', 400);
  const adapter = getAdapter(broker);
  if (!adapter) throw new ApiError(`${broker} feed is not running`, 400);
  const [tick] = adapter.snapshotFor([{ exchange, token }]);
  return { status: true, tick: tick || null };
});
