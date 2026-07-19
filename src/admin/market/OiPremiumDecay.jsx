import { useEffect, useMemo, useState } from 'react'
import {
  Alert, Box, Button, Checkbox, Chip, CircularProgress, FormControl, InputLabel,
  ListItemText, MenuItem, Paper, Select, Stack, Typography,
} from '@mui/material'
import { RefreshCw } from 'lucide-react'
import UplotChart from '../charting/UplotChart'
import { useEngineTopic } from './useEngineTopic'

const SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX']

const formatNumber = (value) => {
  const n = Number(value) || 0
  if (Math.abs(n) >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`
  if (Math.abs(n) >= 1e5) return `${(n / 1e5).toFixed(2)} L`
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)} K`
  return n.toFixed(2)
}

function previousTradingDate(date) {
  const cursor = new Date(`${date}T00:00:00Z`)
  do { cursor.setUTCDate(cursor.getUTCDate() - 1) } while ([0, 6].includes(cursor.getUTCDay()))
  return cursor.toISOString().slice(0, 10)
}

function sessionRange() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  })
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).map((part) => [part.type, part.value]))
  let date = `${parts.year}-${parts.month}-${parts.day}`
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') date = previousTradingDate(date)
  const [year, month, day] = date.split('-').map(Number)
  // IST is UTC+05:30: 09:15 IST = 03:45 UTC, 15:29 IST = 09:59 UTC.
  return {
    date,
    start: Date.UTC(year, month - 1, day, 3, 45, 0, 0),
    end: Date.UTC(year, month - 1, day, 9, 59, 59, 999),
  }
}

function isMarketOpen() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).map((part) => [part.type, part.value]))
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false
  const minutes = Number(parts.hour) * 60 + Number(parts.minute)
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 29
}

