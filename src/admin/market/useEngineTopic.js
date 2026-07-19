import { useEffect, useMemo, useRef, useState } from 'react'

// useEngineTopic subscribes to a server-side derived series (OI / premium
// decay) over the existing /ws/feed socket and returns each point as the
// backend computes it.
//
// This replaces a 1Hz HTTP poll. The poll cost a full Upstox option-chain fetch
// per tick per tab; the engine holds the contracts subscribed on one upstream
// WebSocket and folds them server-side, so N tabs share one subscription and
// one computation.
//
// `point` is a fresh object per push, so an effect keyed on it fires exactly
// once per computed point.

const MAX_BACKOFF_MS = 15000

export function useEngineTopic({ symbol, expiry, strikes, enabled }) {
  const [point, setPoint] = useState(null)
  const [history, setHistory] = useState(null)
  const [status, setStatus] = useState('offline')
  const [error, setError] = useState('')
  const topicRef = useRef(null)

  // Sorted + stringified so a re-render with an equivalent strike array does
  // not tear down and rebuild the subscription.
  const strikesKey = useMemo(() => (
    [...new Set((strikes || []).map(Number).filter(Number.isFinite))]
      .sort((a, b) => a - b)
      .join(',')
  ), [strikes])

  const active = Boolean(enabled && symbol && expiry && strikesKey)

  useEffect(() => {
    if (!active) {
      setStatus('offline')
      return undefined
    }

    let socket = null
    let retryTimer = 0
    let attempts = 0
    let stopped = false

    const schedule = () => {
      if (stopped || retryTimer) return
      const delay = Math.min(1000 * (2 ** attempts), MAX_BACKOFF_MS)
      attempts += 1
      retryTimer = window.setTimeout(() => {
        retryTimer = 0
        connect()
      }, delay)
    }

    const connect = () => {
      if (stopped) return
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      setStatus('connecting')
      socket = new WebSocket(`${protocol}://${window.location.host}/ws/feed`)

      socket.onopen = () => {
        attempts = 0
        socket.send(JSON.stringify({
          action: 'engine_subscribe',
          symbol,
          expiry,
          strikes: strikesKey.split(',').map(Number),
        }))
      }

      socket.onmessage = (event) => {
        let message
        try { message = JSON.parse(event.data) } catch { return }

        if (message.type === 'engine_subscribed') {
          topicRef.current = message.topicId
          setStatus('live')
          setError('')
          // Whatever the topic already accumulated — lets a reconnecting client
          // fill the gap it missed instead of leaving a hole in the chart.
          if (message.history && !message.duplicate) setHistory(message.history)
          return
        }
        if (message.type === 'engine_point' && message.topicId === topicRef.current) {
          setStatus('live')
          setPoint(message.point)
          return
        }
        if (message.type === 'error') {
          setError(message.message || 'Engine subscription failed')
          setStatus('error')
        }
      }

      socket.onerror = () => setStatus('offline')
      socket.onclose = () => {
        if (stopped) return
        setStatus('offline')
        schedule()
      }
    }

    connect()
    return () => {
      stopped = true
      window.clearTimeout(retryTimer)
      // Release the topic explicitly when we can. The server also releases on
      // socket close, so a dead socket here is harmless.
      try {
        if (socket?.readyState === WebSocket.OPEN && topicRef.current) {
          socket.send(JSON.stringify({ action: 'engine_unsubscribe', topicId: topicRef.current }))
        }
        socket?.close()
      } catch { /* already closed */ }
      topicRef.current = null
    }
  }, [active, symbol, expiry, strikesKey])

  return { point, history, status, error }
}
