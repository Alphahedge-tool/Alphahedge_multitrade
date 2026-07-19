// /ws/feed — the client-facing WebSocket endpoint (openalgo websocket_proxy
// server.py equivalent, mounted on the existing HTTP server instead of a
// separate port). Browsers/tools connect here and speak JSON:
//
//   -> { action: "subscribe",   broker, mode?, instruments: [{exchange, token, symbol?}] }
//   -> { action: "unsubscribe", broker, instruments: [...] }
//   -> { action: "status" }
//   -> { action: "engine_subscribe",   symbol, expiry, strikes: [25000, ...] }
//   -> { action: "engine_unsubscribe", topicId }
//   <- { type: "tick", broker, exchange, token, mode, ltp, ... }   (normalized)
//   <- { type: "engine_subscribed", topicId, contracts, spot, history: {col:[]} }
//   <- { type: "engine_point", topicId, point: { time, callOi, putOi, ... } }
//   <- { type: "feed_status", broker, connected, message }
//   <- { type: "subscribed"|"unsubscribed", broker, count, snapshot? }
//   <- { type: "error", message }
//
// mode: 1 = LTP, 2 = Quote (default), 3 = Depth. A client only receives ticks
// for instruments it subscribed; broker connection status goes to everyone.

import { WebSocketServer } from 'ws';
import {
  clientSubscribe,
  clientUnsubscribe,
  managerStatus,
  onTick,
  onStatus,
} from './feedManager.js';
import { subKey } from './baseAdapter.js';
import { getFeedAccount } from '../lib/feedRegistry.js';
import { getSession as getUpstoxSession } from '../brokers/upstox.js';
import { subscribe as engineSubscribe, topicId as engineTopicId } from '../engine/oiDecayEngine.js';

// clients: { sock, keys: Map<"broker|EXCH|token", {broker, inst}>,
//            engine: Map<topicId, unsubscribe> }
const clients = new Set();

export function clientCount() {
  return clients.size;
}

export function attachFeedWSS(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/feed' });

  // ws re-emits the HTTP server's errors here, and an unhandled 'error' event
  // kills the process — which would defeat the EADDRINUSE port retry in
  // server.js. Listening errors are that server's business, not the WSS's.
  wss.on('error', (err) => {
    if (err?.code === 'EADDRINUSE') return;
    console.error('feed WSS error:', err?.message || err);
  });

  wss.on('connection', (sock) => {
    const client = { sock, keys: new Map(), engine: new Map() };
    clients.add(client);
    send(sock, { type: 'welcome', brokers: managerStatus() });

    sock.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return send(sock, { type: 'error', message: 'Invalid JSON' });
      }
      // handleMessage is async for engine topics (building one may need a chain
      // fetch), so failures arrive as a rejection rather than a throw.
      Promise.resolve()
        .then(() => handleMessage(client, msg))
        .catch((err) => send(sock, { type: 'error', action: msg.action, broker: msg.broker, message: err.message }));
    });

    const cleanup = () => {
      if (!clients.delete(client)) return;
      const byBroker = new Map();
      for (const { broker, inst } of client.keys.values()) {
        if (!byBroker.has(broker)) byBroker.set(broker, []);
        byBroker.get(broker).push(inst);
      }
      for (const [broker, insts] of byBroker) clientUnsubscribe(broker, insts);
      // Release engine topics too, or a closed tab would hold its topic (and
      // its upstream instrument subscriptions) alive forever.
      for (const release of client.engine.values()) {
        try {
          release();
        } catch {
          /* already torn down */
        }
      }
      client.engine.clear();
    };
    sock.on('close', cleanup);
    sock.on('error', cleanup);
  });

  // fan-out: ticks to subscribers, status to everyone
  onTick((tick) => {
    const key = `${tick.broker}|${subKey(tick.exchange, tick.token)}`;
    const payload = JSON.stringify(tick);
    for (const client of clients) {
      if (client.keys.has(key)) rawSend(client.sock, payload);
    }
  });
  onStatus((ev) => {
    const payload = JSON.stringify(ev);
    for (const client of clients) rawSend(client.sock, payload);
  });

  console.log('WebSocket feed endpoint mounted at /ws/feed');
  return wss;
}

// toISODate mirrors the REST route's expiry normalization so a topic subscribed
// over the socket and one polled over HTTP resolve to the same topic id.
function toISODate(value) {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  const match = raw.toUpperCase().match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (!match) return raw;
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return `${match[3]}-${String(months.indexOf(match[2]) + 1).padStart(2, '0')}-${match[1]}`;
}