export default function OiPremiumDecay() {
  const [symbol, setSymbol] = useState('NIFTY')
  const [expiries, setExpiries] = useState([])
  const [expiry, setExpiry] = useState('')
  const [strikes, setStrikes] = useState([])
  const [selectedStrikes, setSelectedStrikes] = useState([])
  const [points, setPoints] = useState([])
  const [meta, setMeta] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setExpiry('')
    setExpiries([])
    setStrikes([])
    setSelectedStrikes([])
    fetch(`/api/feed/expiries?symbol=${encodeURIComponent(symbol)}`)
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
  }, [symbol])

  const loadHistory = async (strikeSelection = selectedStrikes) => {
    if (!symbol || !expiry || !strikeSelection.length) return
    setLoading(true)
    setError('')
    try {
      const session = sessionRange()
      const response = await fetch('/api/feed/oi-premium-decay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, expiry, strikes: strikeSelection, interval: 'S1', start: session.start, end: session.end, limit: 500 }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.status === false) throw new Error(body.message || `HTTP ${response.status}`)
      setPoints(body.points || [])
      setMeta({ ...body, tradingDate: session.date })
    } catch (reason) {
      setError(reason.message || 'Failed to load one-second history')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!expiry) return undefined
    let cancelled = false
    setStrikes([])
    setSelectedStrikes([])
    setPoints([])
    setMeta(null)
    setLoading(true)
    setError('')
    fetch('/api/feed/oi-premium-decay', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, expiry, chainOnly: true }),
    })
      .then((response) => response.json().then((body) => ({ response, body })))
      .then(async ({ response, body }) => {
        if (cancelled) return
        if (!response.ok || body.status === false) throw new Error(body.message || 'Failed to load strikes')
        const available = Array.isArray(body.strikes) ? body.strikes.map(Number).filter(Number.isFinite) : []
        setStrikes(available)
        if (!available.length) throw new Error('No strikes returned for this expiry')
        const spot = Number(body.spot)
        const atm = available.reduce((best, strike) => Math.abs(strike - spot) < Math.abs(best - spot) ? strike : best, available[0])
        setSelectedStrikes([atm])
        await loadHistory([atm])
      })
      .catch((reason) => { if (!cancelled) setError(reason.message || 'Failed to load strikes') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [symbol, expiry])

  // Live updates are pushed by the server-side engine over /ws/feed. The engine
  // keeps these contracts subscribed on one upstream Upstox WebSocket and folds
  // them once per second for every viewer, so this costs no per-tab request.
  // (This replaced a 1Hz poll that re-fetched the whole option chain each tick.)
  const liveActive = Boolean(points.length) && isMarketOpen()
  const { point: livePoint, history: liveHistory, status: liveStatus } = useEngineTopic({
    symbol,
    expiry,
    strikes: selectedStrikes,
    enabled: liveActive,
  })

  useEffect(() => {
    if (!livePoint) return
    setPoints((current) => [...current, livePoint].slice(-900))
    setMeta((current) => ({ ...current, spot: livePoint.spot, contracts: livePoint.contracts ?? current?.contracts }))
  }, [livePoint])

  // On (re)subscribe the engine sends whatever the topic already accumulated,
  // so a dropped socket backfills instead of leaving a permanent hole in the
  // chart. Deduped by timestamp, and a no-op on a freshly created topic.
  useEffect(() => {
    if (!liveHistory?.time?.length) return
    setPoints((current) => {
      const seen = new Set(current.map((p) => p.time))
      const merged = current.slice()
      for (let i = 0; i < liveHistory.time.length; i++) {
        const time = liveHistory.time[i]
        if (time == null || seen.has(time)) continue
        merged.push({
          time,
          callOi: liveHistory.callOi[i],
          putOi: liveHistory.putOi[i],
          callPremium: liveHistory.callPremium[i],
          putPremium: liveHistory.putPremium[i],
          spot: liveHistory.spot[i],
        })
      }
      return merged.sort((a, b) => a.time - b.time).slice(-900)
    })
  }, [liveHistory])

  const last = points[points.length - 1]
  const summary = useMemo(() => last ? [
    ['Call OI', last.callOi, '#ef4444'], ['Put OI', last.putOi, '#22c55e'],
    ['Call premium', last.callPremium, '#f97316'], ['Put premium', last.putPremium, '#3b82f6'],
  ] : [], [last])
  const xSeconds = useMemo(() => points.map((p) => Math.floor(p.time / 1000)), [points])
  const spotColumn = useMemo(() => points.map((p) => (p.spot != null ? p.spot : null)), [points])

  // uPlot columnar data + specs for the OI chart (Call/Put OI on 'oi', spot on
  // its own 'spot' scale) and the premium chart, matching the old two-chart
  // layout with a faint spot overlay.
  const oiData = useMemo(() => [
    xSeconds,
    points.map((p) => (Number.isFinite(p.callOi) ? p.callOi : null)),
    points.map((p) => (Number.isFinite(p.putOi) ? p.putOi : null)),
    spotColumn,
  ], [points, xSeconds, spotColumn])
  const premiumData = useMemo(() => [
    xSeconds,
    points.map((p) => (Number.isFinite(p.callPremium) ? p.callPremium : null)),
    points.map((p) => (Number.isFinite(p.putPremium) ? p.putPremium : null)),
    spotColumn,
  ], [points, xSeconds, spotColumn])

  const oiSeries = useMemo(() => [
    { label: 'Call OI', scale: 'oi', stroke: '#ef4444', width: 1.6, axisSide: 'right', tipFmt: formatNumber, lastFmt: formatNumber },
    { label: 'Put OI', scale: 'oi', stroke: '#22c55e', width: 1.6, axisSide: 'right', tipFmt: formatNumber, lastFmt: formatNumber },
    { label: 'Spot', scale: 'spot', stroke: '#94a3b8', width: 1.1, axisSide: 'left', tipFmt: (v) => v.toFixed(2), lastFmt: (v) => v.toFixed(0) },
  ], [])
  const premiumSeries = useMemo(() => [
    { label: 'Call premium', scale: 'prem', stroke: '#f97316', width: 1.6, axisSide: 'right', tipFmt: formatNumber, lastFmt: formatNumber },
    { label: 'Put premium', scale: 'prem', stroke: '#3b82f6', width: 1.6, axisSide: 'right', tipFmt: formatNumber, lastFmt: formatNumber },
    { label: 'Spot', scale: 'spot', stroke: '#94a3b8', width: 1.1, axisSide: 'left', tipFmt: (v) => v.toFixed(2), lastFmt: (v) => v.toFixed(0) },
  ], [])
  const oiAxes = useMemo(() => [
    { scale: 'spot', side: 3, color: '#94a3b8', size: 58, grid: false, format: (v) => Number(v).toFixed(0) },
    { scale: 'oi', side: 1, color: 'var(--ao-caption)', size: 74, grid: true, format: formatNumber },
  ], [])
  const premiumAxes = useMemo(() => [
    { scale: 'spot', side: 3, color: '#94a3b8', size: 58, grid: false, format: (v) => Number(v).toFixed(0) },
    { scale: 'prem', side: 1, color: 'var(--ao-caption)', size: 74, grid: true, format: formatNumber },
  ], [])

  return (
    <Box className="page-shell" sx={{ gap: 0.75 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap', alignItems: 'center', minHeight: 38 }}>
        <Box sx={{ '& > .MuiTypography-root + .MuiTypography-root': { display: 'none' } }}>
          <Typography sx={{ fontSize: '1rem', fontWeight: 700 }}>OI / Premium Decay</Typography>
          <Typography color="text.secondary" fontSize="0.82rem">All Upstox CE/PE contracts · S1 historical candles · one-second live updates</Typography>
        </Box>
        <Stack direction="row" spacing={0.75} alignItems="center">
          <FormControl size="small" sx={{ minWidth: 120, '& .MuiInputBase-root': { height: 34 } }}><InputLabel>Symbol</InputLabel><Select label="Symbol" value={symbol} onChange={(event) => setSymbol(event.target.value)}>{SYMBOLS.map((item) => <MenuItem key={item} value={item}>{item}</MenuItem>)}</Select></FormControl>
          <FormControl size="small" sx={{ minWidth: 140, '& .MuiInputBase-root': { height: 34 } }} disabled={!expiries.length}><InputLabel>Expiry</InputLabel><Select label="Expiry" value={expiry} onChange={(event) => setExpiry(event.target.value)}>{expiries.map((item) => <MenuItem key={item} value={String(item)}>{String(item)}</MenuItem>)}</Select></FormControl>
          <FormControl size="small" sx={{ width: 122, '& .MuiInputBase-root': { height: 34 }, '& .MuiSelect-select': { fontSize: '0.82rem', py: 0.5 } }} disabled={!strikes.length || loading}>
            <InputLabel>Strikes</InputLabel>
            <Select
              multiple
              label="Strikes"
              value={selectedStrikes}
              MenuProps={{
                slotProps: {
                  paper: { sx: { width: 170, height: '220px !important', maxHeight: '220px !important', mt: 0.5, overflowY: 'auto !important' } },
                  list: { dense: true, sx: { py: 0.35 } },
                },
                sx: {
                  '& .MuiPaper-root': { width: 170, height: '220px !important', maxHeight: '220px !important', overflowY: 'auto !important' },
                  '& .MuiMenu-list': { py: 0.35 },
                },
              }}
              renderValue={(values) => values.length === 1 ? String(values[0]) : `${values.length} strikes`}
              onChange={(event) => {
                const next = (typeof event.target.value === 'string' ? event.target.value.split(',') : event.target.value).map(Number)
                if (!next.length) return
                setSelectedStrikes(next)
                loadHistory(next)
              }}
            >
              {strikes.map((strike) => <MenuItem key={strike} value={strike} sx={{ minHeight: '34px !important', py: 0, px: 0.9, fontSize: '0.95rem' }}><Checkbox size="small" checked={selectedStrikes.includes(strike)} sx={{ p: 0.4, mr: 0.65, '& .MuiSvgIcon-root': { fontSize: 19 } }} /><ListItemText primary={strike} slotProps={{ primary: { sx: { fontSize: '0.95rem', fontWeight: 600, lineHeight: 1.25 } } }} /></MenuItem>)}
            </Select>
          </FormControl>
          {liveActive && <Chip
            size="small"
            variant="outlined"
            color={liveStatus === 'live' ? 'success' : liveStatus === 'error' ? 'error' : 'default'}
            label={liveStatus === 'live' ? 'Live' : liveStatus === 'connecting' ? 'Connecting' : liveStatus === 'error' ? 'Live failed' : 'Reconnecting'}
            sx={{ height: 26 }}
          />}
          <Button size="small" variant="outlined" sx={{ height: 34, minWidth: 82 }} disabled={loading || !expiry || !selectedStrikes.length} startIcon={loading ? <CircularProgress size={13} /> : <RefreshCw size={13} />} onClick={() => loadHistory()}>Reload</Button>
        </Stack>
      </Box>

      {error && <Alert severity="error">{error}</Alert>}
      {meta && <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ display: 'none' }}>
        <Chip size="small" label={`${meta.contracts || 0} CE/PE contracts`} />
        <Chip size="small" label={`${meta.pagesPerContract || 0} pages × ${meta.concurrency || 0} parallel`} />
        {meta.tradingDate && <Chip size="small" label={`${meta.tradingDate} · 09:15–15:29 IST`} />}
        <Chip size="small" color="success" label="S1 · Live" />
        {meta.failedContracts > 0 && <Chip size="small" color="warning" label={`${meta.failedContracts} history requests failed`} />}
        {meta.spot != null && <Chip size="small" color="primary" label={`Spot ${Number(meta.spot).toFixed(2)}`} />}
      </Stack>}

      <Box sx={{ display: 'none', gridTemplateColumns: { xs: '1fr', lg: 'repeat(4, 1fr)' }, gap: 1 }}>
        {summary.map(([label, value, color]) => <Paper key={label} sx={{ p: 1.5, borderTop: `3px solid ${color}` }}><Typography color="text.secondary" fontSize="0.72rem">{label}</Typography><Typography fontWeight={700}>{formatNumber(value)}</Typography></Paper>)}
      </Box>

      <UplotChart title="Total Open Interest" data={oiData} series={oiSeries} axes={oiAxes} height={340} />
      <UplotChart title="Total Option Premium" data={premiumData} series={premiumSeries} axes={premiumAxes} height={340} />
    </Box>
  )
}
