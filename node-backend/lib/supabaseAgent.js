// Shared HTTP connection pool for all Supabase (PostgREST) calls.
//
// Node's built-in fetch pools connections but lets them go idle, so the FIRST
// request after a pause pays a full TLS handshake to Supabase (~500-600ms). By
// installing a global undici Agent with a long keepAlive timeout AND periodically
// pinging Supabase to keep a socket warm, every request reuses a live connection
// and stays ~150-180ms — no more intermittent ~1s cold calls.

import { Agent, setGlobalDispatcher } from 'undici';

// Keep sockets alive for 10 minutes idle; allow plenty of concurrent sockets.
const agent = new Agent({
  keepAliveTimeout: 10 * 60 * 1000,
  keepAliveMaxTimeout: 10 * 60 * 1000,
  connections: 32,
});
setGlobalDispatcher(agent);

// warmSupabase fires a tiny HEAD-ish request so a TLS connection is established
// and kept warm. Called on boot and on an interval.
let warmTimer = null;
export function keepSupabaseWarm() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return; // not configured; nothing to warm

  const ping = () => {
    fetch(`${url.replace(/\/+$/, '')}/rest/v1/broker_accounts?select=id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    }).catch(() => {}); // best-effort; ignore failures
  };

  ping(); // warm immediately on boot
  if (!warmTimer) {
    // Re-ping every 4 minutes so the socket never idles out before use.
    warmTimer = setInterval(ping, 4 * 60 * 1000);
    warmTimer.unref?.(); // don't keep the process alive just for the pinger
  }
}
