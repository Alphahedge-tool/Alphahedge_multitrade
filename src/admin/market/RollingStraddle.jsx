import { useEffect, useMemo, useState } from 'react'
import {
  Alert, Box, Button, Chip, CircularProgress, FormControl, InputLabel,
  MenuItem, Select, Stack, Typography,
} from '@mui/material'
import { RefreshCw } from 'lucide-react'
import UplotChart from '../charting/UplotChart'

// Rolling Straddle — Nubra source, ported from Alphahedgetool. Plots the
// cheapest ATM+-2 straddle's Bid, Ask, Avg and IV across the session. Requires a
// Nubra account logged into Feed Master (the backend uses that session).
const SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX']
const EXCHANGES = ['NSE', 'BSE', 'MCX']

const formatPrice = (value) => Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const formatIv = (value) => `${Number(value || 0).toFixed(1)}%`

function previousTradingDate(date) {
  const cursor = new Date(`${date}T00:00:00Z`)
  do { cursor.setUTCDate(cursor.getUTCDate() - 1) } while ([0, 6].includes(cursor.getUTCDay()))
  return cursor.toISOString().slice(0, 10)
}

// Full session window 09:15 -> 15:30 IST as UTC epoch ms.
function sessionRange() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  })
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).map((part) => [part.type, part.value]))
  let date = `${parts.year}-${parts.month}-${parts.day}`
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') date = previousTradingDate(date)
  const [year, month, day] = date.split('-').map(Number)
  // 09:15 IST = 03:45 UTC, 15:30 IST = 10:00 UTC.
  return { date, start: Date.UTC(year, month - 1, day, 3, 45, 0, 0), end: Date.UTC(year, month - 1, day, 10, 0, 0, 0) }
}

