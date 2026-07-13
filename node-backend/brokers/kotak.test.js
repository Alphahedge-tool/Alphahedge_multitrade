import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeKotakOrder, normalizeKotakPosition, positions,
} from './kotak.js';
import {
  connectionRequest, KotakAdapter, subscriptionRequests, throttleRequest,
} from '../ws/adapters/kotak.js';
import { normalizeKotakStreamMessage, realtimeUrl } from '../ws/kotakUserStream.js';

test('normalizes Kotak portfolio order and position rows', () => {
  const order = normalizeKotakOrder({
    nOrdNo: 'N1', trdSym: 'NIFTY30JUL2625000CE', exSeg: 'nse_fo',
    trnsTp: 'B', qty: '75', fldQty: '25', prc: '100.5', ordSt: 'open',
  });
  assert.equal(order.orderid, 'N1');
  assert.equal(order.exchange, 'NFO');
  assert.equal(order.transactiontype, 'BUY');
  assert.equal(order.filledshares, 25);

  const position = normalizeKotakPosition({
    trdSym: 'AXISBANK-EQ', sym: 'AXISBANK', exSeg: 'nse_cm', prod: 'CNC',
    qty: '5', flBuyQty: '10', flSellQty: '5', buyAmt: '1000', sellAmt: '550', lotSz: '1',
  });
  assert.equal(position.exchange, 'NSE');
  assert.equal(position.netqty, 5);
  assert.equal(position.buyavgprice, 100);
  assert.equal(position.sellavgprice, 110);
  assert.equal(position.realised, 50);
});

test('positions uses Kotak documented auth headers and endpoint', async () => {
  const originalFetch = global.fetch;
  let request = null;
  global.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({ stat: 'Ok', stCode: 200, data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const out = await positions({ session: {
      tradeToken: 'trade-token', sid: 'sid-1', baseUrl: 'https://neo.example',
      serverId: 'server-1', dataCenter: 'e43', ucc: 'U1',
    } });
    assert.equal(out.status, true);
    assert.equal(request.url, 'https://neo.example/quick/user/positions');
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.headers.Auth, 'trade-token');
    assert.equal(request.options.headers.Sid, 'sid-1');
    assert.equal(request.options.headers['neo-fin-key'], 'neotradeapi');
  } finally {
    global.fetch = originalFetch;
  }
});

test('normalizes HSI order/position events and selects the data-center URL', () => {
  assert.equal(realtimeUrl({ dataCenter: 'E43' }), 'wss://e43.kotaksecurities.com/realtime');
  assert.equal(
    realtimeUrl({ baseUrl: 'https://neo-gw.kotaksecurities.com/path' }),
    'wss://neo-gw.kotaksecurities.com/realtime',
  );
  const order = normalizeKotakStreamMessage({ type: 'order', data: {
    nOrdNo: 'N2', trdSym: 'ITC-EQ', exSeg: 'nse_cm', fldQty: '2', ordSt: 'complete',
  } });
  assert.equal(order.event, 'order');
  assert.equal(order.data.orderid, 'N2');
  assert.equal(order.data.exchange, 'NSE');
  const position = normalizeKotakStreamMessage({ type: 'position', data: {
    trdSym: 'ITC-EQ', exSeg: 'nse_cm', qty: '2',
  } });
  assert.equal(position.event, 'position');
  assert.equal(position.data.netqty, 2);
});

test('HSM frames batch at 100, rotate channels and cap subscriptions at 200', () => {
  assert.equal(connectionRequest('trade-token', 'sid-1').readUInt8(2), 1);
  assert.equal(throttleRequest().readUInt8(2), 2);
  const scrips = Array.from({ length: 205 }, (_, index) => `nse_fo|${index + 1}`);
  const frames = subscriptionRequests(scrips, { prefix: 'sf', channel: 1 });
  assert.equal(frames.length, 3);
  assert.deepEqual(frames.map((frame) => frame.readUInt16BE(7)), [100, 100, 5]);
  assert.deepEqual(frames.map((frame) => frame.readUInt8(frame.length - 1)), [1, 2, 3]);

  const adapter = new KotakAdapter({});
  adapter.subscribe(Array.from({ length: 250 }, (_, index) => ({
    exchange: 'NFO', token: String(index + 1),
  })), 2);
  assert.equal(adapter.status().subscriptions, 200);
});

