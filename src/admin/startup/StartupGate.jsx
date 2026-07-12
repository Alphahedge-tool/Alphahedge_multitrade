import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert, Box, Button, Checkbox, Chip, CircularProgress, Divider, FormControl, InputLabel,
  LinearProgress, ListItemText, MenuItem, Paper, Select, Stack, Typography,
} from '@mui/material'
import { AlertTriangle, CheckCircle2, RefreshCw, Radio } from 'lucide-react'

import { apiGet } from '../config/api'
import {
  FEED_BROKERS, brokerApiPath, getSavedFeedMaster, loginClient, saveFeedMaster,
} from '../feedmaster/feedMasterStore'

const LOGIN_CONCURRENCY = 3

const brokerLabel = (name) => {
  const path = brokerApiPath(name)
  return FEED_BROKERS.find((broker) => broker.apiPath === path)?.label || name || 'Broker'
}

export default function StartupGate({ children }) {
  const started = useRef(false)
  const [step, setStep] = useState('accounts')
  const [phase, setPhase] = useState('loading')
  const [accounts, setAccounts] = useState([])
  const [error, setError] = useState('')
  const [feedPicks, setFeedPicks] = useState(() => {
    const saved = getSavedFeedMaster()
    return (saved?.configIds || (saved?.configId ? [saved.configId] : [])).map(String)
  })
  const [savingFeed, setSavingFeed] = useState(false)

  const runLogins = async () => {
    setPhase('loading')
    setError('')
    try {
      const users = (await apiGet('/users/list')).data || []
      const rows = (await Promise.all(users.map(async (user) => {
        try {
          const result = await apiGet(`/users/broker-config/list?user_id=${encodeURIComponent(user.id)}`)
          return (result.data || []).map((config) => ({ config, user }))
        } catch {
          return []
        }
      }))).flat()

      const hydrated = await runPool(rows.map(({ config, user }) => async () => {
        let full = config
        try {
          const result = await apiGet(`/users/broker-config/get?id=${encodeURIComponent(config.id)}`)
          full = { ...config, ...(result.data || {}) }
        } catch { /* the login row will show the backend error if details are incomplete */ }
        return {
          config: full,
          configId: String(full.id),
          userId: String(user.id),
          username: user.username || `${user.first_name || ''} ${user.last_name || ''}`.trim() || `User ${user.id}`,
          accountId: full.account_id || '',
          broker: full.broker_name || '',
          status: 'pending',
          message: 'Waiting to sign in…',
        }
      }), 4)

      setAccounts(hydrated)
      setPhase('logging-in')
      await runPool(hydrated.map((account) => async () => {
        patchAccount(setAccounts, account.configId, { status: 'logging-in', message: 'Signing in…' })
        try {
          const result = await loginClient(account.config)
          if (result.needsOtp) {
            patchAccount(setAccounts, account.configId, { status: 'failed', message: 'One-time OTP is required.' })
          } else if (result.needsLogin) {
            patchAccount(setAccounts, account.configId, { status: 'failed', message: 'Browser authorization is required.' })
          } else {
            patchAccount(setAccounts, account.configId, { status: 'live', message: result.sessionSource === 'session' ? 'Saved session is valid.' : 'Signed in successfully.' })
          }
        } catch (loginError) {
          patchAccount(setAccounts, account.configId, { status: 'failed', message: loginError.message || 'Login failed.' })
        }
      }), LOGIN_CONCURRENCY)
      setPhase('ready')
    } catch (loadError) {
      setError(loadError.message || 'Failed to load broker accounts.')
      setPhase('ready')
    }
  }

  useEffect(() => {
    if (started.current) return
    started.current = true
    runLogins()
  }, [])

  const live = useMemo(() => accounts.filter((account) => account.status === 'live'), [accounts])
  const failed = useMemo(() => accounts.filter((account) => account.status === 'failed'), [accounts])
  const selectedIds = feedPicks.filter((id) => live.some((account) => account.configId === id))
  const effectiveSelectedIds = selectedIds.length ? selectedIds : (live[0] ? [live[0].configId] : [])
  const selectedAccounts = live.filter((account) => effectiveSelectedIds.includes(account.configId))

  if (step === 'done') return children

  const confirmFeed = async () => {
    if (!selectedAccounts.length) { setStep('done'); return }
    setSavingFeed(true)
    setError('')
    try {
      await Promise.all(selectedAccounts.map(async (account) => {
        const result = await loginClient(account.config, { feedRegister: true, userName: account.username })
        if (result.needsOtp || result.needsLogin) throw new Error(`${account.accountId || account.configId} needs interactive login before it can provide the feed.`)
      }))
      const primary = selectedAccounts[0]
      saveFeedMaster({
        broker: primary.broker,
        userId: primary.userId,
        configId: primary.configId,
        configIds: selectedAccounts.map((account) => account.configId),
        accountId: primary.accountId,
      })
      setStep('done')
    } catch (feedError) {
      setError(feedError.message || 'Failed to register the Feed Master.')
    } finally {
      setSavingFeed(false)
    }
  }

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'background.default', p: 2 }}>
      <Paper sx={{ p: 3, width: '100%', maxWidth: 760 }}>
        {step === 'accounts' ? (
          <AccountsStep accounts={accounts} phase={phase} error={error} live={live} failed={failed} onRetry={runLogins} onContinue={() => setStep('feedmaster')} />
        ) : (
          <FeedStep live={live} selectedIds={effectiveSelectedIds} selectedAccounts={selectedAccounts} error={error} saving={savingFeed} onChange={setFeedPicks} onBack={() => setStep('accounts')} onContinue={confirmFeed} />
        )}
      </Paper>
    </Box>
  )
}

