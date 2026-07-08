// Feedmaster store — persists which broker account provides the shared live
// websocket feed, and exposes a hook to hydrate it app-wide. Ported from
// Admin_project and generalized: the feed account can be any broker (not just
// Angel), resolved from a user's Supabase broker configs.

import { useCallback, useEffect, useState } from 'react'
import { apiGet, brokerAutoLogin } from '../config/api'

export const FEED_MASTER_KEY = 'ahc_feed_master_account'
export const FEED_MASTER_CHANGED = 'feedmaster:changed'

// Brokers that can serve the live feed. Angel is the primary (its SmartWebSocket
// feed backs the Trade Panel); others are selectable as their feeds come online.
export const FEED_BROKERS = [
  { id: 'angelone', label: 'Angel One', apiPath: 'angel' },
  { id: 'upstox', label: 'Upstox', apiPath: 'upstox' },
  { id: 'zerodha', label: 'Zerodha Kite', apiPath: 'zerodha' },
  { id: 'kotak', label: 'Kotak Neo', apiPath: 'kotak' },
  { id: 'nubra', label: 'Nubra', apiPath: 'nubra' },
]

export const brokerApiPath = (name) => {
  const normalized = String(name || '').toLowerCase().replace(/\s/g, '')
  return FEED_BROKERS.find((b) => b.id === normalized)?.apiPath
    || FEED_BROKERS.find((b) => normalized.includes(b.id))?.apiPath
    || { angel: 'angel', angelone: 'angel', upstox: 'upstox', zerodha: 'zerodha', kite: 'zerodha', kotakneov3: 'kotak', kotak: 'kotak', nubra: 'nubra' }[normalized]
    || 'angel'
}
export const sessionKey = (configId) => `ahc_session_${configId}`

export function getSavedFeedMaster() {
  try { return JSON.parse(localStorage.getItem(FEED_MASTER_KEY)) || null } catch { return null }
}
export function saveFeedMaster(setting) {
  localStorage.setItem(FEED_MASTER_KEY, JSON.stringify(setting))
  window.dispatchEvent(new CustomEvent(FEED_MASTER_CHANGED, { detail: setting }))
}
export function clearFeedMaster() {
  localStorage.removeItem(FEED_MASTER_KEY)
  window.dispatchEvent(new CustomEvent(FEED_MASTER_CHANGED))
}
export function getSavedSession(configId) {
  try { return JSON.parse(localStorage.getItem(sessionKey(configId))) || null } catch { return null }
}
export function saveSession(configId, session) {
  if (!configId || !session) return
  localStorage.setItem(sessionKey(configId), JSON.stringify(session))
}

// The Feed Master's UI state (which accounts are checked, and their login
// results across all users) is persisted so it survives navigating away and
// back — React component state alone would be lost on unmount.
const FEED_STATE_KEY = 'ahc_feed_state'
export function getFeedState() {
  try { return JSON.parse(localStorage.getItem(FEED_STATE_KEY)) || { selected: [], results: {} } }
  catch { return { selected: [], results: {} } }
}
export function saveFeedState(state) {
  try { localStorage.setItem(FEED_STATE_KEY, JSON.stringify(state)) } catch { /* ignore quota */ }
}

// buildClient turns a broker config (from /users/broker-config/get) into the
// login client the Node auto-login routes expect, for any broker.
export function buildClient(config, session = null) {
  if (!config) return null
  return {
    enabled: true,
    broker: config.broker_name,
    configId: config.id,
    userId: config.user_id || '',
    clientCode: config.account_id,
    apiKey: config.app_key,
    apiSecret: config.app_secret,
    accessToken: config.app_key || config.app_secret,
    ucc: config.account_id,
    pin: config.pin,
    mpin: config.pin,
    totpSecret: config.totp_secret,
    phone: config.phone,
    mobileNumber: config.phone,
    autoLogin: true,
    session,
    loggedIn: !!(session?.jwtToken || session?.accessToken || session?.tradeToken || session?.sessionToken),
  }
}

// loginClient logs a broker config in. When feedRegister is passed (Feed Master),
// the backend records this account as the feed's source for its broker, so the
// shared feed (option chain, etc.) uses it with no account per request.
export async function loginClient(config, { feedRegister = false, userName = '' } = {}) {
  const client = buildClient(config, getSavedSession(config.id))
  client.state = `${brokerApiPath(config.broker_name)}-${config.id}-${Date.now()}`
  if (feedRegister) { client.feedRegister = true; client.userName = userName }
  const res = await brokerAutoLogin(brokerApiPath(config.broker_name), client)
  if (res.session) saveSession(config.id, res.session)
  return res
}

export function openBrokerOAuthPopup(loginUrl, broker = 'broker') {
  return new Promise((resolve, reject) => {
    const source = `${broker}-oauth`
    const popup = window.open(loginUrl, `${broker}-login`, 'width=520,height=760')
    if (!popup) {
      reject(new Error('Browser blocked the login popup'))
      return
    }
    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', onMessage)
      reject(new Error(`${broker} login timed out`))
    }, 180_000)
    function onMessage(ev) {
      const data = ev.data || {}
      if (data.source !== source) return
      window.clearTimeout(timeout)
      window.removeEventListener('message', onMessage)
      if (data.success) resolve(data.detail || '')
      else reject(new Error(data.detail || `${broker} login failed`))
    }
    window.addEventListener('message', onMessage)
  })
}

// Compatibility aliases for the ported tradepanel components, which were written
// against the Angel-only Admin_project store.
export function isAngelBroker(name = '') {
  return String(name).toLowerCase().replace(/\s/g, '').includes('angel')
}
export function isZerodhaBroker(name = '') {
  const n = String(name).toLowerCase().replace(/\s/g, '')
  return n.includes('zerodha') || n.includes('kite')
}
export function buildAngelClient(config, _user, session = null) {
  return buildClient(config, session)
}
export async function loginAngelClient(client) {
  // client is already the built login shape; hit the Angel auto-login route.
  const res = await brokerAutoLogin('angel', client)
  if (res.session && client.configId) saveSession(client.configId, res.session)
  return res
}

// useFeedMasterAccount hydrates the saved feed account for use across the app.
export function useFeedMasterAccount() {
  const [setting, setSetting] = useState(() => getSavedFeedMaster())
  const [config, setConfig] = useState(null)
  const [status, setStatus] = useState(setting ? 'Loading Feedmaster…' : 'No Feedmaster selected')

  useEffect(() => {
    const onChange = () => setSetting(getSavedFeedMaster())
    window.addEventListener(FEED_MASTER_CHANGED, onChange)
    window.addEventListener('storage', onChange)
    return () => {
      window.removeEventListener(FEED_MASTER_CHANGED, onChange)
      window.removeEventListener('storage', onChange)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function hydrate() {
      if (!setting?.configId) { setConfig(null); setStatus('No Feedmaster selected'); return }
      setStatus('Loading Feedmaster…')
      try {
        const res = await apiGet(`/users/broker-config/get?id=${setting.configId}`)
        if (cancelled) return
        setConfig(res.data || null)
        setStatus(res.data ? 'Feedmaster ready' : 'Feedmaster config not found')
      } catch (e) {
        if (!cancelled) { setConfig(null); setStatus(e.message || 'Failed to load Feedmaster') }
      }
    }
    hydrate()
    return () => { cancelled = true }
  }, [setting])

  const handleSession = useCallback((session) => {
    if (setting?.configId && session) saveSession(setting.configId, session)
  }, [setting])

  return { setting, config, status, handleSession }
}
