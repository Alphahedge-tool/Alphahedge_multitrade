// Final broker-specific instrument resolution for live orders. The browser may
// display/prices legs using Angel tokens, but an order is never allowed to reuse
// those identifiers for another broker. Each leg is rebuilt from the selected
// broker's own daily master immediately before any order request is sent.

import { resolve } from './store.js';
import { canonicalSymbol as buildCanonicalSymbol } from './symbol.js';

export function canonicalForLeg(leg = {}) {
  if (leg.canonicalSymbol) return String(leg.canonicalSymbol).toUpperCase().trim();
  const name = leg.underlying || leg.rootSymbol || leg.name;
  const type = String(leg.optionType || leg.instrumentType || '').toUpperCase();
  if (!name) throw new Error('canonical instrument missing underlying/name');
  if ((type === 'CE' || type === 'PE') && (!leg.expiry || !Number.isFinite(Number(leg.strike)))) {
    throw new Error(`canonical option details missing for ${name}`);
  }
  return buildCanonicalSymbol({
    name,
    expiry: leg.expiry,
    strike: leg.strike,
    type: type || (leg.expiry ? 'FUT' : 'EQ'),
    optionType: type,
  });
}

export function resolveOrderLeg(broker, leg = {}) {
  const canonical = canonicalForLeg(leg);
  const exchange = String(leg.canonicalExchange || leg.exchange || '').toUpperCase();
  const row = resolve(broker, canonical, exchange);
  if (!row) {
    throw new Error(`${broker} instrument not found: ${canonical}${exchange ? ` (${exchange})` : ''}`);
  }
  if (!row.brsymbol) throw new Error(`${broker} master has no trading symbol for ${canonical}`);
  if (!row.token) throw new Error(`${broker} master has no token for ${canonical}`);
  return {
    ...leg,
    canonicalSymbol: canonical,
    canonicalExchange: row.exchange,
    sourceToken: leg.token || '',
    token: row.token,
    symbol: row.brsymbol,
    exchange: row.brexchange || row.exchange,
    lotSize: Number(row.lotsize) || Number(leg.lotSize) || 1,
    resolvedInstrument: {
      broker,
      canonicalSymbol: canonical,
      token: row.token,
      tradingSymbol: row.brsymbol,
      exchange: row.brexchange || row.exchange,
    },
  };
}

export function resolveOrderBasket(broker, legs = []) {
  if (!Array.isArray(legs) || !legs.length) throw new Error('Select at least one order');
  // Resolve the entire basket first. If one mapping is absent, zero live orders
  // are sent, avoiding an accidental partially placed cross-broker basket.
  return legs.slice(0, 50).map((leg) => resolveOrderLeg(broker, leg));
}
