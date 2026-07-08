import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Box, Button, Chip, FormControl, InputLabel, MenuItem, Select, Typography } from '@mui/material'
import { RefreshCw, Radio, Zap, ZapOff } from 'lucide-react'
import './optionchain.css'

const DASH = '-'
const ROW_HEIGHT = 34
const VIRTUAL_ROW_THRESHOLD = 160
const VIRTUAL_OVERSCAN = 8
const inrFormatter = new Intl.NumberFormat('en-IN')
const num = (v) => (v == null ? DASH : inrFormatter.format(Number(v)))
const px = (v) => (v == null ? DASH : Number(v).toFixed(2))
const greek = (v, digits = 2) => (v == null || Number.isNaN(Number(v)) ? DASH : Number(v).toFixed(digits))
const tickKey = (broker, token) => (token != null && token !== '' ? `${broker}|${token}` : '')
const oiWidth = (oi, maxOi) => (maxOi ? Math.min(100, Math.round(((Number(oi) || 0) / maxOi) * 100)) : 0)

function createLiveTickStore() {
  const ticks = new Map()
  const versions = new Map()
  const listeners = new Map()
  const metaListeners = new Set()
  let meta = { tickCount: 0, lastTickAt: 0, version: 0 }

  const notifyKey = (key) => {
    const set = listeners.get(key)
    if (!set) return
    set.forEach((listener) => listener())
  }

  return {
    setBatch(patch, count) {
      const changed = []
      Object.entries(patch).forEach(([key, tick]) => {
        ticks.set(key, tick)
        versions.set(key, (versions.get(key) || 0) + 1)
        changed.push(key)
      })
      meta = { tickCount: meta.tickCount + count, lastTickAt: Date.now(), version: meta.version + 1 }
      changed.forEach(notifyKey)
      metaListeners.forEach((listener) => listener())
    },
    reset() {
      const changed = Array.from(ticks.keys())
      ticks.clear()
      versions.clear()
      meta = { tickCount: 0, lastTickAt: 0, version: meta.version + 1 }
      changed.forEach(notifyKey)
      metaListeners.forEach((listener) => listener())
    },
    getTick(key) {
      return key ? ticks.get(key) || null : null
    },
    getVersion(keys) {
      return keys.map((key) => (key ? versions.get(key) || 0 : 0)).join('|')
    },
    getMeta() {
      return meta
    },
    subscribeKeys(keys, listener) {
      const activeKeys = [...new Set(keys.filter(Boolean))]
      activeKeys.forEach((key) => {
        if (!listeners.has(key)) listeners.set(key, new Set())
        listeners.get(key).add(listener)
      })
      return () => {
        activeKeys.forEach((key) => {
          const set = listeners.get(key)
          if (!set) return
          set.delete(listener)
          if (!set.size) listeners.delete(key)
        })
      }
    },
    subscribeMeta(listener) {
      metaListeners.add(listener)
      return () => metaListeners.delete(listener)
    },
  }
}

const liveTickStore = createLiveTickStore()

function useLiveTicks(keys) {
  const keySig = keys.join('|')
  const stableKeys = useMemo(() => keys, [keySig])
  useSyncExternalStore(
    useCallback((listener) => liveTickStore.subscribeKeys(stableKeys, listener), [stableKeys]),
    useCallback(() => liveTickStore.getVersion(stableKeys), [stableKeys]),
    () => ''
  )
  return stableKeys.map((key) => liveTickStore.getTick(key))
}

function useLiveMeta() {
  const [, refresh] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => refresh((n) => n + 1), 500)
    return () => clearInterval(timer)
  }, [])
  return liveTickStore.getMeta()
}

function liveLtpFromTicks(angelTick, upTick, preferredBroker, restLtp) {
  const first = preferredBroker === 'upstox' ? [upTick, angelTick] : [angelTick, upTick]
  for (const tick of first) if (tick?.ltp != null) return tick.ltp
  return restLtp
}

function liveOiFromTicks(angelTick, upTick, restOi) {
  if (angelTick?.oi != null) return angelTick.oi
  if (upTick?.oi != null) return upTick.oi
  return restOi
}

function liveBidFromTicks(angelTick, upTick, restBid) {
  if (upTick?.bid != null) return upTick.bid
  if (angelTick?.bid != null) return angelTick.bid
  return restBid
}

function liveAskFromTicks(angelTick, upTick, restAsk) {
  if (upTick?.ask != null) return upTick.ask
  if (angelTick?.ask != null) return angelTick.ask
  return restAsk
}

function liveGreekFromTicks(upTick, field, restVal) {
  if (field === 'iv' && upTick?.iv != null) return upTick.iv
  if (upTick?.greeks?.[field] != null) return upTick.greeks[field]
  return restVal
}

