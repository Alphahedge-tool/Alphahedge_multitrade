// Admin API client — talks to the Node backend (proxied by Vite at /api).
// Our Node users/broker-config routes return { success, data }; the broker-login
// routes return { status, ... }. apiGet/apiPost handle the { success } shape.

// In-flight GET coalescing: identical GETs fired within the same tick share one
// network request. This kills the duplicate call React StrictMode causes in dev
// (it double-invokes effects), and prevents accidental double-fetches anywhere.
const inflight = new Map()

// GET a { success, data } endpoint (users, broker-config).
export async function apiGet(path) {
  if (inflight.has(path)) return inflight.get(path)
  const p = (async () => {
    const res = await fetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' } })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.success === false) throw new Error(data.message || `HTTP ${res.status}`)
    return data
  })()
  inflight.set(path, p)
  try {
    return await p
  } finally {
    inflight.delete(path)
  }
}

// POST a { success, data } endpoint.
export async function apiPost(path, body = {}) {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.success === false) throw new Error(data.message || `HTTP ${res.status}`)
  return data
}

// Broker auto-login via the Node backend ({ status } envelope). broker is one of
// angel | upstox | kotak | nubra. Returns the login response body.
export async function brokerAutoLogin(broker, client) {
  const res = await fetch(`/api/${broker}/auto-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client, ...client }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.status === false) {
    // needsOtp / needsLogin are not hard errors — return them for the caller.
    if (data.needsOtp || data.needsLogin) return data
    throw new Error(data.message || `HTTP ${res.status}`)
  }
  return data
}
