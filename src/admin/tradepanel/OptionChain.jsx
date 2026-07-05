import { useEffect, useState } from 'react'
import { Box, Button, Chip, FormControl, InputLabel, MenuItem, Select, Typography } from '@mui/material'
import { RefreshCw, Radio } from 'lucide-react'
import './optionchain.css'

// Option Chain — reads entirely from the shared FEED. No account picker: whatever
// Angel + Upstox accounts are logged in via Feed Master power this chain (Angel
// LTP/OI, Upstox Bid/Ask). Pick an underlying + expiry and load.
export default function OptionChain() {
  const [symbol, setSymbol] = useState('NIFTY')
  const [expiry, setExpiry] = useState('')
  const [expiries, setExpiries] = useState([])
  const [chain, setChain] = useState(null)
  const [feed, setFeed] = useState({})       // which broker accounts are live
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX']

  // Poll the feed status so the user sees which accounts are powering the chain.
  useEffect(() => {
    let alive = true
    const load = () => fetch('/api/feed/status').then((r) => r.json()).then((j) => { if (alive) setFeed(j.feed || {}) }).catch(() => {})
    load()
    const t = setInterval(load, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  // Load expiries for the selected underlying (from the feed's Angel master).
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
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/feed/option-chain', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: sym, expiry: exp }),
      })
      const body = await res.json()
      if (!res.ok || body.status === false) throw new Error(body.message || 'Chain load failed')
      setChain(body)
    } catch (e) { setError(e.message); setChain(null) }
    finally { setLoading(false) }
  }

  const atm = chain?.atm
  const up = chain?.upstox?.aligned
  const num = (v) => (v == null ? '—' : Number(v).toLocaleString('en-IN'))
  const px = (v) => (v == null ? '—' : Number(v).toFixed(2))

  const angelLive = !!feed.angel
  const upstoxLive = !!feed.upstox

  return (
    <Box className="oc-panel">
      <Box className="oc-controls">
        <FormControl size="small" sx={{ minWidth: 130 }}>
          <InputLabel>Underlying</InputLabel>
          <Select label="Underlying" value={symbol} onChange={(e) => { setSymbol(e.target.value); setExpiry('') }}>
            {UNDERLYINGS.map((u) => <MenuItem key={u} value={u}>{u}</MenuItem>)}
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

        {/* Feed status — which accounts power this chain (from Feed Master). */}
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', ml: 'auto' }}>
          <Radio size={14} color={angelLive ? 'var(--ao-green)' : 'var(--ao-placeholder)'} />
          <Chip size="small" color={angelLive ? 'success' : 'default'} variant={angelLive ? 'filled' : 'outlined'}
            label={angelLive ? `Angel ${feed.angel.account}` : 'Angel not in feed'} />
          <Chip size="small" color={upstoxLive ? 'success' : 'default'} variant={upstoxLive ? 'filled' : 'outlined'}
            label={upstoxLive ? `Upstox ${feed.upstox.account}` : 'Upstox not in feed'} />
          {chain && <Chip size="small" label={`Spot ${px(chain.spot)}`} variant="outlined" />}
          {chain && <Chip size="small" label={`ATM ${num(atm)}`} />}
        </Box>
      </Box>

      {!angelLive && (
        <Typography sx={{ mb: 1, fontSize: '0.85rem', color: 'var(--ao-gold)' }}>
          No Angel account in the feed — log one in from <b>Feed Master</b> to load the chain. Add Upstox there too for Bid/Ask.
        </Typography>
      )}
      {error && <Typography color="error" sx={{ mb: 1, fontSize: '0.85rem' }}>{error}</Typography>}

      <div className="oc-table-wrap">
        <table className="oc-table">
          <thead>
            <tr className="oc-side-head">
              <th className="oc-call" colSpan={4}>CALL</th>
              <th className="oc-strike">STRIKE</th>
              <th className="oc-put" colSpan={4}>PUT</th>
            </tr>
            <tr>
              <th>OI</th><th>Bid / Ask</th><th className="oc-ltp">LTP</th><th>IV</th>
              <th>Strike</th>
              <th>IV</th><th className="oc-ltp">LTP</th><th>Bid / Ask</th><th>OI</th>
            </tr>
          </thead>
          <tbody>
            {!chain && <tr><td className="oc-empty" colSpan={9}>Select an underlying and load the chain</td></tr>}
            {(chain?.strikes || []).map((strike, i) => {
              const isAtm = strike === atm
              const cItm = atm && strike < atm, pItm = atm && strike > atm
              const cg = up?.callGreeks?.[i], pg = up?.putGreeks?.[i]
              return (
                <tr key={strike} className={`oc-row${isAtm ? ' oc-atm' : ''}`}>
                  <td className={cItm ? 'oc-itm' : ''}>{num(chain.callOI?.[i])}</td>
                  <td className="oc-bidask">
                    <span className="oc-bid">{px(up?.callBid?.[i])}</span>
                    <span className="oc-sep">/</span>
                    <span className="oc-ask">{px(up?.callAsk?.[i])}</span>
                  </td>
                  <td className={`oc-ltp${cItm ? ' oc-itm' : ''}`}>{px(chain.callLtp?.[i])}</td>
                  <td className="oc-iv">{cg?.iv != null ? Number(cg.iv).toFixed(1) : '—'}</td>
                  <td className="oc-strike-cell">{num(strike)}</td>
                  <td className="oc-iv">{pg?.iv != null ? Number(pg.iv).toFixed(1) : '—'}</td>
                  <td className={`oc-ltp${pItm ? ' oc-itm' : ''}`}>{px(chain.putLtp?.[i])}</td>
                  <td className="oc-bidask">
                    <span className="oc-bid">{px(up?.putBid?.[i])}</span>
                    <span className="oc-sep">/</span>
                    <span className="oc-ask">{px(up?.putAsk?.[i])}</span>
                  </td>
                  <td className={pItm ? 'oc-itm' : ''}>{num(chain.putOI?.[i])}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Box>
  )
}
