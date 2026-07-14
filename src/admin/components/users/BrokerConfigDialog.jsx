import { useEffect, useState } from 'react'
import {
  Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
  Divider, FormControl, IconButton, InputLabel, MenuItem, Select, TextField, Typography,
} from '@mui/material'
import { Globe, Pencil, PlugZap, Plus, Trash2 } from 'lucide-react'
import { apiGet, apiPost, brokerAutoLogin } from '../../config/api'
import { openBrokerOAuthPopup, saveSession } from '../../feedmaster/feedMasterStore'

// Per-broker credential field schemas. All 5 brokers supported. account_id maps
// to broker_accounts.client_code, app_key -> api_key, app_secret -> api_secret.
const BROKERS = [
  { id: 'angelone', label: 'Angel One', apiPath: 'angel' },
  { id: 'upstox', label: 'Upstox', apiPath: 'upstox' },
  { id: 'zerodha', label: 'Zerodha Kite', apiPath: 'zerodha' },
  { id: 'kotak', label: 'Kotak Neo', apiPath: 'kotak' },
  { id: 'nubra', label: 'Nubra', apiPath: 'nubra' },
]

// The broker_accounts.broker column stores display-y values ("Angel", "Upstox",
// "KotakNeoV3", "Nubra") that don't match the dialog's canonical ids. Normalize
// any stored value to a canonical id so the dropdown selects it and the right
// field set/labels show (otherwise the dropdown is blank and Angel fields leak).
function normalizeBroker(name) {
  const n = String(name || '').toLowerCase().replace(/\s/g, '')
  if (n.includes('angel')) return 'angelone'
  if (n.includes('upstox')) return 'upstox'
  if (n.includes('zerodha') || n.includes('kite')) return 'zerodha'
  if (n.includes('kotak')) return 'kotak'
  if (n.includes('nubra')) return 'nubra'
  return BROKERS.some((b) => b.id === n) ? n : 'angelone'
}

const FIELDS = {
  angelone: ['account_id', 'pin', 'totp_secret', 'app_key'],
  upstox: ['account_id', 'app_key', 'app_secret', 'pin', 'totp_secret', 'phone'],
  zerodha: ['account_id', 'app_key', 'app_secret', 'pin', 'totp_secret'],
  kotak: ['account_id', 'app_secret', 'pin', 'totp_secret', 'phone'],
  nubra: ['pin', 'totp_secret', 'phone'],
}

// Per-broker field labels so each broker shows exactly the credential names it
// uses for auto-login (e.g. Angel shows "Client Code / PIN / TOTP Secret / API
// Key"; Kotak shows "UCC / Access Token / MPIN …").
const LABELS_BY_BROKER = {
  angelone: { account_id: 'Client Code', pin: 'PIN', totp_secret: 'TOTP Secret', app_key: 'API Key' },
  upstox: { account_id: 'User ID', app_key: 'API Key', app_secret: 'API Secret', pin: 'PIN', totp_secret: 'TOTP Secret', phone: 'Phone' },
  // Zerodha's Kite password rides in the shared `pin` column — broker_accounts has
  // no password column, and Zerodha has no PIN, so the slot is free. Fill password
  // + TOTP secret and login is fully headless; leave them blank and it falls back
  // to the Kite browser popup.
  zerodha: { account_id: 'User ID (Kite)', app_key: 'API Key', app_secret: 'API Secret', pin: 'Password', totp_secret: 'TOTP Secret' },
  kotak: { account_id: 'UCC (Client Code)', app_secret: 'Access Token (NeoFinKey)', pin: 'MPIN', totp_secret: 'TOTP Secret', phone: 'Mobile (+91…)' },
  nubra: { pin: 'MPIN', totp_secret: 'TOTP Secret', phone: 'Phone' },
}
const labelFor = (broker, field) => LABELS_BY_BROKER[broker]?.[field] || field
const brokerApiPath = (name) => BROKERS.find((b) => b.id === normalizeBroker(name))?.apiPath || 'angel'
const emptyConfig = () => ({ broker_name: 'angelone', account_id: '', app_key: '', app_secret: '', pin: '', totp_secret: '', phone: '' })

