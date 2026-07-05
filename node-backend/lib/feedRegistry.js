// Feed registry — the backend's record of which broker accounts are currently
// "in the feed" (logged in via Feed Master). The Option Chain and other feed
// consumers read from HERE instead of taking an account per request.
//
// For each broker we keep the ACTIVE feed account:
//   angel  -> { client } where client carries session.jwtToken/feedToken + creds
//   upstox -> { userId } (the upstox adapter already holds the token by userId)
//   nubra  -> { session } (sessionToken + deviceId)
//   kotak  -> { session }
//
// Set when Feed Master logs an account in; read when building the chain. One
// active account per broker (the feed's source for that broker); logging in a
// new account of the same broker replaces it.

const feed = new Map(); // broker -> entry

export function setFeedAccount(broker, entry) {
  if (!broker || !entry) return;
  feed.set(String(broker).toLowerCase(), { ...entry, at: Date.now() });
}

export function getFeedAccount(broker) {
  return feed.get(String(broker).toLowerCase()) || null;
}

export function clearFeedAccount(broker) {
  feed.delete(String(broker).toLowerCase());
}

// status summarizes the active feed accounts (safe fields only — no secrets).
export function feedStatus() {
  const out = {};
  for (const [broker, e] of feed) {
    out[broker] = {
      account: e.account || e.client?.clientCode || e.userId || '',
      user: e.userName || '',
      live: true,
      at: new Date(e.at).toISOString(),
    };
  }
  return out;
}