function AccountsStep({ accounts, phase, error, live, failed, onRetry, onContinue }) {
  const busy = phase !== 'ready'
  const completed = live.length + failed.length
  return <>
    <Typography variant="h5" fontWeight={600}>Signing in broker accounts</Typography>
    <Typography color="text.secondary" fontSize="0.875rem" sx={{ mt: 0.5 }}>
      All configured accounts are signed in before the admin app opens.
    </Typography>
    {busy && <LinearProgress variant={accounts.length ? 'determinate' : 'indeterminate'} value={accounts.length ? completed / accounts.length * 100 : 0} sx={{ mt: 2 }} />}
    {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
    {!busy && !accounts.length && <Alert severity="warning" sx={{ mt: 2 }}>No broker accounts are configured. You can continue and add them from Users.</Alert>}
    {!busy && accounts.length > 0 && <Alert severity={failed.length ? 'warning' : 'success'} sx={{ mt: 2 }}>
      {failed.length ? `${live.length} of ${accounts.length} accounts logged in; ${failed.length} need attention.` : `All ${accounts.length} accounts are logged in.`}
    </Alert>}
    <Stack divider={<Divider />} sx={{ mt: 2 }}>
      {accounts.map((account) => <AccountRow key={account.configId} account={account} />)}
    </Stack>
    <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 3 }}>
      <Button startIcon={<RefreshCw size={14} />} disabled={busy} onClick={onRetry}>Retry all</Button>
      <Button variant="contained" disabled={busy} onClick={onContinue}>{failed.length ? 'Continue anyway' : 'Continue'}</Button>
    </Box>
  </>
}

function AccountRow({ account }) {
  const busy = account.status === 'pending' || account.status === 'logging-in'
  return <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 1.1 }}>
    {busy ? <CircularProgress size={17} /> : account.status === 'live' ? <CheckCircle2 size={18} color="#2e7d32" /> : <AlertTriangle size={18} color="#ed6c02" />}
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography fontWeight={600} fontSize="0.9rem">{account.username} — {account.accountId || `Config ${account.configId}`}</Typography>
      <Typography color={account.status === 'failed' ? 'warning.main' : 'text.secondary'} fontSize="0.8rem">{account.message}</Typography>
    </Box>
    <Chip size="small" variant="outlined" label={brokerLabel(account.broker)} />
    {account.status === 'live' && <Chip size="small" color="success" label="Logged in" />}
  </Box>
}

function FeedStep({ live, selectedIds, selectedAccounts, error, saving, onChange, onBack, onContinue }) {
  return <>
    <Typography variant="h5" fontWeight={600}>Choose Feed Master accounts</Typography>
    <Typography color="text.secondary" fontSize="0.875rem" sx={{ mt: 0.5 }}>Choose one or more logged-in accounts to provide the shared live market feeds.</Typography>
    {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
    {!live.length ? <Alert severity="warning" sx={{ mt: 2 }}>No account logged in successfully. Go back and retry, or continue without a live feed.</Alert> : <>
      <FormControl fullWidth sx={{ mt: 2 }}>
        <InputLabel>Feed Master accounts</InputLabel>
        <Select
          multiple
          label="Feed Master accounts"
          value={selectedIds}
          onChange={(event) => onChange(typeof event.target.value === 'string' ? event.target.value.split(',') : event.target.value)}
          renderValue={(ids) => `${ids.length} account${ids.length === 1 ? '' : 's'} selected`}
        >
          {live.map((account) => <MenuItem key={account.configId} value={account.configId}>
            <Checkbox checked={selectedIds.includes(account.configId)} />
            <ListItemText primary={`${brokerLabel(account.broker)} — ${account.username} — ${account.accountId}`} />
          </MenuItem>)}
        </Select>
      </FormControl>
      {selectedAccounts.length > 0 && <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 2, color: 'text.secondary' }}><Radio size={16} /><Typography fontSize="0.875rem">{selectedAccounts.length} account{selectedAccounts.length === 1 ? '' : 's'} will provide live feeds. The first selected account remains the primary feed.</Typography></Box>}
    </>}
    <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 3 }}>
      <Button disabled={saving} onClick={onBack}>Back</Button>
      <Button variant="contained" disabled={saving || (live.length > 0 && !selectedAccounts.length)} onClick={onContinue}>{saving ? 'Starting feeds…' : live.length ? `Save ${selectedAccounts.length} Feed Master account${selectedAccounts.length === 1 ? '' : 's'} and open app` : 'Continue without feed'}</Button>
    </Box>
  </>
}

function patchAccount(setAccounts, configId, patch) {
  setAccounts((current) => current.map((account) => account.configId === configId ? { ...account, ...patch } : account))
}

async function runPool(tasks, limit) {
  const results = new Array(tasks.length)
  let next = 0
  async function worker() {
    while (next < tasks.length) {
      const index = next++
      results[index] = await tasks[index]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()))
  return results
}
