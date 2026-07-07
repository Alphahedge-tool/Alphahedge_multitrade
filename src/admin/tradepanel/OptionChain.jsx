import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, Chip, FormControl, InputLabel, MenuItem, Select, Typography } from '@mui/material'
import { RefreshCw, Radio, Zap, ZapOff } from 'lucide-react'
import './optionchain.css'

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
  const [ticks, setTicks] = useState({})           // "broker|token" -> { ltp, oi, bid, ask, ts }
  const [tickCount, setTickCount] = useState(0)
  const [lastTickAt, setLastTickAt] = useState(0)
  const wsRef = useRef(null)
  const pendingTicksRef = useRef({})
  const pendingTickCountRef = useRef(0)
  const tickFlushRafRef = useRef(0)
  const subTokensRef = useRef([])                  // [{ broker, exchange, token }] currently subscribed
  const callScrollRef = useRef(null)
  const putScrollRef = useRef(null)
  const strikeScrollRef = useRef(null)
  const syncingSideRef = useRef('')
  const scrollSyncRafRef = useRef(0)
  const scrollIdleTimerRef = useRef(0)
  const loadSeqRef = useRef(0)
  // Upstox token per strike-index (for live Bid/Ask), resolved from the master.
  const [upTokens, setUpTokens] = useState({ callTokens: [], putTokens: [] })

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
    pendingTicksRef.current[key] = {
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
    }
    pendingTickCountRef.current += 1
    if (tickFlushRafRef.current) return
    tickFlushRafRef.current = requestAnimationFrame(() => {
      const patch = pendingTicksRef.current
      const count = pendingTickCountRef.current
      pendingTicksRef.current = {}
      pendingTickCountRef.current = 0
      tickFlushRafRef.current = 0
      setTicks((prev) => ({ ...prev, ...patch }))
      setTickCount((c) => c + count)
      setLastTickAt(Date.now())
    })
  }

  // Connect once; the socket stays open and we (un)subscribe as chains change.
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
    pendingTicksRef.current = {}
    pendingTickCountRef.current = 0
    if (tickFlushRafRef.current) cancelAnimationFrame(tickFlushRafRef.current)
    tickFlushRafRef.current = 0
    setTicks({}); setTickCount(0); setLastTickAt(0)
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
    if (tickFlushRafRef.current) cancelAnimationFrame(tickFlushRafRef.current)
    try { wsRef.current?.close() } catch { /* ignore */ }
  }, [])

  // Freshness: a tick within the last 3s means the feed is genuinely live.
  const [, forceTick] = useState(0)
  useEffect(() => { const t = setInterval(() => forceTick((n) => n + 1), 1000); return () => clearInterval(t) }, [])
  const secsSinceTick = lastTickAt ? Math.floor((Date.now() - lastTickAt) / 1000) : null
  const liveStreaming = wsState === 'open' && secsSinceTick != null && secsSinceTick <= 3

  const atm = chain?.atm
  const up = chain?.upstox?.aligned
  const num = (v) => (v == null ? '—' : Number(v).toLocaleString('en-IN'))
  const px = (v) => (v == null ? '—' : Number(v).toFixed(2))

  const greek = (v, digits = 2) => (v == null || Number.isNaN(Number(v)) ? 'â€”' : Number(v).toFixed(digits))

  const angelLive = !!feed.angel
  const upstoxLive = !!feed.upstox

  // Which brokers currently have a running WS adapter (so we only offer those).
  const wsBrokerOptions = useMemo(() => {
    const running = Object.keys(wsBrokers).filter((b) => wsBrokers[b]?.running)
    return running.length ? running : ['angel', 'upstox', 'kotak', 'nubra']
  }, [wsBrokers])
  const wsBrokerInfo = wsBrokers[wsBroker]
  const feedHintIsWarning = !wsBrokerInfo?.running || (wsState === 'open' && wsBrokerInfo && !wsBrokerInfo.connected)

  // Per-strike live ticks from each broker. Angel ticks are keyed by Angel's
  // option token; Upstox ticks by its instrument key (both aligned to the chain's
  // strike order via the call/put token arrays).
  const angelTick = (i, side) => {
    const token = (side === 'call' ? chain?.callTokens : chain?.putTokens)?.[i]
    return token != null ? ticks[`angel|${token}`] : null
  }
  const upTick = (i, side) => {
    const token = (side === 'call' ? upTokens.callTokens : upTokens.putTokens)?.[i]
    return token != null ? ticks[`upstox|${token}`] : null
  }

  const markScrollActive = useCallback(() => {
    const panes = [callScrollRef.current, putScrollRef.current, strikeScrollRef.current]
    panes.forEach((pane) => pane?.classList.add('oc-is-scrolling'))
    if (scrollIdleTimerRef.current) clearTimeout(scrollIdleTimerRef.current)
    scrollIdleTimerRef.current = window.setTimeout(() => {
      panes.forEach((pane) => pane?.classList.remove('oc-is-scrolling'))
      scrollIdleTimerRef.current = 0
    }, 140)
  }, [])

  const syncSideScroll = useCallback((side) => {
    markScrollActive()
    const source = side === 'call' ? callScrollRef.current : putScrollRef.current
    const target = side === 'call' ? putScrollRef.current : callScrollRef.current
    const strike = strikeScrollRef.current
    if (!source || !target || syncingSideRef.current) return
    if (scrollSyncRafRef.current) return
    scrollSyncRafRef.current = requestAnimationFrame(() => {
      const sourceMax = Math.max(1, source.scrollWidth - source.clientWidth)
      const targetMax = Math.max(0, target.scrollWidth - target.clientWidth)
      const progress = side === 'call' ? 1 - (source.scrollLeft / sourceMax) : source.scrollLeft / sourceMax
      const nextLeft = side === 'call' ? progress * targetMax : (1 - progress) * targetMax

      syncingSideRef.current = side
      if (Math.abs(target.scrollLeft - nextLeft) > 0.5) target.scrollLeft = nextLeft
      if (Math.abs(target.scrollTop - source.scrollTop) > 0.5) target.scrollTop = source.scrollTop
      if (strike && Math.abs(strike.scrollTop - source.scrollTop) > 0.5) strike.scrollTop = source.scrollTop
      scrollSyncRafRef.current = 0
      requestAnimationFrame(() => {
        syncingSideRef.current = ''
      })
    })
  }, [markScrollActive])

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
      if (scrollSyncRafRef.current) cancelAnimationFrame(scrollSyncRafRef.current)
      if (scrollIdleTimerRef.current) clearTimeout(scrollIdleTimerRef.current)
      scrollSyncRafRef.current = 0
      syncingSideRef.current = ''
      call.classList.remove('oc-is-scrolling')
      put.classList.remove('oc-is-scrolling')
      strikeScrollRef.current?.classList.remove('oc-is-scrolling')
    }
  }, [chain, syncSideScroll])

  useEffect(() => {
    if (!chain) return
    const id = requestAnimationFrame(() => {
      const call = callScrollRef.current
      const put = putScrollRef.current
      const strike = strikeScrollRef.current
      if (call) call.scrollLeft = Math.max(0, call.scrollWidth - call.clientWidth)
      if (put) put.scrollLeft = 0
      if (strike) strike.scrollTop = 0
    })
    return () => cancelAnimationFrame(id)
  }, [chain])

  // LTP: prefer the "Live feed" broker's tick, then the other broker's, then REST.
  const liveLtp = (i, side, restLtp) => {
    const a = angelTick(i, side), u = upTick(i, side)
    const first = wsBroker === 'upstox' ? [u, a] : [a, u]
    for (const t of first) if (t && t.ltp != null) return t.ltp
    return restLtp
  }
  const ltpIsLive = (i, side) => {
    const a = angelTick(i, side), u = upTick(i, side)
    return (a?.ltp != null) || (u?.ltp != null)
  }
  // OI: Angel is authoritative (Upstox also carries oi; use whichever ticked).
  const liveOi = (i, side, restOi) => {
    const a = angelTick(i, side), u = upTick(i, side)
    if (a?.oi != null) return a.oi
    if (u?.oi != null) return u.oi
    return restOi
  }
  const maxOi = useMemo(() => {
    if (!chain?.strikes?.length) return 0
    const values = chain.strikes.flatMap((_, i) => {
      const callToken = chain.callTokens?.[i]
      const putToken = chain.putTokens?.[i]
      const upCallToken = upTokens.callTokens?.[i]
      const upPutToken = upTokens.putTokens?.[i]
      const callOi = ticks[`angel|${callToken}`]?.oi ?? ticks[`upstox|${upCallToken}`]?.oi ?? chain.callOI?.[i] ?? 0
      const putOi = ticks[`angel|${putToken}`]?.oi ?? ticks[`upstox|${upPutToken}`]?.oi ?? chain.putOI?.[i] ?? 0
      return [Number(callOi) || 0, Number(putOi) || 0]
    })
    return values.length ? Math.max(...values, 0) : 0
  }, [chain, ticks, upTokens])
  // Bid/Ask: prefer Upstox depth, then Angel depth, then the REST chain value.
  const liveBid = (i, side, restVal) => {
    const u = upTick(i, side), a = angelTick(i, side)
    if (u?.bid != null) return u.bid
    if (a?.bid != null) return a.bid
    return restVal
  }
  const liveAsk = (i, side, restVal) => {
    const u = upTick(i, side), a = angelTick(i, side)
    if (u?.ask != null) return u.ask
    if (a?.ask != null) return a.ask
    return restVal
  }
  const liveGreek = (i, side, field, restVal) => {
    const u = upTick(i, side)
    if (field === 'iv' && u?.iv != null) return u.iv
    if (u?.greeks?.[field] != null) return u.greeks[field]
    return restVal
  }

  // Spot LTP: live Angel future/spot tick if present, else the REST spot.
  const spotLtp = (() => {
    const t = chain?.spotToken != null ? ticks[`angel|${chain.spotToken}`] : null
    return t?.ltp != null ? t.ltp : chain?.spot
  })()

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
                  {chain.strikes.map((strike, i) => {
                    const isAtm = strike === atm
                    const cItm = atm && strike < atm
                    const cg = up?.callGreeks?.[i]
                    const cLtp = liveLtp(i, 'call', chain.callLtp?.[i])
                    const cLive = ltpIsLive(i, 'call')
                    const cOi = Number(liveOi(i, 'call', chain.callOI?.[i]) ?? 0)
                    const cOiWidth = maxOi ? Math.round((cOi / maxOi) * 100) : 0
                    const cBid = liveBid(i, 'call', up?.callBid?.[i]), cAsk = liveAsk(i, 'call', up?.callAsk?.[i])
                    const cBaLive = upTick(i, 'call')?.bid != null || angelTick(i, 'call')?.bid != null
                    const cIv = liveGreek(i, 'call', 'iv', cg?.iv)
                    const cDelta = liveGreek(i, 'call', 'delta', cg?.delta)
                    const cGamma = liveGreek(i, 'call', 'gamma', cg?.gamma)
                    const cTheta = liveGreek(i, 'call', 'theta', cg?.theta)
                    const cVega = liveGreek(i, 'call', 'vega', cg?.vega)
                    return (
                      <tr key={strike} className={`oc-row${isAtm ? ' oc-atm' : ''}`}>
                        <td className="oc-greek">{greek(cIv, 1)}</td>
                        <td className="oc-greek">{greek(cDelta, 3)}</td>
                        <td className="oc-greek">{greek(cGamma, 4)}</td>
                        <td className="oc-greek">{greek(cTheta, 2)}</td>
                        <td className="oc-greek">{greek(cVega, 2)}</td>
                        <td className={`oc-oi oc-call-oi${cItm ? ' oc-itm' : ''}`}><span className="oc-oi-bar" style={{ width: `${cOiWidth}%` }} /><span className="oc-oi-val">{num(cOi)}</span></td>
                        <td className={`oc-bidask${cBaLive ? ' oc-live' : ''}`}><span className="oc-bid">{px(cBid)}</span><span className="oc-sep">/</span><span className="oc-ask">{px(cAsk)}</span></td>
                        <td className={`oc-ltp${cItm ? ' oc-itm' : ''}${cLive ? ' oc-live' : ''}`}>{px(cLtp)}</td>
                      </tr>
                    )
                  })}
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
                  {chain.strikes.map((strike) => (
                    <tr key={strike} className={`oc-row${strike === atm ? ' oc-atm' : ''}`}>
                      <td className="oc-strike-cell">{num(strike)}</td>
                    </tr>
                  ))}
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
                  {chain.strikes.map((strike, i) => {
                    const isAtm = strike === atm
                    const pItm = atm && strike > atm
                    const pg = up?.putGreeks?.[i]
                    const pLtp = liveLtp(i, 'put', chain.putLtp?.[i])
                    const pLive = ltpIsLive(i, 'put')
                    const pOi = Number(liveOi(i, 'put', chain.putOI?.[i]) ?? 0)
                    const pOiWidth = maxOi ? Math.round((pOi / maxOi) * 100) : 0
                    const pBid = liveBid(i, 'put', up?.putBid?.[i]), pAsk = liveAsk(i, 'put', up?.putAsk?.[i])
                    const pBaLive = upTick(i, 'put')?.bid != null || angelTick(i, 'put')?.bid != null
                    const pIv = liveGreek(i, 'put', 'iv', pg?.iv)
                    const pDelta = liveGreek(i, 'put', 'delta', pg?.delta)
                    const pGamma = liveGreek(i, 'put', 'gamma', pg?.gamma)
                    const pTheta = liveGreek(i, 'put', 'theta', pg?.theta)
                    const pVega = liveGreek(i, 'put', 'vega', pg?.vega)
                    return (
                      <tr key={strike} className={`oc-row${isAtm ? ' oc-atm' : ''}`}>
                        <td className={`oc-ltp${pItm ? ' oc-itm' : ''}${pLive ? ' oc-live' : ''}`}>{px(pLtp)}</td>
                        <td className={`oc-bidask${pBaLive ? ' oc-live' : ''}`}><span className="oc-bid">{px(pBid)}</span><span className="oc-sep">/</span><span className="oc-ask">{px(pAsk)}</span></td>
                        <td className={`oc-oi oc-put-oi${pItm ? ' oc-itm' : ''}`}><span className="oc-oi-bar" style={{ width: `${pOiWidth}%` }} /><span className="oc-oi-val">{num(pOi)}</span></td>
                        <td className="oc-greek">{greek(pIv, 1)}</td>
                        <td className="oc-greek">{greek(pDelta, 3)}</td>
                        <td className="oc-greek">{greek(pGamma, 4)}</td>
                        <td className="oc-greek">{greek(pTheta, 2)}</td>
                        <td className="oc-greek">{greek(pVega, 2)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <table className="oc-table">
          <colgroup>
            <col className="oc-col-oi" />
            <col className="oc-col-bidask" />
            <col className="oc-col-ltp" />
            <col className="oc-col-greek" />
            <col className="oc-col-greek" />
            <col className="oc-col-greek" />
            <col className="oc-col-greek" />
            <col className="oc-col-greek" />
            <col className="oc-col-strike" />
            <col className="oc-col-greek" />
            <col className="oc-col-greek" />
            <col className="oc-col-greek" />
            <col className="oc-col-greek" />
            <col className="oc-col-greek" />
            <col className="oc-col-ltp" />
            <col className="oc-col-bidask" />
            <col className="oc-col-oi" />
          </colgroup>
          <thead>
            <tr className="oc-side-head">
              <th className="oc-call" colSpan={8}>CALL</th>
              <th className="oc-strike">STRIKE</th>
              <th className="oc-put" colSpan={8}>PUT</th>
            </tr>
            <tr className="oc-col-head">
              <th>OI</th><th>Bid / Ask</th><th className="oc-ltp">LTP</th><th>IV</th><th>Delta</th><th>Gamma</th><th>Theta</th><th>Vega</th>
              <th className="oc-strike-col">Strike</th>
              <th>Vega</th><th>Theta</th><th>Gamma</th><th>Delta</th><th>IV</th><th className="oc-ltp">LTP</th><th>Bid / Ask</th><th>OI</th>
            </tr>
          </thead>
          <tbody>
            {!chain && <tr><td className="oc-empty" colSpan={17}>Select an underlying (index or MCX) and load the chain</td></tr>}
            {(chain?.strikes || []).map((strike, i) => {
              const isAtm = strike === atm
              const cItm = atm && strike < atm, pItm = atm && strike > atm
              const cg = up?.callGreeks?.[i], pg = up?.putGreeks?.[i]
              const cLtp = liveLtp(i, 'call', chain.callLtp?.[i])
              const pLtp = liveLtp(i, 'put', chain.putLtp?.[i])
              const cLive = ltpIsLive(i, 'call')
              const pLive = ltpIsLive(i, 'put')
              const cOi = Number(liveOi(i, 'call', chain.callOI?.[i]) ?? 0)
              const pOi = Number(liveOi(i, 'put', chain.putOI?.[i]) ?? 0)
              const cOiWidth = maxOi ? Math.round((cOi / maxOi) * 100) : 0
              const pOiWidth = maxOi ? Math.round((pOi / maxOi) * 100) : 0
              // Bid/Ask: prefer the live Upstox tick, else the REST chain's aligned value.
              const cBid = liveBid(i, 'call', up?.callBid?.[i]), cAsk = liveAsk(i, 'call', up?.callAsk?.[i])
              const pBid = liveBid(i, 'put', up?.putBid?.[i]), pAsk = liveAsk(i, 'put', up?.putAsk?.[i])
              const cBaLive = upTick(i, 'call')?.bid != null || angelTick(i, 'call')?.bid != null
              const pBaLive = upTick(i, 'put')?.bid != null || angelTick(i, 'put')?.bid != null
              const cIv = liveGreek(i, 'call', 'iv', cg?.iv)
              const cDelta = liveGreek(i, 'call', 'delta', cg?.delta)
              const cGamma = liveGreek(i, 'call', 'gamma', cg?.gamma)
              const cTheta = liveGreek(i, 'call', 'theta', cg?.theta)
              const cVega = liveGreek(i, 'call', 'vega', cg?.vega)
              const pIv = liveGreek(i, 'put', 'iv', pg?.iv)
              const pDelta = liveGreek(i, 'put', 'delta', pg?.delta)
              const pGamma = liveGreek(i, 'put', 'gamma', pg?.gamma)
              const pTheta = liveGreek(i, 'put', 'theta', pg?.theta)
              const pVega = liveGreek(i, 'put', 'vega', pg?.vega)
              return (
                <tr key={strike} className={`oc-row${isAtm ? ' oc-atm' : ''}`}>
                  <td className={`oc-oi oc-call-oi${cItm ? ' oc-itm' : ''}`}>
                    <span className="oc-oi-bar" style={{ width: `${cOiWidth}%` }} />
                    <span className="oc-oi-val">{num(cOi)}</span>
                  </td>
                  <td className={`oc-bidask${cBaLive ? ' oc-live' : ''}`}>
                    <span className="oc-bid">{px(cBid)}</span>
                    <span className="oc-sep">/</span>
                    <span className="oc-ask">{px(cAsk)}</span>
                  </td>
                  <td className={`oc-ltp${cItm ? ' oc-itm' : ''}${cLive ? ' oc-live' : ''}`}>{px(cLtp)}</td>
                  <td className="oc-iv">{cg?.iv != null ? Number(cg.iv).toFixed(1) : '—'}</td>
                  <td className="oc-greek">{greek(cDelta, 3)}</td>
                  <td className="oc-greek">{greek(cGamma, 4)}</td>
                  <td className="oc-greek">{greek(cTheta, 2)}</td>
                  <td className="oc-greek">{greek(cVega, 2)}</td>
                  <td className="oc-strike-cell">{num(strike)}</td>
                  <td className="oc-greek">{greek(pVega, 2)}</td>
                  <td className="oc-greek">{greek(pTheta, 2)}</td>
                  <td className="oc-greek">{greek(pGamma, 4)}</td>
                  <td className="oc-greek">{greek(pDelta, 3)}</td>
                  <td className="oc-iv">{pg?.iv != null ? Number(pg.iv).toFixed(1) : '—'}</td>
                  <td className={`oc-ltp${pItm ? ' oc-itm' : ''}${pLive ? ' oc-live' : ''}`}>{px(pLtp)}</td>
                  <td className={`oc-bidask${pBaLive ? ' oc-live' : ''}`}>
                    <span className="oc-bid">{px(pBid)}</span>
                    <span className="oc-sep">/</span>
                    <span className="oc-ask">{px(pAsk)}</span>
                  </td>
                  <td className={`oc-oi oc-put-oi${pItm ? ' oc-itm' : ''}`}>
                    <span className="oc-oi-bar" style={{ width: `${pOiWidth}%` }} />
                    <span className="oc-oi-val">{num(pOi)}</span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Box>
  )
}