// BrokerConfigDialog manages ALL broker accounts for one user (alias). Add, edit,
// delete, and test-login each broker independently — this is multi-broker per user.
export default function BrokerConfigDialog({ open, user, onClose, onChanged, onToast }) {
  const [configs, setConfigs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(null) // config being edited (or 'new')
  const [form, setForm] = useState(emptyConfig())
  const [busy, setBusy] = useState('')
  const [saving, setSaving] = useState(false)
  // Random nonce mixed into each input's name so the browser can't match saved
  // credentials to these fields and autofill them. Regenerated on each add/edit.
  const [fieldNonce, setFieldNonce] = useState(() => Math.random().toString(36).slice(2))

  async function load() {
    if (!user) return
    setError('')
    setLoading(true)
    try {
      const res = await apiGet(`/users/broker-config/list?user_id=${encodeURIComponent(user.id)}`)
      setConfigs(res.data || [])
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  // On open (or user change): clear the previous user's list immediately so no
  // stale brokers flash, then load this user's configs.
  useEffect(() => {
    if (open) { setEditing(null); setConfigs([]); setLoading(true); load() }
    /* eslint-disable-next-line */
  }, [open, user])

  const startAdd = () => { setFieldNonce(Math.random().toString(36).slice(2)); setForm(emptyConfig()); setEditing('new') }
  const startEdit = (c) => {
    setFieldNonce(Math.random().toString(36).slice(2))
    // Normalize the stored broker ("Upstox", "KotakNeoV3", …) to the canonical
    // dialog id so the dropdown selects it and its own fields/labels render.
    setForm({ ...emptyConfig(), ...c, broker_name: normalizeBroker(c.broker_name) })
    setEditing(c.id)
  }

  async function save() {
    setError('')
    setSaving(true)
    const isNew = editing === 'new'
    // Optimistic: update the visible list immediately, then confirm with the
    // server in the background. On error we reload to revert.
    const tempId = `temp-${Date.now()}`
    const optimistic = { id: isNew ? tempId : editing, user_id: user.id, ...form }
    setConfigs((cur) => isNew ? [...cur, optimistic] : cur.map((c) => (c.id === editing ? optimistic : c)))
    setEditing(null)
    try {
      if (isNew) {
        const res = await apiPost('/users/broker-config/create', { user_id: user.id, ...form })
        // swap the temp row for the real one (with its DB id)
        if (res.data) setConfigs((cur) => cur.map((c) => (c.id === tempId ? res.data : c)))
        onToast?.('Broker account added')
      } else {
        await apiPost('/users/broker-config/update', { id: optimistic.id, ...form })
        onToast?.('Broker account updated')
      }
      onChanged?.()
    } catch (e) {
      setError(e.message)
      await load() // revert to server truth
    } finally {
      setSaving(false)
    }
  }

  async function remove(c) {
    if (!window.confirm(`Delete this ${c.broker_name} account?`)) return
    // Optimistic: drop it from the list right away.
    const prev = configs
    setConfigs((cur) => cur.filter((x) => x.id !== c.id))
    try {
      await apiPost('/users/broker-config/delete', { id: c.id })
      onChanged?.(); onToast?.('Broker account deleted')
    } catch (e) {
      setError(e.message); setConfigs(prev) // restore on failure
    }
  }

  // The login "client" the Node auto-login routes expect, built from a config row.
  function loginClient(c, path) {
    return {
      state: `${path}-${c.id}-${Date.now()}`,
      configId: c.id, // so the resolved account id (e.g. Upstox user_id) saves back
      clientCode: c.account_id, apiKey: c.app_key, apiSecret: c.app_secret,
      pin: c.pin, mpin: c.pin, totpSecret: c.totp_secret, phone: c.phone,
      mobileNumber: c.phone, ucc: c.account_id,
      accessToken: path === 'kotak' ? (c.app_secret || c.app_key) : (c.app_key || c.app_secret),
      autoLogin: true,
    }
  }

  // Handle a login response uniformly for both the auto (Test Login) and manual
  // (Browser Login) paths: OTP prompts, missing-cred prompts, the wrong-account
  // guard, and finally saving the session. Returns true when a session was saved.
  async function applyLoginResult(c, res, path) {
    if (res.needsOtp) { onToast?.('Nubra needs one-time OTP — use the OTP flow'); return false }
    // Zerodha with missing creds and no popup offered: tell the user what to add.
    if (res.needsCreds) { setError(res.reason || 'Add Password + TOTP Secret to log in'); return false }
    if (res.needsLogin) { onToast?.(`${BROKERS.find((b) => b.apiPath === path)?.label || c.broker_name} needs browser login`); return false }
    // For Zerodha the account_id IS the Kite user id, and the browser popup
    // remembers whoever last logged into kite.zerodha.com — possibly a DIFFERENT
    // user. Never attach that stranger's session to a row that names a specific
    // account: bail with a hint to switch users. (If account_id is blank we accept
    // whoever logged in and save it back below.)
    if (path === 'zerodha' && c.account_id && res.clientCode &&
      String(res.clientCode).toUpperCase() !== String(c.account_id).toUpperCase()) {
      setError(`Logged in as ${res.clientCode}, but this account is ${c.account_id}. ` +
        `Click “Change user” in the Kite popup and sign in as ${c.account_id}.`)
      return false
    }
    onToast?.(`${c.broker_name} logged in — ${res.sessionSource || 'live'}`)
    if (res.session) saveSession(c.id, res.session)
    // Resolved a real user id that differs from the stored one -> refresh so the
    // UI shows it (Upstox auto-fills account_id; manual login fills a blank one).
    if (res.clientCode && res.clientCode !== c.account_id) { await load(); onChanged?.() }
    return true
  }

  // Test login drives the matching broker's auto-login through the Node backend.
  async function testLogin(c) {
    setBusy(c.id); setError('')
    try {
      const path = brokerApiPath(c.broker_name)
      const client = loginClient(c, path)
      let res = await brokerAutoLogin(path, client)
      if (res.needsLogin && res.loginUrl) {
        // A popup is only auto-offered when the backend gives a loginUrl. For
        // Zerodha that's ONLY the one-time app-authorize consent — never a
        // no-cred fallback (that returns needsCreds with no loginUrl). Manual
        // browser login is a separate, explicit button (browserLogin).
        if (res.reason) onToast?.(res.reason)
        const account = await openBrokerOAuthPopup(res.loginUrl, res.broker || path)
        res = await brokerAutoLogin(path, { ...client, clientCode: account || client.clientCode, userId: account || client.clientCode })
      }
      await applyLoginResult(c, res, path)
    } catch (e) { setError(`${c.broker_name}: ${e.message}`) }
    finally { setBusy('') }
  }

  // Manual browser login: for accounts WITHOUT a stored password/TOTP (or when the
  // user simply prefers to type credentials each time). The `manual` flag makes the
  // backend skip headless and hand back the Kite popup URL; after login the same
  // account-safety guard applies, so a login as the wrong Kite user is refused
  // rather than saved to this row.
  async function browserLogin(c) {
    setBusy(c.id); setError('')
    try {
      const path = brokerApiPath(c.broker_name)
      const client = { ...loginClient(c, path), manual: true }
      let res = await brokerAutoLogin(path, client)
      if (res.needsLogin && res.loginUrl) {
        // Kite's popup pre-fills whichever user this browser last logged in as —
        // which may not be this account. We can't change that (no Kite param for
        // it), so warn the user to switch, naming the account they must pick.
        if (c.account_id) onToast?.(`In the Kite popup, make sure you're signed in as ${c.account_id} — click “Change user” if it shows someone else.`)
        const account = await openBrokerOAuthPopup(res.loginUrl, res.broker || path)
        // The callback already exchanged + cached the session; this fetches it.
        res = await brokerAutoLogin(path, { ...client, clientCode: account || client.clientCode, userId: account || client.clientCode })
      }
      await applyLoginResult(c, res, path)
    } catch (e) { setError(`${c.broker_name}: ${e.message}`) }
    finally { setBusy('') }
  }

  const fields = FIELDS[form.broker_name] || FIELDS.angelone

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>Broker Configuration — {user?.username}</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

        {editing === null && (
          <>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1 }}>
              <Button size="small" variant="contained" startIcon={<Plus size={15} />} onClick={startAdd} disabled={loading}>Add Broker</Button>
            </Box>
            {loading && (
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, py: 4, color: 'text.secondary' }}>
                <CircularProgress size={18} />
                <Typography fontSize="0.85rem">Loading brokers…</Typography>
              </Box>
            )}
            {!loading && configs.length === 0 && <Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>No broker accounts yet.</Typography>}
            {!loading && configs.map((c) => (
              <Box key={c.id} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 1.25, mb: 1, border: '1px solid var(--ao-border-soft)', borderRadius: 1 }}>
                <Chip size="small" label={BROKERS.find((b) => b.id === normalizeBroker(c.broker_name))?.label || c.broker_name} color="primary" variant="outlined" />
                <Typography sx={{ flex: 1, fontSize: '0.85rem' }}>
                  {c.account_id || '—'} {c.pin ? '• Password set' : ''} {c.totp_secret ? '• TOTP set' : ''}
                </Typography>
                <Button size="small" variant="outlined" startIcon={<PlugZap size={14} />} disabled={busy === c.id} onClick={() => testLogin(c)}>
                  {busy === c.id ? 'Testing…' : 'Test Login'}
                </Button>
                {/* Manual browser login — for Zerodha accounts without a stored
                    TOTP, or when the user prefers to type credentials each time. */}
                {brokerApiPath(c.broker_name) === 'zerodha' && (
                  <Button size="small" variant="text" startIcon={<Globe size={14} />} disabled={busy === c.id} onClick={() => browserLogin(c)} title="Log in through the Kite browser popup (no stored TOTP needed)">
                    Browser Login
                  </Button>
                )}
                <IconButton size="small" onClick={() => startEdit(c)}><Pencil size={15} /></IconButton>
                <IconButton size="small" onClick={() => remove(c)}><Trash2 size={15} /></IconButton>
              </Box>
            ))}
          </>
        )}

        {editing !== null && (
          <Box sx={{ display: 'grid', gap: 2, pt: 1 }}>
            <FormControl fullWidth>
              <InputLabel>Broker</InputLabel>
              <Select
                label="Broker"
                value={form.broker_name}
                onChange={(e) => {
                  // Switching broker must CLEAR the credential fields — otherwise a
                  // value typed for one broker (e.g. another account's API key/PIN)
                  // leaks into the new broker's blank fields. Keep only the broker.
                  setForm({ ...emptyConfig(), broker_name: e.target.value })
                }}
              >
                {BROKERS.map((b) => <MenuItem key={b.id} value={b.id}>{b.label}</MenuItem>)}
              </Select>
            </FormControl>
            <Divider />
            {/* Decoy fields: Chrome ignores autoComplete="off" and injects saved
                credentials into the first text + password fields it sees. These
                hidden dummies absorb that autofill so the real fields stay blank. */}
            <input type="text" name="username" autoComplete="username" style={{ display: 'none' }} tabIndex={-1} aria-hidden="true" />
            <input type="password" name="password" autoComplete="new-password" style={{ display: 'none' }} tabIndex={-1} aria-hidden="true" />
            {/* key includes the broker so React remounts inputs when the broker
                changes — no stale value carried over between brokers. Each field
                gets a random name + new-password autoComplete so the browser can't
                match it to saved credentials and pre-fill it. */}
            {fields.map((f) => {
              const isSecret = f.includes('secret') || f === 'pin'
              return (
                <TextField
                  key={`${form.broker_name}-${f}`}
                  label={labelFor(form.broker_name, f)}
                  value={form[f] || ''}
                  type={isSecret ? 'password' : 'text'}
                  onChange={(e) => setForm({ ...form, [f]: e.target.value })}
                  fullWidth
                  inputProps={{
                    autoComplete: 'new-password',
                    autoCorrect: 'off',
                    autoCapitalize: 'off',
                    spellCheck: false,
                    name: `bc_${form.broker_name}_${f}_${fieldNonce}`,
                    'data-lpignore': 'true', // LastPass ignore
                    'data-1p-ignore': 'true', // 1Password ignore
                  }}
                />
              )
            })}
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        {editing !== null ? (
          <>
            <Button onClick={() => setEditing(null)}>Back</Button>
            <Button variant="contained" onClick={save} disabled={saving}
              startIcon={saving ? <CircularProgress size={14} color="inherit" /> : null}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Close</Button>
        )}
      </DialogActions>
    </Dialog>
  )
}
