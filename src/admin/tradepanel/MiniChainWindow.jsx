// The STANDALONE mini chain — what the installed desktop app opens at /#/mini.
//
// This is the whole window: no admin sidebar, no StartupGate (the backend it
// talks to is already logged in; re-running broker logins from a ticker window
// would be wrong). Just a compact CALL LTP | STRIKE | PUT LTP ladder.

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { liveLtpFromTicks, num, px, tickKey, useLiveMeta, useLiveTicks } from './chainLive'
import { INDEX_UNDERLYINGS, MCX_UNDERLYINGS } from './chainSymbols'
import { useMiniChainFeed } from './useMiniChainFeed'
import './optionchain.css'

const WINDOWS = [5, 10, 20, 0]
const windowLabel = (n) => (n ? `±${n}` : 'All')
const PREFS_KEY = 'alphahedge-mini-chain'

// Last symbol/expiry/window, so relaunching the desktop widget comes back to the
// same ladder instead of resetting to NIFTY every morning.
function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')
    return {
      symbol: saved.symbol || 'NIFTY',
      expiry: saved.expiry || '',
      window: WINDOWS.includes(saved.window) ? saved.window : 10,
    }
  } catch {
    return { symbol: 'NIFTY', expiry: '', window: 10 }
  }
}

const MiniRow = memo(function MiniRow({
  strike, isAtm, restCallLtp, restPutLtp, callAngelToken, callUpToken, putAngelToken, putUpToken, wsBroker,
}) {
  const [callAngel, callUp, putAngel, putUp] = useLiveTicks([
    tickKey('angel', callAngelToken), tickKey('upstox', callUpToken),
    tickKey('angel', putAngelToken), tickKey('upstox', putUpToken),
  ])
  const callLtp = liveLtpFromTicks(callAngel, callUp, wsBroker, restCallLtp)
  const putLtp = liveLtpFromTicks(putAngel, putUp, wsBroker, restPutLtp)
  const callLive = callAngel?.ltp != null || callUp?.ltp != null
  const putLive = putAngel?.ltp != null || putUp?.ltp != null

  return (
    <tr className={`oc-row${isAtm ? ' oc-atm' : ''}`}>
      <td className={`oc-ltp${callLive ? ' oc-live' : ''}`}>{px(callLtp)}</td>
      <td className="oc-strike-cell">{num(strike)}</td>
      <td className={`oc-ltp oc-mini-put-ltp${putLive ? ' oc-live' : ''}`}>{px(putLtp)}</td>
    </tr>
  )
})

export default function MiniChainWindow() {
  const initial = useMemo(loadPrefs, [])
  const [symbol, setSymbol] = useState(initial.symbol)
  const [expiry, setExpiry] = useState(initial.expiry)
  const [expiries, setExpiries] = useState([])
  const [window_, setWindow] = useState(initial.window)
  const [wsBroker] = useState('angel')
  const bodyRef = useRef(null)

  const { chain, upTokens, wsState, loading, error } = useMiniChainFeed(symbol, expiry, wsBroker)

  // Expiries for the chosen underlying; keep the saved one if it's still valid.
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

  useEffect(() => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ symbol, expiry, window: window_ })) } catch { /* ignore */ }
  }, [symbol, expiry, window_])

  // Title carries the symbol so the taskbar entry is identifiable when several
  // widgets are open.
  useEffect(() => { document.title = `${symbol} · Mini Chain` }, [symbol])

  const { lastTickAt } = useLiveMeta()
  const streaming = wsState === 'open' && lastTickAt && (Date.now() - lastTickAt) / 1000 <= 3

  const strikes = chain?.strikes || []
  const atm = chain?.atm
  const [spotTick] = useLiveTicks([tickKey('angel', chain?.spotToken)])
  const spot = spotTick?.ltp != null ? spotTick.ltp : chain?.spot

  const rowIndexes = useMemo(() => {
    const all = strikes.map((_, i) => i)
    if (!window_ || !strikes.length) return all
    const atmIdx = strikes.findIndex((s) => s === atm)
    if (atmIdx < 0) return all
    return all.slice(Math.max(0, atmIdx - window_), atmIdx + window_ + 1)
  }, [strikes, atm, window_])

  useEffect(() => {
    const body = bodyRef.current
    const atmRow = body?.querySelector('.oc-atm')
    if (!body || !atmRow) return
    body.scrollTop = atmRow.offsetTop - (body.clientHeight / 2) + (atmRow.offsetHeight / 2)
  }, [rowIndexes])

  return (
    <div className="oc-mini-window">
      <div className="oc-mini-win-head">
        <select className="oc-mini-select" value={symbol} onChange={(e) => { setSymbol(e.target.value); setExpiry('') }}>
          <optgroup label="Index">
            {INDEX_UNDERLYINGS.map((u) => <option key={u} value={u}>{u}</option>)}
          </optgroup>
          <optgroup label="MCX">
            {MCX_UNDERLYINGS.map((u) => <option key={u} value={u}>{u}</option>)}
          </optgroup>
        </select>
        <select className="oc-mini-select" value={expiry} onChange={(e) => setExpiry(e.target.value)} disabled={!expiries.length}>
          {expiries.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <span className={`oc-mini-dot${streaming ? ' live' : ''}`} title={streaming ? 'Streaming live' : `Socket ${wsState}`} />
        <span className="oc-mini-spot">{px(spot)}</span>
      </div>

      <div className="oc-mini-tools">
        {WINDOWS.map((n) => (
          <button key={n} type="button" className={`oc-mini-win${window_ === n ? ' active' : ''}`} onClick={() => setWindow(n)}>
            {windowLabel(n)}
          </button>
        ))}
      </div>

      <table className="oc-mini-table">
        <thead>
          <tr className="oc-mini-band">
            <th className="oc-mini-call">CALL</th>
            <th className="oc-mini-strike-band">STRIKE</th>
            <th className="oc-mini-put">PUT</th>
          </tr>
          <tr className="oc-mini-cols"><th>LTP</th><th>Strike</th><th>LTP</th></tr>
        </thead>
      </table>

      <div className="oc-mini-body oc-mini-body-fill" ref={bodyRef}>
        <table className="oc-mini-table">
          <tbody>
            {rowIndexes.map((i) => (
              <MiniRow
                key={strikes[i]}
                strike={strikes[i]}
                isAtm={strikes[i] === atm}
                restCallLtp={chain?.callLtp?.[i]}
                restPutLtp={chain?.putLtp?.[i]}
                callAngelToken={chain?.callTokens?.[i]}
                callUpToken={upTokens.callTokens?.[i]}
                putAngelToken={chain?.putTokens?.[i]}
                putUpToken={upTokens.putTokens?.[i]}
                wsBroker={wsBroker}
              />
            ))}
            {!rowIndexes.length && (
              <tr>
                <td colSpan={3} className="oc-mini-empty">
                  {loading ? <><RefreshCw size={13} className="oc-mini-spin" /> Loading…</> : error || 'No chain'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {error && !!rowIndexes.length && <div className="oc-mini-err">{error}</div>}
    </div>
  )
}
