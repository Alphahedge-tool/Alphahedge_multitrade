// Angel chain helpers for the shared feed. Thin wrappers over the trade-panel's
// getOptionChain + MasterStore, using the shared singletons so the feed reuses
// the same scrip master and connection pool.

import { getOptionChain } from './market.js';
import { client, auth, master } from './singletons.js';

// getAngelChain builds the option chain for a symbol+expiry using the given
// logged-in client (from the feed registry). Returns the chain object with
// strikes / callLtp / putLtp / callOI / putOI / spot / atm / expiry.
export async function getAngelChain(feedClient, symbol, expiry, window = 30) {
  return getOptionChain(client, auth, master, { client: feedClient, symbol, expiry, window });
}

// getAngelExpiries returns the expiry list for an underlying from the scrip
// master index (no login needed).
export async function getAngelExpiries(symbol) {
  const idx = await master.getIndex();
  const map = idx?.index || idx || {};
  return map[symbol] || map[String(symbol).toUpperCase()] || [];
}