// ── engine topics ───────────────────────────────────────────────────────────
// Derived market-intelligence series (OI / premium decay). The client asks for
// symbol+expiry+strikes and receives the ring's history once, then one point
// per compute cycle — replacing what used to be a 1Hz HTTP poll per tab.

async function handleEngineSubscribe(client, msg) {
  const symbol = String(msg.symbol || '').toUpperCase();
  const expiryISO = toISODate(msg.expiry);
  const strikes = (Array.isArray(msg.strikes) ? msg.strikes : []).map(Number).filter(Number.isFinite);
  if (!symbol || !expiryISO) throw new Error('symbol and expiry required');
  if (!strikes.length) throw new Error('strikes required');

  const id = engineTopicId({ symbol, expiryISO, strikes });
  if (client.engine.has(id)) {
    return send(client.sock, { type: 'engine_subscribed', topicId: id, duplicate: true });
  }
  // Reserve the slot before awaiting so two rapid subscribes for the same topic
  // can't both get through and leak one of the leases.
  client.engine.set(id, () => {});

  const feedEntry = getFeedAccount('upstox');
  const session = feedEntry?.userId ? getUpstoxSession(feedEntry.userId) : null;
  if (!session?.accessToken) {
    client.engine.delete(id);
    throw new Error('Select and connect an Upstox Feed Master account first');
  }

  let handle;
  try {
    handle = await engineSubscribe(
      { symbol, expiryISO, strikes, accessToken: session.accessToken, exchange: msg.exchange, spotToken: msg.spotToken },
      (point) => send(client.sock, { type: 'engine_point', topicId: id, point }),
    );
  } catch (err) {
    client.engine.delete(id);
    throw err;
  }

  // The socket may have closed while the topic was being built; if so the
  // cleanup already ran and would never see this handle.
  if (!clients.has(client)) {
    handle.unsubscribe();
    return undefined;
  }
  client.engine.set(id, handle.unsubscribe);

  const topic = handle.topic;
  return send(client.sock, {
    type: 'engine_subscribed',
    topicId: id,
    symbol,
    expiry: expiryISO,
    strikes: topic.strikes,
    contracts: topic.contracts.size,
    spot: topic.spot,
    // Whatever the topic has already accumulated, so a reconnecting client
    // backfills the gap instead of showing a hole in the chart.
    history: topic.ring.toJSON(),
  });
}

function handleEngineUnsubscribe(client, msg) {
  const id = String(msg.topicId || '');
  const release = client.engine.get(id);
  if (release) {
    client.engine.delete(id);
    try {
      release();
    } catch {
      /* already torn down */
    }
  }
  return send(client.sock, { type: 'engine_unsubscribed', topicId: id });
}

function handleMessage(client, msg) {
  const action = String(msg.action || '').toLowerCase();
  if (action === 'status') {
    return send(client.sock, { type: 'status', brokers: managerStatus(), clients: clients.size });
  }
  if (action === 'engine_subscribe') return handleEngineSubscribe(client, msg);
  if (action === 'engine_unsubscribe') return handleEngineUnsubscribe(client, msg);

  const broker = String(msg.broker || '').toLowerCase();
  const instruments = (Array.isArray(msg.instruments) ? msg.instruments : [])
    .filter((i) => i && i.token)
    .map((i) => ({ exchange: String(i.exchange || 'NSE').toUpperCase(), token: String(i.token), symbol: i.symbol || '' }));

  if (action === 'subscribe') {
    if (!broker) throw new Error('broker required');
    if (!instruments.length) throw new Error('instruments required');
    const mode = Number(msg.mode) || 2;
    const snapshot = clientSubscribe(broker, instruments, mode);
    for (const inst of instruments) {
      client.keys.set(`${broker}|${subKey(inst.exchange, inst.token)}`, { broker, inst });
    }
    send(client.sock, { type: 'subscribed', broker, mode, count: instruments.length });
    for (const tick of snapshot) rawSend(client.sock, JSON.stringify(tick)); // replay cached state
    return;
  }

  if (action === 'unsubscribe') {
    if (!broker) throw new Error('broker required');
    const drop = [];
    for (const inst of instruments) {
      const key = `${broker}|${subKey(inst.exchange, inst.token)}`;
      if (client.keys.delete(key)) drop.push(inst);
    }
    clientUnsubscribe(broker, drop);
    return send(client.sock, { type: 'unsubscribed', broker, count: drop.length });
  }

  throw new Error(`Unknown action "${msg.action}"`);
}

function send(sock, obj) {
  rawSend(sock, JSON.stringify(obj));
}

function rawSend(sock, payload) {
  if (sock.readyState === sock.OPEN) {
    try {
      sock.send(payload);
    } catch {
      /* dead socket: close event cleans up */
    }
  }
}