// One CALL-side row. Memoized so a WebSocket tick only re-renders the strikes
// whose values actually changed — not the whole table — keeping horizontal
// scroll smooth while prices stream in.
const CallRow = memo(function CallRow({
  strike, isAtm, itm, restIv, restDelta, restGamma, restTheta, restVega, restOi,
  restBid, restAsk, restLtp, maxOi, angelToken, upToken, wsBroker,
}) {
  const [angelTick, upTick] = useLiveTicks([tickKey('angel', angelToken), tickKey('upstox', upToken)])
  const ltp = liveLtpFromTicks(angelTick, upTick, wsBroker, restLtp)
  const oi = Number(liveOiFromTicks(angelTick, upTick, restOi) ?? 0)
  const bid = liveBidFromTicks(angelTick, upTick, restBid)
  const ask = liveAskFromTicks(angelTick, upTick, restAsk)
  const iv = liveGreekFromTicks(upTick, 'iv', restIv)
  const delta = liveGreekFromTicks(upTick, 'delta', restDelta)
  const gamma = liveGreekFromTicks(upTick, 'gamma', restGamma)
  const theta = liveGreekFromTicks(upTick, 'theta', restTheta)
  const vega = liveGreekFromTicks(upTick, 'vega', restVega)
  const ltpLive = angelTick?.ltp != null || upTick?.ltp != null
  const baLive = angelTick?.bid != null || upTick?.bid != null

  return (
    <tr className={`oc-row${isAtm ? ' oc-atm' : ''}`}>
      <td className="oc-greek">{greek(iv, 1)}</td>
      <td className="oc-greek">{greek(delta, 3)}</td>
      <td className="oc-greek">{greek(gamma, 4)}</td>
      <td className="oc-greek">{greek(theta, 2)}</td>
      <td className="oc-greek">{greek(vega, 2)}</td>
      <td className={`oc-oi oc-call-oi${itm ? ' oc-itm' : ''}`}><span className="oc-oi-bar" style={{ width: `${oiWidth(oi, maxOi)}%` }} /><span className="oc-oi-val">{num(oi)}</span></td>
      <td className={`oc-bidask${baLive ? ' oc-live' : ''}`}><span className="oc-bid">{px(bid)}</span><span className="oc-sep">/</span><span className="oc-ask">{px(ask)}</span></td>
      <td className={`oc-ltp${itm ? ' oc-itm' : ''}${ltpLive ? ' oc-live' : ''}`}>{px(ltp)}</td>
    </tr>
  )
})

// One PUT-side row (mirror column order), memoized for the same reason.
const PutRow = memo(function PutRow({
  strike, isAtm, itm, restIv, restDelta, restGamma, restTheta, restVega, restOi,
  restBid, restAsk, restLtp, maxOi, angelToken, upToken, wsBroker,
}) {
  const [angelTick, upTick] = useLiveTicks([tickKey('angel', angelToken), tickKey('upstox', upToken)])
  const ltp = liveLtpFromTicks(angelTick, upTick, wsBroker, restLtp)
  const oi = Number(liveOiFromTicks(angelTick, upTick, restOi) ?? 0)
  const bid = liveBidFromTicks(angelTick, upTick, restBid)
  const ask = liveAskFromTicks(angelTick, upTick, restAsk)
  const iv = liveGreekFromTicks(upTick, 'iv', restIv)
  const delta = liveGreekFromTicks(upTick, 'delta', restDelta)
  const gamma = liveGreekFromTicks(upTick, 'gamma', restGamma)
  const theta = liveGreekFromTicks(upTick, 'theta', restTheta)
  const vega = liveGreekFromTicks(upTick, 'vega', restVega)
  const ltpLive = angelTick?.ltp != null || upTick?.ltp != null
  const baLive = angelTick?.bid != null || upTick?.bid != null

  return (
    <tr className={`oc-row${isAtm ? ' oc-atm' : ''}`}>
      <td className={`oc-ltp${itm ? ' oc-itm' : ''}${ltpLive ? ' oc-live' : ''}`}>{px(ltp)}</td>
      <td className={`oc-bidask${baLive ? ' oc-live' : ''}`}><span className="oc-bid">{px(bid)}</span><span className="oc-sep">/</span><span className="oc-ask">{px(ask)}</span></td>
      <td className={`oc-oi oc-put-oi${itm ? ' oc-itm' : ''}`}><span className="oc-oi-bar" style={{ width: `${oiWidth(oi, maxOi)}%` }} /><span className="oc-oi-val">{num(oi)}</span></td>
      <td className="oc-greek">{greek(iv, 1)}</td>
      <td className="oc-greek">{greek(delta, 3)}</td>
      <td className="oc-greek">{greek(gamma, 4)}</td>
      <td className="oc-greek">{greek(theta, 2)}</td>
      <td className="oc-greek">{greek(vega, 2)}</td>
    </tr>
  )
})

// One strike-column row (static text, but memoized to skip re-render on ticks).
const StrikeRow = memo(function StrikeRow({ strike, isAtm }) {
  return (
    <tr className={`oc-row${isAtm ? ' oc-atm' : ''}`}>
      <td className="oc-strike-cell">{num(strike)}</td>
    </tr>
  )
})

