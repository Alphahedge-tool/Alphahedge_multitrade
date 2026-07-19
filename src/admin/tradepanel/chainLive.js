// Shared live-tick layer for the option chain views.
//
// The tick store is a module singleton on purpose: the full chain owns the
// WebSocket and pushes every tick in here, and any other view (the mini widget)
// reads the SAME store. That means opening the mini widget costs zero extra
// subscriptions — it just renders a narrower slice of what's already streaming.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'

export const DASH = '-'
export const ROW_HEIGHT = 34

const inrFormatter = new Intl.NumberFormat('en-IN')
export const num = (v) => (v == null ? DASH : inrFormatter.format(Number(v)))
export const px = (v) => (v == null ? DASH : Number(v).toFixed(2))
export const greek = (v, digits = 2) => (v == null || Number.isNaN(Number(v)) ? DASH : Number(v).toFixed(digits))
export const tickKey = (broker, token) => (token != null && token !== '' ? `${broker}|${token}` : '')
export const oiWidth = (oi, maxOi) => (maxOi ? Math.min(100, Math.round(((Number(oi) || 0) / maxOi) * 100)) : 0)

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

export const liveTickStore = createLiveTickStore()

export function useLiveTicks(keys) {
  const keySig = keys.join('|')
  const stableKeys = useMemo(() => keys, [keySig])
  useSyncExternalStore(
    useCallback((listener) => liveTickStore.subscribeKeys(stableKeys, listener), [stableKeys]),
    useCallback(() => liveTickStore.getVersion(stableKeys), [stableKeys]),
    () => ''
  )
  return stableKeys.map((key) => liveTickStore.getTick(key))
}

export function useLiveMeta() {
  const [, refresh] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => refresh((n) => n + 1), 500)
    return () => clearInterval(timer)
  }, [])
  return liveTickStore.getMeta()
}

export function liveLtpFromTicks(angelTick, upTick, preferredBroker, restLtp) {
  const first = preferredBroker === 'upstox' ? [upTick, angelTick] : [angelTick, upTick]
  for (const tick of first) if (tick?.ltp != null) return tick.ltp
  return restLtp
}

export function liveOiFromTicks(angelTick, upTick, restOi) {
  if (angelTick?.oi != null) return angelTick.oi
  if (upTick?.oi != null) return upTick.oi
  return restOi
}

export function liveBidFromTicks(angelTick, upTick, restBid) {
  if (upTick?.bid != null) return upTick.bid
  if (angelTick?.bid != null) return angelTick.bid
  return restBid
}

export function liveAskFromTicks(angelTick, upTick, restAsk) {
  if (upTick?.ask != null) return upTick.ask
  if (angelTick?.ask != null) return angelTick.ask
  return restAsk
}

export function liveGreekFromTicks(upTick, field, restVal) {
  if (field === 'iv' && upTick?.iv != null) return upTick.iv
  if (upTick?.greeks?.[field] != null) return upTick.greeks[field]
  return restVal
}
