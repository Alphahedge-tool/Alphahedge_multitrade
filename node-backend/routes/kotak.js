// /api/kotak/* — Kotak NEO headless TOTP login. Frontend posts flat fields
// (accessToken, mobileNumber, ucc, mpin, totpSecret).

import { route, readJSON, ApiError } from '../server.js';
import * as kotak from '../brokers/kotak.js';
import { setFeedAccount } from '../lib/feedRegistry.js';
import { loadSessionMaster, resolveBroker } from '../master/manager.js';
import { resolveOrderBasket } from '../master/orderResolver.js';
import { KotakUserStream } from '../ws/kotakUserStream.js';

route('POST', '/api/kotak/auto-login', async (req) => {
  const b = await readJSON(req);
  const c = b.client && typeof b.client === 'object' ? b.client : b;
  const cr = {
    accessToken: c.accessToken || c.apiKey,
    mobileNumber: c.mobileNumber || c.phone,
    ucc: c.ucc || c.clientCode,
    mpin: c.mpin || c.pin,
    totpSecret: c.totpSecret,
  };
  try {
    const savedSession = c.session || b.session || null;
    // Kotak's saved trade/session tokens are sufficient for feed and order
    // calls. Reuse them instead of generating another TOTP login.
    const reusable = savedSession?.tradeToken && savedSession?.sid && savedSession?.baseUrl
      && (savedSession?.serverId || savedSession?.hsServerId);
    const res = reusable
      ? {
          status: true,
          broker: 'kotak',
          clientCode: savedSession.ucc || cr.ucc,
          availableMargin: 0,
          marginSource: 'saved-session',
          sessionSource: 'session',
          session: savedSession,
          data: { baseUrl: savedSession.baseUrl, greetingName: savedSession.greeting },
        }
      : await kotak.autoLogin(cr);
    if (res?.session?.tradeToken) {
      try {
        res.master = await loadSessionMaster('kotak', {
          accessToken: cr.accessToken,
          baseUrl: res.session.baseUrl,
        });
      } catch (masterError) {
        res.master = `error: ${masterError.message}`;
      }
    }
    // Feed Master logins register this account as the feed's Kotak source; the
    // registry change hook then starts the Kotak HSM WebSocket automatically.
    if ((b.feedRegister || c.feedRegister) && res?.session?.tradeToken) {
      setFeedAccount('kotak', {
        session: res.session,
        account: res.clientCode || cr.ucc,
        userName: b.userName || c.userName || '',
      });
    }
    return res;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(err.message || 'Kotak login failed', err.status || 500);
  }
});

route('POST', '/api/kotak/place-basket', async (req) => {
  const b = await readJSON(req);
  const client = b.client || {};
  const session = kotak.sessionFromClient(client);
  try {
    await loadSessionMaster('kotak', {
      accessToken: client.accessToken || client.apiKey,
      baseUrl: session.baseUrl,
    });
    const legs = resolveOrderBasket('kotak', b.legs || []);
    return kotak.placeBasket({ client: { ...client, session }, legs });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(err.message || 'Kotak basket preparation failed', 400);
  }
});

route('POST', '/api/kotak/order-book', async (req) => {
  const body = await readJSON(req);
  return kotak.orderBook(body.client || body);
});

route('POST', '/api/kotak/trade-book', async (req) => {
  const body = await readJSON(req);
  return kotak.tradeBook(body.client || body);
});

route('POST', '/api/kotak/positions', async (req) => {
  const body = await readJSON(req);
  const client = body.client || body;
  const session = kotak.sessionFromClient(client);
  try {
    await loadSessionMaster('kotak', {
      accessToken: client.accessToken || client.apiKey,
      baseUrl: session.baseUrl,
    });
  } catch {
    // The portfolio remains readable if a temporary master refresh fails. Rows
    // without a resolved token simply keep their REST LTP until the next load.
  }
  const result = await kotak.positions({ ...client, session });
  result.positions = result.positions.map((position) => {
    const instrument = resolveBroker(
      'kotak',
      position.tradingsymbol,
      position.exSeg || position.exchange,
    );
    if (!instrument) {
      return {
        ...position,
        brokerToken: String(position.brokerToken || position.symboltoken || ''),
        brokerExchange: position.brokerExchange || position.exSeg || '',
        feedMapped: false,
      };
    }
    return {
      ...position,
      brokerToken: String(instrument.token),
      brokerExchange: instrument.brexchange || instrument.segment,
      symboltoken: String(instrument.token),
      feedExchange: instrument.exchange,
      canonicalSymbol: instrument.symbol,
      lotsize: instrument.lotsize || position.lotsize,
      feedMapped: true,
    };
  });
  return result;
});

// POST is intentional: credentials/session tokens stay in the request body,
// while the response remains an SSE stream read through fetch().
route('POST', '/api/kotak/portfolio-stream', async (req, res) => {
  const body = await readJSON(req);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('retry: 3000\n\n');

  let stream = null;
  let keepAlive = null;
  const send = (event, data) => {
    if (res.writableEnded) return;
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (event === 'end') res.end();
  };

  try {
    const client = body.client || body;
    const session = kotak.sessionFromClient(client);
    send('session', { status: true, session });
    stream = new KotakUserStream({ ...client, session }, send).connect();
    keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(': keep-alive\n\n');
    }, 20_000);
  } catch (error) {
    send('error', { status: false, message: error.message || 'Kotak portfolio stream unavailable' });
    send('end', { status: false, message: error.message || 'Kotak portfolio stream unavailable' });
  }

  req.on('close', () => {
    if (keepAlive) clearInterval(keepAlive);
    stream?.close();
  });
  return undefined;
});
