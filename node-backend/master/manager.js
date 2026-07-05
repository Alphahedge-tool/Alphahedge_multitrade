// Master manager — coordinates loading each broker's instrument master into the
// shared store, cache-first. Public brokers (Angel, Upstox) load on boot with no
// auth; session brokers (Nubra, Kotak) load when a login session is available.

import { loadAngelMaster } from './loaders/angel.js';
import { loadUpstoxMaster } from './loaders/upstox.js';
import { loadNubraMaster } from './loaders/nubra.js';
import { loadKotakMaster } from './loaders/kotak.js';
import { loadFromCache, isFresh, status, resolve, getToken, search } from './store.js';

// Public masters — no auth needed. { broker: loaderFn }
const PUBLIC_LOADERS = { angel: loadAngelMaster, upstox: loadUpstoxMaster };

// ensurePublic loads Angel + Upstox if not already fresh (cache first, then
// download). Safe to call repeatedly; skips work when fresh.
export async function ensurePublicMasters({ force = false } = {}) {
  const results = {};
  for (const [broker, loader] of Object.entries(PUBLIC_LOADERS)) {
    if (!force && (isFresh(broker) || loadFromCache(broker))) { results[broker] = 'cached'; continue; }
    try {
      const n = await loader();
      results[broker] = `loaded ${n}`;
    } catch (e) {
      results[broker] = `error: ${e.message}`;
    }
  }
  return results;
}

// loadSessionMaster loads a broker that needs a live session (Nubra/Kotak).
// creds: Nubra -> { sessionToken, deviceId }; Kotak -> { accessToken, baseUrl }.
export async function loadSessionMaster(broker, creds, { force = false } = {}) {
  if (!force && (isFresh(broker) || loadFromCache(broker))) return 'cached';
  if (broker === 'nubra') return `loaded ${await loadNubraMaster(creds)}`;
  if (broker === 'kotak') return `loaded ${await loadKotakMaster(creds)}`;
  throw new Error(`Unknown session-master broker: ${broker}`);
}

// warmMasters is the boot hook: load the public masters in the background so
// resolution works immediately, without blocking server start.
export function warmMasters() {
  ensurePublicMasters().then(
    (r) => console.log('Instrument masters ready:', JSON.stringify(r)),
    (e) => console.log('Master warm-up failed:', e.message),
  );
}

// re-export the store's read API so routes import from one place.
export { status, resolve, getToken, search };
