// Data layer for the STANDALONE mini chain window (/#/mini).
//
// The in-page widget is fed by the full OptionChain component. This hook is for
// the pop-out window, which has no parent to feed it — it loads its own chain
// and drives its own WebSocket.
//
// It deliberately fetches far less than the full chain: no greeks hydration, no
// bid/ask, no OI. Only what a premium ticker needs — strikes, ATM, spot, and the
// per-strike option tokens to subscribe with.

import { useCallback, useEffect, useRef, useState } from 'react'
import { liveTickStore } from './chainLive'
import { chainExchangeFor, upstoxExchange } from './chainSymbols'

export function useMiniChainFeed(symbol, expiry, wsBroker) {
  const [chain, setChain] = useState(null)
  const [upTokens, setUpTokens] = useState({ callTokens: [], putTokens: [] })
  const [wsBrokers, setWsBrokers] = useState({})
  const [wsState, setWsState] = useState('idle')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const wsRef = useRef(null)
  const subTokensRef = useRef([])
  const loadSeqRef = useRef(0)

  // Which broker adapters are actually running upstream.
  useEffect(() => {
    let alive = true
    const poll = () => {
      fetch('/api/ws/feed/status')
        .then((r) => r.json())
        .then((j) => { if (alive && j.status) setWsBrokers(j.brokers || {}) })
        .catch(() => {})
    }
    poll()
    const timer = setInterval(poll, 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  const ensureSocket = useCallback(() => {
    const existing = wsRef.current
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return existing

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/feed`)
    wsRef.current = ws
    setWsState('connecting')
    ws.onopen = () => {
      setWsState('open')
      const pending = subTokensRef.current
      for (const broker of new Set(pending.map((i) => i.broker))) {
        const instruments = pending.filter((i) => i.broker === broker)
        if (instruments.length) ws.send(JSON.stringify({ action: 'subscribe', broker, mode: 3, instruments }))
      }
    }
    ws.onclose = () => { setWsState('closed'); wsRef.current = null }
    ws.onerror = () => setWsState('closed')
    ws.onmessage = (ev) => {
      let m
      try { m = JSON.parse(ev.data) } catch { return }
      if (m.type !== 'tick') return
      liveTickStore.setBatch({
        [`${m.broker}|${m.token}`]: { ltp: m.ltp, oi: m.oi, close: m.close, bid: m.bid, ask: m.ask, ts: m.ts },
      }, 1)
    }
    return ws
  }, [])

  // Point the socket at the loaded chain's options.
  //
  // CRITICAL (same rule as the full chain): each broker MUST get ITS OWN tokens.
  // Angel tokens are bare numbers (570229); Upstox tokens are instrument keys
  // (MCX_FO|570229). Crossing them yields no ticks at all.
  const subscribeLive = useCallback((body, upMap) => {
    if (!body) return
    const instruments = []
    const pushTok = (broker, exchange, token) => {
      if (token != null && token !== '') instruments.push({ broker, exchange, token: String(token) })
    }
    const exchange = body.exchange || chainExchangeFor(body.symbol)

    if (wsBrokers.angel?.running) {
      ;(body.callTokens || []).forEach((t) => pushTok('angel', exchange, t))
      ;(body.putTokens || []).forEach((t) => pushTok('angel', exchange, t))
      pushTok('angel', body.spotExchange || exchange, body.spotToken)
    }
    if (wsBrokers.upstox?.running) {
      const upEx = upstoxExchange(exchange)
      ;(upMap.callTokens || []).forEach((t) => pushTok('upstox', upEx, t))
      ;(upMap.putTokens || []).forEach((t) => pushTok('upstox', upEx, t))
    }

    const ws = ensureSocket()
    const prev = subTokensRef.current
    if (prev.length && ws.readyState === WebSocket.OPEN) {
      for (const broker of new Set(prev.map((i) => i.broker))) {
        ws.send(JSON.stringify({ action: 'unsubscribe', broker, instruments: prev.filter((i) => i.broker === broker) }))
      }
    }
    subTokensRef.current = instruments
    liveTickStore.reset()
    if (ws.readyState === WebSocket.OPEN) {
      for (const broker of new Set(instruments.map((i) => i.broker))) {
        ws.send(JSON.stringify({ action: 'subscribe', broker, mode: 3, instruments: instruments.filter((i) => i.broker === broker) }))
      }
    }
  }, [ensureSocket, wsBrokers])

  // Load the chain whenever symbol/expiry changes.
  useEffect(() => {
    if (!symbol || !expiry) return undefined
    const seq = loadSeqRef.current + 1
    loadSeqRef.current = seq
    setLoading(true); setError(''); setChain(null); setUpTokens({ callTokens: [], putTokens: [] })

    ;(async () => {
      try {
        const res = await fetch('/api/feed/option-chain', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol, expiry, fast: true }),
        })
        const body = await res.json()
        if (seq !== loadSeqRef.current) return
        if (!res.ok || body.status === false) throw new Error(body.message || 'Chain load failed')
        setChain(body)
        setLoading(false)

        // Upstox keys are best-effort: without them we still get Angel LTPs.
        let upMap = { callTokens: [], putTokens: [] }
        try {
          const tokRes = await fetch('/api/ws/feed/map-tokens', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              broker: 'upstox',
              exchange: body.exchange || chainExchangeFor(symbol),
              callSymbols: body.callSymbols || [],
              putSymbols: body.putSymbols || [],
            }),
          })
          const j = await tokRes.json()
          if (j.status) upMap = { callTokens: j.callTokens || [], putTokens: j.putTokens || [] }
        } catch { /* Angel-only is fine */ }
        if (seq !== loadSeqRef.current) return
        setUpTokens(upMap)
      } catch (e) {
        if (seq === loadSeqRef.current) { setError(e.message); setLoading(false) }
      }
    })()

    return undefined
  }, [symbol, expiry])

  // (Re)subscribe when the chain, the token map, or the running adapters change.
  useEffect(() => {
    if (chain) subscribeLive(chain, upTokens)
  }, [chain, upTokens, subscribeLive])

  useEffect(() => () => { try { wsRef.current?.close() } catch { /* ignore */ } }, [])

  return { chain, upTokens, wsState, wsBrokers, loading, error }
}
