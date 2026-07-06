import { useEffect, useState } from 'react'
import {
  Alert, Box, Button, Checkbox, Chip, CircularProgress, Divider, FormControl, FormControlLabel,
  InputLabel, MenuItem, Paper, Select, Typography,
} from '@mui/material'
import { CheckCircle2, PlugZap, Radio, XCircle } from 'lucide-react'
import { apiGet } from '../config/api'
import { FEED_BROKERS, loginClient, saveFeedMaster, getSavedFeedMaster, getFeedState, saveFeedState } from '../feedmaster/feedMasterStore'

const brokerLabel = (name) => FEED_BROKERS.find((b) => b.id === String(name).toLowerCase())?.label
  || { angel: 'Angel One', upstox: 'Upstox', kotak: 'Kotak Neo', nubra: 'Nubra', angelone: 'Angel One', kotakneov3: 'Kotak Neo' }[String(name).toLowerCase()]
  || name

// Feed Master — a GLOBAL feed that can hold live broker accounts from MULTIPLE
// users at once. The user dropdown only changes which user's accounts you're
// browsing; logging some in and switching users never clears what's already
// connected. Every live session powers the shared feed (option chain, quotes…).
export default function Feedmaster() {
  const [users, setUsers] = useState([])
  const [userId, setUserId] = useState('')
  const [configs, setConfigs] = useState([])          // the browsed user's accounts
  // Selection + results are restored from localStorage so they survive leaving
  // the page (e.g. going to the Option Chain) and coming back.
  const [selected, setSelected] = useState(() => new Set(getFeedState().selected || []))
  // Global results: configId -> { status, label, message, clientCode, userId, account, broker }
  // Drop any stale 'pending' from a login that was mid-flight when we left.
  const [results, setResults] = useState(() => {
    const r = getFeedState().results || {}
    for (const k of Object.keys(r)) if (r[k]?.status === 'pending') delete r[k]
    return r
  })
  const [backendFeed, setBackendFeed] = useState({})
  const [wsFeed, setWsFeed] = useState({ brokers: {}, clients: 0 })
  const [feedError, setFeedError] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Persist selection + results whenever they change, so navigation never loses
  // what you've picked or connected.
  useEffect(() => {
    saveFeedState({ selected: [...selected], results })
  }, [selected, results])

  async function loadBackendFeed({ silent = true } = {}) {
    try {
      const res = await fetch('/api/feed/status')
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.status === false) throw new Error(body.message || `HTTP ${res.status}`)
      setBackendFeed(body.feed || {})
      setFeedError('')
      loadWsFeed()
      return body.feed || {}
    } catch (e) {
      setBackendFeed({})
      setFeedError(e.message || 'Failed to load backend feed status')
      if (!silent) setError(e.message || 'Failed to load backend feed status')
      return {}
    }
  }

  // Live broker WebSocket status (the openalgo-style /ws/feed adapters): each
  // broker logged into the feed auto-starts its market-data socket; this shows
  // connected/subscriptions per broker.
  async function loadWsFeed() {
    try {
      const res = await fetch('/api/ws/feed/status')
      const body = await res.json().catch(() => ({}))
      if (res.ok && body.status) setWsFeed({ brokers: body.brokers || {}, clients: body.clients || 0 })
    } catch { /* backend without ws feed: hide the section */ }
  }

  // Option Chain reads this same backend registry, so the Feed Master card must
  // show backend truth instead of stale localStorage login results.
  useEffect(() => {
    let alive = true
    const load = async () => {
      const feed = await loadBackendFeed()
      if (alive) setBackendFeed(feed)
    }
    load()
    const timer = setInterval(load, 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  // Load users.
  useEffect(() => {
    let cancelled = false
    apiGet('/users/list').then((res) => {
      if (cancelled) return
      const list = res.data || []
      setUsers(list)
      const saved = getSavedFeedMaster()
      setUserId(saved?.userId || String(list[0]?.id || ''))
    }).catch((e) => setError(e.message))
    return () => { cancelled = true }
  }, [])

  // Load the BROWSED user's accounts. Does NOT clear global selection/results —
  // switching users only changes the list you see, never what's connected.
  useEffect(() => {
    let cancelled = false
    if (!userId) { setConfigs([]); return }
    apiGet(`/users/broker-config/list?user_id=${encodeURIComponent(userId)}`).then((res) => {
      if (cancelled) return
      setConfigs(res.data || [])
    }).catch((e) => setError(e.message))
    return () => { cancelled = true }
  }, [userId])

  const toggle = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const selectAllHere = () => setSelected((s) => { const n = new Set(s); configs.forEach((c) => n.add(c.id)); return n })
  const selectNoneHere = () => setSelected((s) => { const n = new Set(s); configs.forEach((c) => n.delete(c.id)); return n })

  // Log in the selected accounts of the CURRENTLY BROWSED user (in parallel),
  // adding their live sessions to the global feed without disturbing others.
  async function loginSelected() {
    const chosen = configs.filter((c) => selected.has(c.id))
    if (!chosen.length) { setError('Select at least one account'); return }
    setError(''); setLoading(true)
    const uname = users.find((u) => String(u.id) === String(userId))?.username || userId
    setResults((r) => ({ ...r, ...Object.fromEntries(chosen.map((c) => [c.id, { status: 'pending', label: brokerLabel(c.broker_name), userId, userName: uname, account: c.account_id, broker: c.broker_name }])) }))

    await Promise.all(chosen.map(async (c) => {
      const base = { label: brokerLabel(c.broker_name), userId, userName: uname, account: c.account_id, broker: c.broker_name }
      try {
        const res = await loginClient(c, { feedRegister: true, userName: uname })
        let status = 'ok', message = res.sessionSource || 'live'
        if (res.needsOtp) { status = 'needs-otp'; message = 'needs one-time OTP' }
        else if (res.needsLogin) { status = 'needs-login'; message = 'needs browser login' }
        setResults((r) => ({ ...r, [c.id]: { ...base, status, message, clientCode: res.clientCode } }))
      } catch (e) {
        setResults((r) => ({ ...r, [c.id]: { ...base, status: 'error', message: e.message } }))
      }
    }))

    await loadBackendFeed({ silent: false })
    // Persist only the UI selection. Live feed status comes from /api/feed/status.
    saveFeedMaster({ userId, configIds: [...selected] })
    setLoading(false)
  }

  const statusChip = (r) => {
    if (!r) return null
    if (r.status === 'pending') return <Chip size="small" icon={<CircularProgress size={12} />} label="Logging in…" />
    if (r.status === 'ok') return <Chip size="small" color="success" icon={<CheckCircle2 size={13} />} label={`Live${r.clientCode ? ' · ' + r.clientCode : ''}`} />
    if (r.status === 'needs-otp') return <Chip size="small" color="warning" label="Needs OTP" />
    if (r.status === 'needs-login') return <Chip size="small" color="warning" label="Needs browser login" />
    return <Chip size="small" color="error" icon={<XCircle size={13} />} label={r.message?.slice(0, 40) || 'Failed'} />
  }

  const connected = Object.entries(backendFeed).filter(([, r]) => r?.live)
  const hasRecentAttempts = Object.keys(results).length > 0

  return (
    <Box>
      <Box sx={{ mb: 2 }}>
        <Typography variant="h5">Feed Master</Typography>
        <Typography color="text.secondary" fontSize="0.875rem">
          Connect broker accounts from any number of users. Their live sessions power the shared feed (option chain, quotes…).
        </Typography>
      </Box>

      {/* Global connected list — everything live across ALL users. */}
      {(connected.length > 0 || hasRecentAttempts || feedError) && (
        <Paper sx={{ p: 2, mb: 2, maxWidth: 820 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <Radio size={15} color="var(--ao-green)" />
            <Typography sx={{ fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: 'text.secondary' }}>
              Connected feed ({connected.length} live)
            </Typography>
          </Box>
          {connected.map(([broker, r]) => (
            <Box key={broker} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 0.4 }}>
              <Chip size="small" color="success" variant="outlined" label={brokerLabel(broker)} />
              <Typography sx={{ fontSize: '0.82rem', minWidth: 120 }}>{r.account || r.user || '-'}</Typography>
              <Typography sx={{ fontSize: '0.78rem', color: 'text.secondary', flex: 1 }}>{r.user || 'Backend feed registry'}</Typography>
              <Chip size="small" color="success" icon={<CheckCircle2 size={13} />} label="Live in backend" />
            </Box>
          ))}
          {connected.length === 0 && (
            <Typography sx={{ fontSize: '0.82rem', color: 'text.secondary', py: 0.5 }}>
              Backend feed registry is empty. Log in Angel and Upstox here; Option Chain will show Bid/Ask only after Upstox appears here.
            </Typography>
          )}
          {Object.keys(wsFeed.brokers).length > 0 && (
            <>
              <Divider sx={{ my: 1.5 }} />
              <Typography sx={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: 'text.secondary', mb: 0.5 }}>
                Broker WebSockets ({wsFeed.clients} client{wsFeed.clients === 1 ? '' : 's'} on /ws/feed)
              </Typography>
              {Object.entries(wsFeed.brokers).map(([broker, s]) => (
                <Box key={broker} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 0.4 }}>
                  <Chip size="small" variant="outlined" color={s.connected ? 'success' : 'default'} label={brokerLabel(broker)} />
                  <Typography sx={{ fontSize: '0.82rem', minWidth: 120 }}>{s.account || s.feedAccount || '—'}</Typography>
                  <Typography sx={{ fontSize: '0.78rem', color: 'text.secondary', flex: 1 }}>
                    {s.connected ? `streaming · ${s.subscriptions || 0} subscription${(s.subscriptions || 0) === 1 ? '' : 's'}`
                      : s.running ? (s.lastError || 'connecting…') : 'not started'}
                  </Typography>
                  {s.connected
                    ? <Chip size="small" color="success" icon={<CheckCircle2 size={13} />} label="WS connected" />
                    : <Chip size="small" color={s.running ? 'warning' : 'default'} label={s.running ? 'WS connecting' : 'WS off'} />}
                </Box>
              ))}
            </>
          )}
          {feedError && <Alert severity="warning" sx={{ mt: 1 }}>{feedError}</Alert>}
          {hasRecentAttempts && (
            <>
              <Divider sx={{ my: 1.5 }} />
              <Typography sx={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: 'text.secondary', mb: 0.5 }}>
                Recent login attempts
              </Typography>
            </>
          )}
          {Object.entries(results).map(([id, r]) => (
            <Box key={id} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 0.4 }}>
              <Chip size="small" variant="outlined" color="primary" label={r.label} />
              <Typography sx={{ fontSize: '0.82rem', minWidth: 120 }}>{r.account || '—'}</Typography>
              <Typography sx={{ fontSize: '0.78rem', color: 'text.secondary', flex: 1 }}>{r.userName}</Typography>
              {statusChip(r)}
            </Box>
          ))}
        </Paper>
      )}

      <Paper sx={{ p: 2, maxWidth: 820 }}>
        {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

        <FormControl fullWidth sx={{ mb: 2 }}>
          <InputLabel>User</InputLabel>
          <Select label="User" value={userId} onChange={(e) => setUserId(e.target.value)}>
            {users.map((u) => <MenuItem key={u.id} value={String(u.id)}>{u.username}</MenuItem>)}
          </Select>
        </FormControl>

        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
          <Typography sx={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: 'text.secondary' }}>
            Accounts for this user
          </Typography>
          <Box>
            <Button size="small" onClick={selectAllHere}>All</Button>
            <Button size="small" onClick={selectNoneHere}>None</Button>
          </Box>
        </Box>

        {configs.length === 0 && <Typography color="text.secondary" sx={{ py: 2 }}>This user has no broker accounts.</Typography>}

        {configs.map((c) => (
          <Box key={c.id} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 0.5, borderBottom: '1px solid var(--ao-border-soft)' }}>
            <FormControlLabel
              sx={{ flex: 1, m: 0 }}
              control={<Checkbox size="small" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />}
              label={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Chip size="small" variant="outlined" color="primary" label={brokerLabel(c.broker_name)} />
                  <Typography sx={{ fontSize: '0.85rem' }}>{c.account_id || '—'}</Typography>
                  {c.totp_secret && <Chip size="small" label="TOTP" />}
                </Box>
              }
            />
            {statusChip(results[c.id])}
          </Box>
        ))}

        <Divider sx={{ my: 2 }} />
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <Button variant="contained" startIcon={loading ? <CircularProgress size={15} color="inherit" /> : <PlugZap size={16} />}
            disabled={loading || configs.filter((c) => selected.has(c.id)).length === 0} onClick={loginSelected}>
            {loading ? 'Connecting…' : `Log in this user's selected (${configs.filter((c) => selected.has(c.id)).length})`}
          </Button>
          <Typography sx={{ fontSize: '0.8rem', color: 'text.secondary' }}>
            Switch the user to add more accounts to the feed — already-connected ones stay live.
          </Typography>
        </Box>
      </Paper>
    </Box>
  )
}