// Option Chain — reads the base ladder from the shared FEED (Angel LTP/OI +
// Upstox bid/ask via /api/feed/option-chain), then overlays LIVE prices from the
// broker WebSocket feed (/ws/feed). Index AND MCX underlyings are selectable, so
// picking an MCX scrip is also how you confirm the WebSocket is streaming live.
export default function OptionChain() {
  const [symbol, setSymbol] = useState('NIFTY')
  const [expiry, setExpiry] = useState('')
  const [expiries, setExpiries] = useState([])
  const [chain, setChain] = useState(null)
  const [feed, setFeed] = useState({})       // which broker accounts are live (REST registry)
  const [loading, setLoading] = useState(false)
  const [enriching, setEnriching] = useState(false)
  const [error, setError] = useState('')

  // Live WebSocket state: which broker's feed we subscribe through, connection
  // status, per-token live ticks, a running tick counter, and the last tick time.
  const [wsBroker, setWsBroker] = useState('angel')
  const [wsBrokers, setWsBrokers] = useState({})   // /api/ws/feed/status brokers
  const [wsState, setWsState] = useState('idle')   // idle | connecting | open | closed
  const wsRef = useRef(null)
  const subTokensRef = useRef([])                  // [{ broker, exchange, token }] currently subscribed
  const callScrollRef = useRef(null)
  const putScrollRef = useRef(null)
  const strikeScrollRef = useRef(null)
  const syncingSideRef = useRef('')
  const scrollIdleTimerRef = useRef(0)
  const loadSeqRef = useRef(0)
  const visibleRafRef = useRef(0)
  // Cached scroll extents (scrollWidth - clientWidth) for each pane. Reading
  // scrollWidth/clientWidth forces a synchronous layout flush; the table never
  // resizes mid-scroll, so we measure once (on load / resize) and reuse.
  const scrollMaxRef = useRef({ call: 1, put: 1 })
  // Upstox token per strike-index (for live Bid/Ask), resolved from the master.
  const [upTokens, setUpTokens] = useState({ callTokens: [], putTokens: [] })
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 0 })

  // Index underlyings + MCX commodities. MCX names must match the Angel scrip
  // master (see node-backend/angel/scripoptions.js MCX_SYMBOLS).
  const INDEX_UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX']
  const MCX_UNDERLYINGS = ['CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'NATGASMINI', 'GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'COPPER', 'ZINC']
  const isMcx = MCX_UNDERLYINGS.includes(symbol)
  // MCX contracts settle on Angel's MCX segment; index options on NFO/BFO.
  const chainExchange = isMcx ? 'MCX' : symbol === 'SENSEX' ? 'BFO' : 'NFO'
  // The Upstox adapter maps our exchange -> instrument-key prefix; MCX options
  // live under MCX_FO. (The tokens we send already include the prefix, but the
  // adapter also accepts a bare token + this exchange.)
  const upstoxExchange = (ex) => (ex === 'MCX' ? 'MCX' : ex)

  // Poll the feed registry (which accounts power the chain) + the live WebSocket
  // adapter status (connected/subscriptions per broker).
  useEffect(() => {
    let alive = true
    const load = () => {
      fetch('/api/feed/status').then((r) => r.json()).then((j) => { if (alive) setFeed(j.feed || {}) }).catch(() => {})
      fetch('/api/ws/feed/status').then((r) => r.json()).then((j) => { if (alive && j.status) setWsBrokers(j.brokers || {}) }).catch(() => {})
    }
    load()
    const t = setInterval(load, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  // Load expiries for the selected underlying (index or MCX) from the master.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/feed/expiries?symbol=${encodeURIComponent(symbol)}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        const list = j.expiries || []
        setExpiries(list)
        setExpiry((prev) => (prev && list.includes(prev) ? prev : (list[0] || '')))
      })
      .catch(() => { if (!cancelled) setExpiries([]) })
    return () => { cancelled = true }
  }, [symbol])

  async function loadChain(sym = symbol, exp = expiry) {
    if (!exp) { setError('Select an expiry first'); return }
    const seq = loadSeqRef.current + 1
    loadSeqRef.current = seq
    const emptyUpMap = { callTokens: [], putTokens: [] }
    setLoading(true); setEnriching(false); setError(''); setUpTokens(emptyUpMap); setChain(null)
    try {
      const res = await fetch('/api/feed/option-chain', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: sym, expiry: exp, fast: true }),
      })
      const body = await res.json()
      if (seq !== loadSeqRef.current) return
      if (!res.ok || body.status === false) throw new Error(body.message || 'Chain load failed')
      setChain(body)
      setLoading(false)
      subscribeLive(body, emptyUpMap)
      hydrateChain(body, seq)
    } catch (e) {
      if (seq === loadSeqRef.current) { setError(e.message); setChain(null); setLoading(false); setEnriching(false) }
    }
  }

  async function hydrateChain(body, seq) {
    setEnriching(true)
    try {
      const tokenPromise = fetchUpstoxTokens(body)
      const extraPromise = fetch('/api/feed/option-chain-extra', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: body.symbol, expiry: body.expiry, strikes: body.strikes || [] }),
      }).then((r) => r.json()).catch(() => null)

      const upMap = await tokenPromise
      if (seq !== loadSeqRef.current) return
      setUpTokens(upMap)
      subscribeLive(body, upMap)

      const extra = await extraPromise
      if (seq !== loadSeqRef.current) return
      if (extra?.status !== false) {
        setChain((prev) => {
          if (!prev || prev.symbol !== body.symbol || prev.expiry !== body.expiry) return prev
          return { ...prev, upstox: { source: extra.source, spot: extra.spot ?? null, aligned: extra.aligned || null } }
        })
      }
    } catch {
      /* Upstox hydration is best-effort; WebSocket ticks can still fill live fields. */
    } finally {
      if (seq === loadSeqRef.current) setEnriching(false)
    }
  }

  // fetchUpstoxTokens maps the chain's canonical option symbols to Upstox
  // instrument keys (aligned to the call/put arrays) via the master.
  async function fetchUpstoxTokens(body) {
    try {
      const res = await fetch('/api/ws/feed/map-tokens', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          broker: 'upstox',
          exchange: body.exchange || chainExchange,
          callSymbols: body.callSymbols || [],
          putSymbols: body.putSymbols || [],
        }),
      })
      const j = await res.json()
      if (j.status) return { callTokens: j.callTokens || [], putTokens: j.putTokens || [] }
    } catch { /* Upstox mapping is best-effort */ }
    return { callTokens: [], putTokens: [] }
  }

  // ── Live WebSocket overlay ──────────────────────────────────────────────────
  function queueLiveTick(m) {
    const key = `${m.broker}|${m.token}`
    liveTickStore.setBatch({
      [key]: {
        ltp: m.ltp,
        oi: m.oi,
        close: m.close,
        bid: m.bid,
        ask: m.ask,
        bidQty: m.bidQty,
        askQty: m.askQty,
        iv: m.iv,
        greeks: m.greeks,
        ts: m.ts,
      },
    }, 1)
  }
  function ensureSocket() {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return wsRef.current
    }
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/feed`)
    wsRef.current = ws
    setWsState('connecting')
    ws.onopen = () => {
      setWsState('open')
      // (Re)subscribe whatever chain is currently loaded, grouped per broker —
      // subTokensRef holds { broker, exchange, token } items, so send one
      // subscribe frame per distinct broker (Angel and Upstox have different
      // token namespaces).
      const pending = subTokensRef.current
      if (pending.length) {
        for (const broker of new Set(pending.map((i) => i.broker))) {
          sendSubscribe(ws, broker, pending.filter((i) => i.broker === broker))
        }
      }
    }
    ws.onclose = () => { setWsState('closed'); wsRef.current = null }
    ws.onerror = () => setWsState('closed')
    ws.onmessage = (ev) => {
      let m
      try { m = JSON.parse(ev.data) } catch { return }
      if (m.type !== 'tick') return
      queueLiveTick(m)
    }
    return ws
  }

  // Subscribe one broker's instruments (each carries its own exchange/token).
  function sendSubscribe(ws, broker, instruments) {
    if (ws.readyState !== WebSocket.OPEN || !instruments.length) return
    ws.send(JSON.stringify({ action: 'subscribe', broker, mode: 3, instruments }))
  }

  // subscribeLive points the WebSocket at the loaded chain's options on the
  // brokers that serve them:
  //   • Angel  → its own numeric option tokens (LTP / OI).
  //   • Upstox → its own instrument keys (LTP + Bid/Ask), resolved via map-tokens.
  // CRITICAL: each broker MUST get ITS OWN tokens. Angel tokens are bare numbers
  // (570229); Upstox tokens are instrument keys (MCX_FO|570229). Sending Angel
  // tokens to Upstox (or vice-versa) yields no ticks — that was the bug.
  function subscribeLive(body, upMap = upTokens) {
    const instruments = []
    const pushTok = (broker, exchange, token) => {
      if (token != null && token !== '') instruments.push({ broker, exchange, token: String(token) })
    }

    // Angel LTP/OI feed — only when Angel's adapter is running. Uses Angel's own
    // option tokens + the futures/spot token.
    if (wsBrokers.angel?.running) {
      ;(body?.callTokens || []).forEach((t) => pushTok('angel', chainExchange, t))
      ;(body?.putTokens || []).forEach((t) => pushTok('angel', chainExchange, t))
      pushTok('angel', body?.spotExchange || chainExchange, body?.spotToken)
    }

    // Upstox feed — LTP + Bid/Ask from Upstox's own instrument keys. Subscribe
    // whenever Upstox is running (it's the Bid/Ask source for every underlying,
    // and the LTP source when "Live feed" is set to Upstox).
    const upExchange = upstoxExchange(body?.exchange || chainExchange)
    if (wsBrokers.upstox?.running) {
      ;(upMap.callTokens || []).forEach((t) => pushTok('upstox', upExchange, t))
      ;(upMap.putTokens || []).forEach((t) => pushTok('upstox', upExchange, t))
    }

    const ws = ensureSocket()
    // Drop the previous chain's subscriptions (grouped by broker) first.
    const prev = subTokensRef.current
    if (prev.length && ws.readyState === WebSocket.OPEN) {
      for (const broker of new Set(prev.map((i) => i.broker))) {
        ws.send(JSON.stringify({ action: 'unsubscribe', broker, instruments: prev.filter((i) => i.broker === broker) }))
      }
    }
    subTokensRef.current = instruments
    liveTickStore.reset()
    // Subscribe each broker's instruments in one frame per broker.
    for (const broker of new Set(instruments.map((i) => i.broker))) {
      sendSubscribe(ws, broker, instruments.filter((i) => i.broker === broker))
    }
  }

  const wsRunningKey = useMemo(() => (
    Object.keys(wsBrokers)
      .filter((broker) => wsBrokers[broker]?.running)
      .sort()
      .join('|')
  ), [wsBrokers])

  // Re-subscribe when the selected live broker changes, broker adapters become
  // available, or Upstox token mapping arrives. Without this, loading a chain
  // before /api/ws/feed/status returns can subscribe Angel only and leave
  // Bid/Ask blank even after Upstox connects.
  useEffect(() => {
    if (chain) subscribeLive(chain, upTokens)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsBroker, wsRunningKey, chain, upTokens])

  // Tear down the socket on unmount.
  useEffect(() => () => {
    if (visibleRafRef.current) cancelAnimationFrame(visibleRafRef.current)
    try { wsRef.current?.close() } catch { /* ignore */ }
  }, [])

  // Freshness: a tick within the last 3s means the feed is genuinely live.
  const { tickCount, lastTickAt } = useLiveMeta()
  const secsSinceTick = lastTickAt ? Math.floor((Date.now() - lastTickAt) / 1000) : null
  const liveStreaming = wsState === 'open' && secsSinceTick != null && secsSinceTick <= 3

  const atm = chain?.atm
  const up = chain?.upstox?.aligned

  const angelLive = !!feed.angel
  const upstoxLive = !!feed.upstox

  // Which brokers currently have a running WS adapter (so we only offer those).
  const wsBrokerOptions = useMemo(() => {
    const running = Object.keys(wsBrokers).filter((b) => wsBrokers[b]?.running)
    return running.length ? running : ['angel', 'upstox', 'kotak', 'nubra']
  }, [wsBrokers])
  const wsBrokerInfo = wsBrokers[wsBroker]
  const feedHintIsWarning = !wsBrokerInfo?.running || (wsState === 'open' && wsBrokerInfo && !wsBrokerInfo.connected)

  const markScrollActive = useCallback(() => {
    const panes = [callScrollRef.current, putScrollRef.current, strikeScrollRef.current]
    panes.forEach((pane) => pane?.classList.add('oc-is-scrolling'))
    if (scrollIdleTimerRef.current) clearTimeout(scrollIdleTimerRef.current)
    scrollIdleTimerRef.current = window.setTimeout(() => {
      panes.forEach((pane) => pane?.classList.remove('oc-is-scrolling'))
      scrollIdleTimerRef.current = 0
    }, 140)
  }, [])

  // Measure each pane's horizontal scroll extent once. Called on chain load and
  // on resize — NOT during scroll — so the per-frame handler never has to read
  // scrollWidth/clientWidth (which force a synchronous layout flush).
  const measureScrollExtents = useCallback(() => {
    const call = callScrollRef.current
    const put = putScrollRef.current
    scrollMaxRef.current = {
      call: call ? Math.max(1, call.scrollWidth - call.clientWidth) : 1,
      put: put ? Math.max(1, put.scrollWidth - put.clientWidth) : 1,
    }
  }, [])

  const updateVisibleRange = useCallback((scrollTop = 0, viewportHeight = 0) => {
    const rowCount = chain?.strikes?.length || 0
    if (rowCount <= VIRTUAL_ROW_THRESHOLD) {
      setVisibleRange((prev) => (prev.start === 0 && prev.end === rowCount ? prev : { start: 0, end: rowCount }))
      return
    }
    const visibleRows = Math.ceil((viewportHeight || 0) / ROW_HEIGHT)
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - VIRTUAL_OVERSCAN)
    const end = Math.min(rowCount, start + visibleRows + (VIRTUAL_OVERSCAN * 2))
    setVisibleRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }))
  }, [chain])

  const queueVisibleRangeUpdate = useCallback((source) => {
    if (!source || visibleRafRef.current) return
    visibleRafRef.current = requestAnimationFrame(() => {
      visibleRafRef.current = 0
      updateVisibleRange(source.scrollTop, source.clientHeight)
    })
  }, [updateVisibleRange])

  // Mirror the scrolled pane onto the other side + the strike column. The
  // ping-pong problem: writing target.scrollLeft fires the target's own scroll
  // event, which would call this again and fight the user. We guard with
  // syncingSideRef, cleared synchronously at the end of this handler; the echo
  // scroll event lands on a future task, finds the position already matches
  // (within 0.5px), and writes nothing — no loop.
  //
  // PERF: this runs on every scroll frame, so it does ZERO layout-flushing reads
  // (scrollWidth/clientWidth are cached in scrollMaxRef). It only reads
  // scrollLeft/scrollTop and writes them — those don't force a reflow — so the
  // browser can keep scrolling on the compositor at a full 60fps.
  const syncSideScroll = useCallback((side) => {
    if (syncingSideRef.current) return
    markScrollActive()
    const source = side === 'call' ? callScrollRef.current : putScrollRef.current
    const target = side === 'call' ? putScrollRef.current : callScrollRef.current
    const strike = strikeScrollRef.current
    if (!source || !target) return

    const sourceMax = side === 'call' ? scrollMaxRef.current.call : scrollMaxRef.current.put
    const targetMax = side === 'call' ? scrollMaxRef.current.put : scrollMaxRef.current.call
    // CALL scrolls right-to-left relative to PUT (mirrored layout), so map the
    // source's progress to the target's inverted progress.
    const progress = side === 'call' ? 1 - (source.scrollLeft / sourceMax) : source.scrollLeft / sourceMax
    const nextLeft = side === 'call' ? progress * targetMax : (1 - progress) * targetMax

    syncingSideRef.current = side
    if (Math.abs(target.scrollLeft - nextLeft) > 0.5) target.scrollLeft = nextLeft
    if (Math.abs(target.scrollTop - source.scrollTop) > 0.5) target.scrollTop = source.scrollTop
    if (strike && Math.abs(strike.scrollTop - source.scrollTop) > 0.5) strike.scrollTop = source.scrollTop
    queueVisibleRangeUpdate(source)
    syncingSideRef.current = ''
  }, [markScrollActive, queueVisibleRangeUpdate])

  useEffect(() => {
    if (!chain) return undefined
    const call = callScrollRef.current
    const put = putScrollRef.current
    if (!call || !put) return undefined
    const onCallScroll = () => syncSideScroll('call')
    const onPutScroll = () => syncSideScroll('put')
    call.addEventListener('scroll', onCallScroll, { passive: true })
    put.addEventListener('scroll', onPutScroll, { passive: true })
    return () => {
      call.removeEventListener('scroll', onCallScroll)
      put.removeEventListener('scroll', onPutScroll)
      if (scrollIdleTimerRef.current) clearTimeout(scrollIdleTimerRef.current)
      if (visibleRafRef.current) cancelAnimationFrame(visibleRafRef.current)
      visibleRafRef.current = 0
      syncingSideRef.current = ''
      call.classList.remove('oc-is-scrolling')
      put.classList.remove('oc-is-scrolling')
      strikeScrollRef.current?.classList.remove('oc-is-scrolling')
    }
  }, [chain, syncSideScroll])

  useEffect(() => {
    if (!chain) return undefined
    // After the chain paints, cache the scroll extents and set the opening
    // position (CALL scrolled fully right so LTP sits by the strike column).
    const id = requestAnimationFrame(() => {
      measureScrollExtents()
      const call = callScrollRef.current
      const put = putScrollRef.current
      const strike = strikeScrollRef.current
      if (call) call.scrollLeft = scrollMaxRef.current.call
      if (put) put.scrollLeft = 0
      if (strike) strike.scrollTop = 0
      updateVisibleRange(0, call?.clientHeight || put?.clientHeight || 0)
    })
    // The table width can change when the window/panel resizes — re-measure so
    // the cached extents (used by the per-frame sync) stay correct.
    const onResize = () => measureScrollExtents()
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(id)
      window.removeEventListener('resize', onResize)
    }
  }, [chain, measureScrollExtents, updateVisibleRange])

  const maxOi = useMemo(() => {
    if (!chain?.strikes?.length) return 0
    const values = chain.strikes.flatMap((_, i) => [Number(chain.callOI?.[i]) || 0, Number(chain.putOI?.[i]) || 0])
    return values.length ? Math.max(...values, 0) : 0
  }, [chain])
  const [spotTick] = useLiveTicks([tickKey('angel', chain?.spotToken)])
  const spotLtp = spotTick?.ltp != null ? spotTick.ltp : chain?.spot
  const isVirtual = (chain?.strikes?.length || 0) > VIRTUAL_ROW_THRESHOLD
  const rowIndexes = useMemo(() => {
    const rowCount = chain?.strikes?.length || 0
    if (!rowCount) return []
    const start = isVirtual ? Math.min(visibleRange.start, rowCount) : 0
    const measuredEnd = visibleRange.end || Math.min(rowCount, 40)
    const end = isVirtual ? Math.min(Math.max(measuredEnd, start), rowCount) : rowCount
    return Array.from({ length: end - start }, (_, offset) => start + offset)
  }, [chain, isVirtual, visibleRange])
  const renderedStart = rowIndexes[0] ?? 0
  const renderedEnd = rowIndexes.length ? rowIndexes[rowIndexes.length - 1] + 1 : 0
  const topPad = isVirtual ? renderedStart * ROW_HEIGHT : 0
  const bottomPad = isVirtual ? Math.max(0, ((chain?.strikes?.length || 0) - renderedEnd) * ROW_HEIGHT) : 0

  return (
    <Box className="oc-panel">
      <Box className="oc-controls">
        <Box className="oc-controls-main">
        <FormControl size="small" sx={{ minWidth: 150 }}>
          <InputLabel>Underlying</InputLabel>
          <Select label="Underlying" value={symbol} onChange={(e) => { setSymbol(e.target.value); setExpiry('') }}>
            <MenuItem disabled sx={{ opacity: 0.6, fontSize: '0.7rem', fontWeight: 700 }}>— INDEX —</MenuItem>
            {INDEX_UNDERLYINGS.map((u) => <MenuItem key={u} value={u}>{u}</MenuItem>)}
            <MenuItem disabled sx={{ opacity: 0.6, fontSize: '0.7rem', fontWeight: 700 }}>— MCX —</MenuItem>
            {MCX_UNDERLYINGS.map((u) => <MenuItem key={u} value={u}>{u}</MenuItem>)}
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 150 }} disabled={!expiries.length}>
          <InputLabel>Expiry</InputLabel>
          <Select label="Expiry" value={expiry} onChange={(e) => { setExpiry(e.target.value); loadChain(symbol, e.target.value) }}>
            {expiries.map((x) => <MenuItem key={x} value={x}>{x}</MenuItem>)}
          </Select>
        </FormControl>
        <Button variant="contained" startIcon={<RefreshCw size={15} />} disabled={loading} onClick={() => loadChain()}>
          {loading ? 'Loading…' : 'Load Chain'}
        </Button>

        {/* Live WebSocket controls + status — the whole point of the MCX test. */}
        <FormControl size="small" sx={{ minWidth: 120 }}>
          <InputLabel>Live feed</InputLabel>
          <Select label="Live feed" value={wsBroker} onChange={(e) => setWsBroker(e.target.value)}>
            {wsBrokerOptions.map((b) => <MenuItem key={b} value={b}>{b[0].toUpperCase() + b.slice(1)}</MenuItem>)}
          </Select>
        </FormControl>
        </Box>

        <Box className="oc-controls-status">
          {/* WebSocket status: the SOCKET being open (browser<->backend) is
              separate from the selected broker's upstream adapter being connected,
              which is separate again from ticks currently flowing. Show the honest
              state instead of conflating them. */}
          {liveStreaming
            ? <Chip size="small" color="success" className="oc-live-pulse" icon={<Zap size={13} />} label={`LIVE · ${tickCount} ticks`} />
            : wsState !== 'open'
              ? <Chip size="small" color="default" variant="outlined" icon={<ZapOff size={13} />}
                  label={wsState === 'connecting' ? 'connecting…' : 'WS off'} />
              : !wsBrokerInfo?.connected
                ? <Chip size="small" color="warning" variant="outlined" icon={<ZapOff size={13} />} label={`${wsBroker} adapter down`} />
                : <Chip size="small" color="success" variant="outlined" icon={<Zap size={13} />}
                    label={lastTickAt ? `connected · idle ${secsSinceTick}s` : 'connected · waiting for ticks'} />}
          <Radio size={14} color={angelLive ? 'var(--ao-green)' : 'var(--ao-placeholder)'} />
          <Chip size="small" color={angelLive ? 'success' : 'default'} variant={angelLive ? 'filled' : 'outlined'}
            label={angelLive ? `Angel ${feed.angel.account}` : 'Angel not in feed'} />
          <Chip size="small" color={upstoxLive ? 'success' : 'default'} variant={upstoxLive ? 'filled' : 'outlined'}
            label={upstoxLive ? `Upstox ${feed.upstox.account}` : 'Upstox not in feed'} />
          {enriching && <Chip size="small" variant="outlined" label="Hydrating Greeks" />}
          {chain && <Chip size="small" label={`Spot ${px(spotLtp)}`} variant="outlined" />}
          {chain && <Chip size="small" label={`ATM ${num(atm)}`} />}
        </Box>
      </Box>

      {/* Live-feed hint line: distinguishes socket / adapter / ticks so a quiet
          broker is never mistaken for a disconnected one. */}
      <Typography sx={{ mb: 0.5, fontSize: '0.72rem', lineHeight: 1.3, color: liveStreaming ? 'var(--ao-green)' : feedHintIsWarning ? 'var(--ao-gold)' : 'var(--ao-caption)' }}>
        {!wsBrokerInfo?.running
          ? `${wsBroker} WebSocket isn't running — log it into Feed Master to go live.`
          : wsState !== 'open'
            ? `Connecting the browser to the feed…`
            : !wsBrokerInfo?.connected
              ? `${wsBroker}'s upstream WebSocket is down on the backend (${wsBrokerInfo.lastError || 'reconnecting'}).`
              : loading
                ? `Loading ${symbol} ${expiry || ''} chain.`
              : !chain
                ? `${wsBroker} connected — Load a chain to start streaming prices.`
                : enriching
                  ? `${wsBroker} connected — enriching Bid/Ask and Greeks from Feed Master.`
                : liveStreaming
                  ? `WebSocket LIVE on ${wsBroker} — ${tickCount} ticks, last ${secsSinceTick}s ago · ${wsBrokerInfo.subscriptions || 0} subs.`
                  : `${wsBroker} connected (${wsBrokerInfo.subscriptions || 0} subs). Waiting for the next live tick; the loaded chain data remains visible.`}
      </Typography>

      {!angelLive && (
        <Typography sx={{ mb: 0.5, fontSize: '0.75rem', lineHeight: 1.3, color: 'var(--ao-gold)' }}>
          No Angel account in the feed — log one in from <b>Feed Master</b> to load the chain. Add Upstox there too for Bid/Ask.
        </Typography>
      )}
      {error && <Typography color="error" sx={{ mb: 0.5, fontSize: '0.75rem' }}>{error}</Typography>}

      <div className="oc-table-wrap">
        {loading && !chain && (
          <div className="oc-chain-skeleton">
            <div className="oc-skel-side"><div className="oc-skel-head" />{Array.from({ length: 14 }).map((_, i) => <div key={i} className="oc-skel-row" />)}</div>
            <div className="oc-skel-strike"><div className="oc-skel-head" />{Array.from({ length: 14 }).map((_, i) => <div key={i} className="oc-skel-row" />)}</div>
            <div className="oc-skel-side"><div className="oc-skel-head" />{Array.from({ length: 14 }).map((_, i) => <div key={i} className="oc-skel-row" />)}</div>
          </div>
        )}
        {!loading && !chain && <div className="oc-empty">Select an underlying (index or MCX) and load the chain</div>}
        {chain && (
          <div className="oc-split-grid">
            <div className="oc-side-scroll oc-call-scroll" ref={callScrollRef}>
              <div className="oc-side-band oc-call-band">CALL</div>
              <table className="oc-table oc-side-table">
                <colgroup>
                  <col className="oc-col-greek" /><col className="oc-col-greek" /><col className="oc-col-greek" /><col className="oc-col-greek" /><col className="oc-col-greek" />
                  <col className="oc-col-oi" /><col className="oc-col-bidask" /><col className="oc-col-ltp" />
                </colgroup>
                <thead>
                  <tr className="oc-side-head"><th className="oc-call" colSpan={8}>CALL</th></tr>
                  <tr className="oc-col-head"><th>IV</th><th>Delta</th><th>Gamma</th><th>Theta</th><th>Vega</th><th>OI</th><th>Bid / Ask</th><th className="oc-ltp">LTP</th></tr>
                </thead>
                <tbody>
                  {topPad > 0 && <tr className="oc-virtual-spacer"><td colSpan={8} style={{ height: topPad }} /></tr>}
                  {rowIndexes.map((i) => {
                    const strike = chain.strikes[i]
                    const cg = up?.callGreeks?.[i]
                    return (
                      <CallRow
                        key={strike}
                        strike={strike}
                        isAtm={strike === atm}
                        itm={!!(atm && strike < atm)}
                        restIv={cg?.iv}
                        restDelta={cg?.delta}
                        restGamma={cg?.gamma}
                        restTheta={cg?.theta}
                        restVega={cg?.vega}
                        restOi={chain.callOI?.[i]}
                        restBid={up?.callBid?.[i]}
                        restAsk={up?.callAsk?.[i]}
                        restLtp={chain.callLtp?.[i]}
                        maxOi={maxOi}
                        angelToken={chain.callTokens?.[i]}
                        upToken={upTokens.callTokens?.[i]}
                        wsBroker={wsBroker}
                      />
                    )
                  })}
                  {bottomPad > 0 && <tr className="oc-virtual-spacer"><td colSpan={8} style={{ height: bottomPad }} /></tr>}
                </tbody>
              </table>
            </div>

            <div className="oc-strike-pane" ref={strikeScrollRef}>
              <table className="oc-table oc-strike-table">
                <thead>
                  <tr className="oc-side-head"><th className="oc-strike">STRIKE</th></tr>
                  <tr className="oc-col-head"><th className="oc-strike-col">Strike</th></tr>
                </thead>
                <tbody>
                  {topPad > 0 && <tr className="oc-virtual-spacer"><td style={{ height: topPad }} /></tr>}
                  {rowIndexes.map((i) => {
                    const strike = chain.strikes[i]
                    return <StrikeRow key={strike} strike={strike} isAtm={strike === atm} />
                  })}
                  {bottomPad > 0 && <tr className="oc-virtual-spacer"><td style={{ height: bottomPad }} /></tr>}
                </tbody>
              </table>
            </div>

            <div className="oc-side-scroll oc-put-scroll" ref={putScrollRef}>
              <div className="oc-side-band oc-put-band">PUT</div>
              <table className="oc-table oc-side-table">
                <colgroup>
                  <col className="oc-col-ltp" /><col className="oc-col-bidask" /><col className="oc-col-oi" />
                  <col className="oc-col-greek" /><col className="oc-col-greek" /><col className="oc-col-greek" /><col className="oc-col-greek" /><col className="oc-col-greek" />
                </colgroup>
                <thead>
                  <tr className="oc-side-head"><th className="oc-put" colSpan={8}>PUT</th></tr>
                  <tr className="oc-col-head"><th className="oc-ltp">LTP</th><th>Bid / Ask</th><th>OI</th><th>IV</th><th>Delta</th><th>Gamma</th><th>Theta</th><th>Vega</th></tr>
                </thead>
                <tbody>
                  {topPad > 0 && <tr className="oc-virtual-spacer"><td colSpan={8} style={{ height: topPad }} /></tr>}
                  {rowIndexes.map((i) => {
                    const strike = chain.strikes[i]
                    const pg = up?.putGreeks?.[i]
                    return (
                      <PutRow
                        key={strike}
                        strike={strike}
                        isAtm={strike === atm}
                        itm={!!(atm && strike > atm)}
                        restIv={pg?.iv}
                        restDelta={pg?.delta}
                        restGamma={pg?.gamma}
                        restTheta={pg?.theta}
                        restVega={pg?.vega}
                        restOi={chain.putOI?.[i]}
                        restBid={up?.putBid?.[i]}
                        restAsk={up?.putAsk?.[i]}
                        restLtp={chain.putLtp?.[i]}
                        maxOi={maxOi}
                        angelToken={chain.putTokens?.[i]}
                        upToken={upTokens.putTokens?.[i]}
                        wsBroker={wsBroker}
                      />
                    )
                  })}
                  {bottomPad > 0 && <tr className="oc-virtual-spacer"><td colSpan={8} style={{ height: bottomPad }} /></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Box>
  )
}