export default function RollingStraddle() {
  const [symbol, setSymbol] = useState('NIFTY')
  const [exchange, setExchange] = useState('NSE')
  const [expiries, setExpiries] = useState([])
  const [expiry, setExpiry] = useState('')
  const [points, setPoints] = useState([])
  const [meta, setMeta] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setExpiry('')
    setExpiries([])
    setPoints([])
    setMeta(null)
    const { date } = sessionRange()
    const params = new URLSearchParams({ symbol, exchange, date })
    fetch(`/api/feed/rolling-straddle/expiries?${params}`)
      .then((response) => response.json().then((body) => ({ response, body })))
      .then(({ response, body }) => {
        if (cancelled) return
        if (!response.ok || body.status === false) throw new Error(body.message || 'Failed to load expiries')
        const list = Array.isArray(body.expiries) ? body.expiries : []
        setExpiries(list)
        setExpiry(String(list[0] || ''))
      })
      .catch((reason) => { if (!cancelled) setError(reason.message) })
    return () => { cancelled = true }
  }, [symbol, exchange])

  const loadHistory = async () => {
    if (!symbol || !expiry) return
    setLoading(true)
    setError('')
    try {
      const session = sessionRange()
      const response = await fetch('/api/feed/rolling-straddle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, exchange, expiry, start: session.start, end: session.end }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.status === false) throw new Error(body.message || `HTTP ${response.status}`)
      setPoints(body.points || [])
      setMeta({ ...body, tradingDate: session.date })
    } catch (reason) {
      setError(reason.message || 'Failed to load rolling straddle')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!expiry) return
    loadHistory()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, exchange, expiry])

  const last = points[points.length - 1]

  // Bid, Ask, Avg (mid) of the rolling straddle, with a faint spot overlay on its
  // own scale. Matches Alphahedgetool's Bid/Ask/Avg series.
  // uPlot columnar data: [xSeconds, bid[], ask[], avg[], iv[]]. Nulls where a
  // field is missing so the line simply gaps (uPlot expects aligned columns).
  const chartData = useMemo(() => [
    points.map((p) => Math.floor(p.time / 1000)),
    points.map((p) => (Number.isFinite(p.bid) ? p.bid : null)),
    points.map((p) => (Number.isFinite(p.ask) ? p.ask : null)),
    points.map((p) => (Number.isFinite(p.mid) ? p.mid : null)),
    points.map((p) => (p.iv != null ? p.iv : null)),
  ], [points])

  // Bid / Ask / Avg on the price scale, IV on its own scale — exactly like
  // Alphahedgetool's rolling-straddle chart.
  const chartSeries = useMemo(() => [
    { label: 'Bid', scale: 'price', stroke: '#10B981', width: 1.6, axisSide: 'right', tipFmt: (v) => `₹${formatPrice(v)}`, lastFmt: (v) => v.toFixed(2) },
    { label: 'Ask', scale: 'price', stroke: '#EF4444', width: 1.6, axisSide: 'right', tipFmt: (v) => `₹${formatPrice(v)}`, lastFmt: (v) => v.toFixed(2) },
    { label: 'Avg', scale: 'price', stroke: '#8B5CF6', width: 1.4, dash: [4, 4], axisSide: 'right', tipFmt: (v) => `₹${formatPrice(v)}`, lastFmt: (v) => v.toFixed(2) },
    { label: 'IV', scale: 'iv', stroke: '#3B82F6', width: 1.2, axisSide: 'left', tipFmt: (v) => `${v.toFixed(2)}%`, lastFmt: (v) => `${v.toFixed(1)}%` },
  ], [])

  const chartAxes = useMemo(() => [
    { scale: 'iv', side: 3, color: '#3B82F6', size: 58, grid: false, format: (v) => `${Number(v).toFixed(1)}%` },
    { scale: 'price', side: 1, color: '#787b86', size: 74, grid: true, format: (v) => Number(v).toFixed(2) },
  ], [])

  return (
    <Box className="page-shell" sx={{ gap: 0.75 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap', alignItems: 'center', minHeight: 38 }}>
        <Box>
          <Typography sx={{ fontSize: '1rem', fontWeight: 700 }}>Rolling Straddle</Typography>
          <Typography color="text.secondary" fontSize="0.82rem">
            Lowest ATM ±2 straddle · Bid / Ask / Avg / IV · Nubra feed · 09:15–15:30 IST
          </Typography>
        </Box>
        <Stack direction="row" spacing={0.75} alignItems="center">
          <FormControl size="small" sx={{ minWidth: 100, '& .MuiInputBase-root': { height: 34 } }}>
            <InputLabel>Exchange</InputLabel>
            <Select label="Exchange" value={exchange} onChange={(event) => setExchange(event.target.value)}>
              {EXCHANGES.map((item) => <MenuItem key={item} value={item}>{item}</MenuItem>)}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 120, '& .MuiInputBase-root': { height: 34 } }}>
            <InputLabel>Symbol</InputLabel>
            <Select label="Symbol" value={symbol} onChange={(event) => setSymbol(event.target.value)}>
              {SYMBOLS.map((item) => <MenuItem key={item} value={item}>{item}</MenuItem>)}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 140, '& .MuiInputBase-root': { height: 34 } }} disabled={!expiries.length}>
            <InputLabel>Expiry</InputLabel>
            <Select label="Expiry" value={expiry} onChange={(event) => setExpiry(event.target.value)}>
              {expiries.map((item) => <MenuItem key={item} value={String(item)}>{String(item)}</MenuItem>)}
            </Select>
          </FormControl>
          <Button
            size="small" variant="outlined" sx={{ height: 34, minWidth: 82 }}
            disabled={loading || !expiry}
            startIcon={loading ? <CircularProgress size={13} /> : <RefreshCw size={13} />}
            onClick={loadHistory}
          >
            Reload
          </Button>
        </Stack>
      </Box>

      {error && <Alert severity="error">{error}</Alert>}

      {(meta || last) && (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {last?.strike != null && <Chip size="small" color="primary" label={`Strike ${last.strike}`} />}
          {last?.bid != null && <Chip size="small" sx={{ color: '#10b981' }} label={`Bid ${formatPrice(last.bid)}`} />}
          {last?.ask != null && <Chip size="small" sx={{ color: '#ef4444' }} label={`Ask ${formatPrice(last.ask)}`} />}
          {last?.iv != null && <Chip size="small" sx={{ color: '#3b82f6' }} label={`IV ${formatIv(last.iv)}`} />}
          {(last?.spot ?? meta?.spot) != null && <Chip size="small" label={`Spot ${formatPrice(last?.spot ?? meta?.spot)}`} />}
          {meta?.interval && <Chip size="small" label={`${meta.interval} · ${meta.strikesChecked ?? 0} strikes`} />}
        </Stack>
      )}

      <UplotChart title="Rolling Straddle — Bid / Ask / Avg / IV" data={chartData} series={chartSeries} axes={chartAxes} height={760} />
    </Box>
  )
}
