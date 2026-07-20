import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, GripHorizontal, X } from 'lucide-react'
import { liveLtpFromTicks, num, px, tickKey, useLiveTicks } from './chainLive'
import './optionchain.css'

// How many strikes each side of the ATM the widget shows. "All" keeps the whole
// ladder (the widget scrolls); the tighter windows are what makes it "mini".
const WINDOWS = [5, 10, 20, 0]
const windowLabel = (n) => (n ? `±${n}` : 'All')

// One mini row: CALL LTP | STRIKE | PUT LTP. Memoized like the full chain's rows
// so a tick only repaints the strike it belongs to.
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

// Mini Option Chain — a floating, draggable widget showing ONLY the two premiums
// and the strike, in the same Kite formatting as the full chain (green CALL /
// red PUT bands, blue ATM row, green live LTP).
//
// It renders off the chain + tick data the parent already holds, so opening it
// creates no extra REST calls and no extra WebSocket subscriptions.
export default function MiniOptionChain({
  symbol, expiry, spot, atm, strikes = [], callLtp = [], putLtp = [],
  callTokens = [], putTokens = [], upCallTokens = [], upPutTokens = [], wsBroker, onClose,
}) {
  const [window_, setWindow] = useState(10)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const dragRef = useRef(null)     // { pointerId, startX, startY, originX, originY }
  const panelRef = useRef(null)
  const bodyRef = useRef(null)

  // Open near the top-right, clamped into the viewport.
  useEffect(() => {
    const w = panelRef.current?.offsetWidth || 320
    setPos({ x: Math.max(12, window.innerWidth - w - 28), y: 96 })
  }, [])

  // Drag by the header. Pointer capture keeps the gesture even if the cursor
  // outruns the panel, and we clamp so it can never be dropped off-screen.
  const onPointerDown = useCallback((e) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, originX: pos.x, originY: pos.y }
  }, [pos])

  const onPointerMove = useCallback((e) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const panel = panelRef.current
    const maxX = window.innerWidth - (panel?.offsetWidth || 320) - 8
    const maxY = window.innerHeight - 44
    setPos({
      x: Math.min(Math.max(8, drag.originX + (e.clientX - drag.startX)), Math.max(8, maxX)),
      y: Math.min(Math.max(8, drag.originY + (e.clientY - drag.startY)), Math.max(8, maxY)),
    })
  }, [])

  const endDrag = useCallback((e) => {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null
  }, [])

  // The strike indices in view: a window around the ATM, or the whole ladder.
  const rowIndexes = useMemo(() => {
    const all = strikes.map((_, i) => i)
    if (!window_ || !strikes.length) return all
    const atmIdx = strikes.findIndex((s) => s === atm)
    if (atmIdx < 0) return all
    return all.slice(Math.max(0, atmIdx - window_), atmIdx + window_ + 1)
  }, [strikes, atm, window_])

  // Keep the ATM row centred whenever the window or the ladder changes.
  useEffect(() => {
    const body = bodyRef.current
    const atmRow = body?.querySelector('.oc-atm')
    if (!body || !atmRow) return
    body.scrollTop = atmRow.offsetTop - (body.clientHeight / 2) + (atmRow.offsetHeight / 2)
  }, [rowIndexes])

  // Esc closes, matching every other dismissible overlay.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="oc-mini" ref={panelRef} style={{ left: pos.x, top: pos.y }} role="dialog" aria-label="Mini option chain">
      <div
        className="oc-mini-head"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <GripHorizontal size={13} className="oc-mini-grip" />
        <span className="oc-mini-title">{symbol}</span>
        <span className="oc-mini-sub">{expiry}</span>
        <span className="oc-mini-spot">{px(spot)}</span>
        {/* Pops the standalone window. If the PWA is installed, Chrome routes
            /#/mini into the installed app window instead of a browser popup. */}
        <button
          type="button"
          className="oc-mini-close"
          onClick={() => window.open('/#/mini', 'alphahedge-mini-chain', 'width=320,height=560,menubar=no,toolbar=no,location=no,status=no')}
          title="Open as a separate desktop window"
          aria-label="Open as a separate desktop window"
        >
          <ExternalLink size={12} />
        </button>
        <button type="button" className="oc-mini-close" onClick={onClose} title="Close mini chain" aria-label="Close mini chain">
          <X size={13} />
        </button>
      </div>

      <div className="oc-mini-tools">
        {WINDOWS.map((n) => (
          <button
            key={n}
            type="button"
            className={`oc-mini-win${window_ === n ? ' active' : ''}`}
            onClick={() => setWindow(n)}
          >
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
          <tr className="oc-mini-cols">
            <th>LTP</th><th>Strike</th><th>LTP</th>
          </tr>
        </thead>
      </table>

      <div className="oc-mini-body" ref={bodyRef}>
        <table className="oc-mini-table">
          <tbody>
            {rowIndexes.map((i) => (
              <MiniRow
                key={strikes[i]}
                strike={strikes[i]}
                isAtm={strikes[i] === atm}
                restCallLtp={callLtp[i]}
                restPutLtp={putLtp[i]}
                callAngelToken={callTokens[i]}
                callUpToken={upCallTokens[i]}
                putAngelToken={putTokens[i]}
                putUpToken={upPutTokens[i]}
                wsBroker={wsBroker}
              />
            ))}
            {!rowIndexes.length && (
              <tr><td colSpan={3} className="oc-mini-empty">Load a chain first</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
