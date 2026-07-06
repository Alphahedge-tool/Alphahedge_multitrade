// /ws/feed — the client-facing WebSocket endpoint (openalgo websocket_proxy
// server.py equivalent, mounted on the existing HTTP server instead of a
// separate port). Browsers/tools connect here and speak JSON:
//
//   -> { action: "subscribe",   broker, mode?, instruments: [{exchange, token, symbol?}] }
//   -> { action: "unsubscribe", broker, instruments: [...] }
//   -> { action: "status" }
//   <- { type: "tick", broker, exchange, token, mode, ltp, ... }   (normalized)
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

const clients = new Set(); // { sock, keys: Map<"broker|EXCH|token", {broker, inst}> }

export function clientCount() {
  return clients.size;
}

export function attachFeedWSS(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/feed' });

  wss.on('connection', (sock) => {
    const client = { sock, keys: new Map() };
    clients.add(client);
    send(sock, { type: 'welcome', brokers: managerStatus() });

    sock.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return send(sock, { type: 'error', message: 'Invalid JSON' });
      }
      try {
        handleMessage(client, msg);
      } catch (err) {
        send(sock, { type: 'error', action: msg.action, broker: msg.broker, message: err.message });
      }
    });

    const cleanup = () => {
      if (!clients.delete(client)) return;
      const byBroker = new Map();
      for (const { broker, inst } of client.keys.values()) {
        if (!byBroker.has(broker)) byBroker.set(broker, []);
        byBroker.get(broker).push(inst);
      }
      for (const [broker, insts] of byBroker) clientUnsubscribe(broker, insts);
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

function handleMessage(client, msg) {
  const action = String(msg.action || '').toLowerCase();
  if (action === 'status') {
    return send(client.sock, { type: 'status', brokers: managerStatus(), clients: clients.size });
  }

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
