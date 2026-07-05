import { Fragment, useEffect, useState } from 'react'
import {
  Alert, Box, Button, Chip, CircularProgress, Collapse, Dialog, DialogActions, DialogContent, DialogTitle,
  IconButton, Paper, Snackbar, Table, TableBody, TableCell, TableHead, TableRow, TextField,
  Tooltip, Typography,
} from '@mui/material'
import {
  ChevronDown, ChevronRight, Mail, Pencil, Phone, Plus, Settings, Trash2, User as UserIcon,
} from 'lucide-react'
import BrokerConfigDialog from '../components/users/BrokerConfigDialog'
import { apiGet, apiPost } from '../config/api'

const BROKER_LABELS = { angelone: 'Angel One', upstox: 'Upstox', kotak: 'Kotak Neo', nubra: 'Nubra', Angel: 'Angel One', Upstox: 'Upstox', KotakNeoV3: 'Kotak Neo', Nubra: 'Nubra' }
const brokerLabel = (n) => BROKER_LABELS[n] || n

// Users page — each user (alias) row EXPANDS to show every broker account that
// user is connected to (broker, account id, TOTP status, phone, login flags).
export default function UsersPage() {
  const [users, setUsers] = useState([])
  const [configsByUser, setConfigsByUser] = useState({}) // userId -> broker configs
  const [expanded, setExpanded] = useState(null)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [saving, setSaving] = useState(false)

  const [openForm, setOpenForm] = useState(false)
  const [editingUser, setEditingUser] = useState(null)
  const [form, setForm] = useState({ username: '', email: '', mobile: '' })
  const [brokerUser, setBrokerUser] = useState(null)

  async function load() {
    setError('')
    try {
      const res = await apiGet('/users/list')
      setUsers(res.data || [])
    } catch (e) { setError(e.message || 'Failed to load users') }
  }
  useEffect(() => { load() }, [])

  // Lazily fetch a user's broker accounts the first time their row is expanded.
  async function toggleExpand(user) {
    const id = user.id
    if (expanded === id) { setExpanded(null); return }
    setExpanded(id)
    if (!configsByUser[id]) {
      try {
        const res = await apiGet(`/users/broker-config/list?user_id=${encodeURIComponent(id)}`)
        setConfigsByUser((m) => ({ ...m, [id]: res.data || [] }))
      } catch (e) { setError(e.message) }
    }
  }

  const openCreate = () => { setEditingUser(null); setForm({ username: '', email: '', mobile: '' }); setOpenForm(true) }
  const openEdit = (u) => { setEditingUser(u); setForm({ username: u.username, email: u.email || '', mobile: u.mobile || '' }); setOpenForm(true) }

  async function saveUser() {
    if (!form.username.trim()) { setError('Username required'); return }
    setSaving(true)
    const prev = users
    // Optimistic: reflect the change in the table immediately.
    if (editingUser) {
      setUsers((cur) => cur.map((u) => (u.id === editingUser.id
        ? { ...u, id: form.username, username: form.username, email: form.email, mobile: form.mobile }
        : u)))
    } else {
      setUsers((cur) => [...cur, { id: form.username, username: form.username, email: form.email, mobile: form.mobile, brokers: 0 }])
    }
    setOpenForm(false)
    try {
      if (editingUser) { await apiPost('/users/update', { id: editingUser.id, username: form.username, email: form.email, mobile: form.mobile }); setToast('User updated') }
      else { await apiPost('/users/create', { username: form.username, email: form.email, mobile: form.mobile }); setToast('User created — add a broker under the gear icon') }
    } catch (e) { setError(e.message); setUsers(prev) /* revert */ }
    finally { setSaving(false) }
  }

  async function deleteUser(u) {
    if (!window.confirm(`Delete user "${u.username}" and all its broker accounts?`)) return
    const prev = users
    setUsers((cur) => cur.filter((x) => x.id !== u.id)) // optimistic remove
    try { await apiPost('/users/delete', { id: u.id }); setToast('User deleted') }
    catch (e) { setError(e.message); setUsers(prev) }
  }

  // Refresh a single user's broker list + count after the config dialog changes.
  // Single fetch; the count is derived from the fetched list (no second /list call).
  async function refreshUserConfigs(userId) {
    try {
      const res = await apiGet(`/users/broker-config/list?user_id=${encodeURIComponent(userId)}`)
      const list = res.data || []
      setConfigsByUser((m) => ({ ...m, [userId]: list }))
      setUsers((cur) => cur.map((u) => (u.id === userId ? { ...u, brokers: list.length } : u)))
    } catch { /* ignore */ }
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Box>
          <Typography variant="h5">Users</Typography>
          <Typography color="text.secondary" fontSize="0.875rem">
            Each user can hold multiple broker accounts. Click a row to see the brokers it's connected to.
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<Plus size={16} />} onClick={openCreate}>Add User</Button>
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

      <Paper sx={{ p: 0, overflow: 'hidden' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: 40 }} />
              <TableCell>Username</TableCell>
              <TableCell>Email</TableCell>
              <TableCell>Mobile</TableCell>
              <TableCell align="center">Brokers</TableCell>
              <TableCell align="center">Broker Config</TableCell>
              <TableCell align="center">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {users.length === 0 && (
              <TableRow><TableCell colSpan={7} align="center" sx={{ py: 4, color: 'text.secondary' }}>No users yet</TableCell></TableRow>
            )}
            {users.map((u) => {
              const isOpen = expanded === u.id
              const configs = configsByUser[u.id]
              return (
                <Fragment key={u.id}>
                  <TableRow hover sx={{ cursor: 'pointer' }} onClick={() => toggleExpand(u)}>
                    <TableCell>
                      <IconButton size="small">{isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</IconButton>
                    </TableCell>
                    <TableCell>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <UserIcon size={15} color="var(--ao-caption)" />
                        <Typography sx={{ fontWeight: 600, fontSize: '0.85rem' }}>{u.username}</Typography>
                      </Box>
                    </TableCell>
                    <TableCell>{u.email || <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>}</TableCell>
                    <TableCell>{u.mobile || <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>}</TableCell>
                    <TableCell align="center">
                      <Chip size="small" label={u.brokers ?? 0} color={u.brokers ? 'primary' : 'default'} variant="outlined" />
                    </TableCell>
                    <TableCell align="center" onClick={(e) => e.stopPropagation()}>
                      <Tooltip title="Broker Configuration">
                        <IconButton size="small" onClick={() => setBrokerUser(u)}><Settings size={15} /></IconButton>
                      </Tooltip>
                    </TableCell>
                    <TableCell align="center" onClick={(e) => e.stopPropagation()}>
                      <IconButton size="small" onClick={() => openEdit(u)}><Pencil size={15} /></IconButton>
                      <IconButton size="small" onClick={() => deleteUser(u)}><Trash2 size={15} /></IconButton>
                    </TableCell>
                  </TableRow>

                  {/* Expanded: the broker accounts this user is connected to */}
                  <TableRow>
                    <TableCell colSpan={7} sx={{ p: 0, border: 0 }}>
                      <Collapse in={isOpen} timeout="auto" unmountOnExit>
                        <Box sx={{ p: 2, bgcolor: 'var(--ao-surface-2)' }}>
                          <Box sx={{ display: 'flex', gap: 3, mb: 1.5, color: 'text.secondary', fontSize: '0.8rem' }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}><Mail size={13} /> {u.email || '—'}</Box>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}><Phone size={13} /> {u.mobile || '—'}</Box>
                          </Box>
                          <Typography sx={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: 'text.secondary', mb: 1 }}>
                            Connected Brokers
                          </Typography>
                          {!configs && <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem' }}>Loading…</Typography>}
                          {configs && configs.length === 0 && (
                            <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem' }}>
                              No broker accounts. Use the gear icon to add one.
                            </Typography>
                          )}
                          {configs && configs.length > 0 && (
                            <Table size="small" sx={{ bgcolor: 'background.paper', borderRadius: 1 }}>
                              <TableHead>
                                <TableRow>
                                  <TableCell>Broker</TableCell>
                                  <TableCell>Account ID</TableCell>
                                  <TableCell>Phone</TableCell>
                                  <TableCell align="center">TOTP</TableCell>
                                  <TableCell align="center">Auto Login</TableCell>
                                  <TableCell align="center">Enabled</TableCell>
                                </TableRow>
                              </TableHead>
                              <TableBody>
                                {configs.map((c) => (
                                  <TableRow key={c.id}>
                                    <TableCell><Chip size="small" variant="outlined" color="primary" label={brokerLabel(c.broker_name)} /></TableCell>
                                    <TableCell>{c.account_id || '—'}</TableCell>
                                    <TableCell>{c.phone || '—'}</TableCell>
                                    <TableCell align="center">{c.totp_secret ? <Chip size="small" color="success" label="Set" /> : <Chip size="small" label="—" />}</TableCell>
                                    <TableCell align="center">{c.auto_login ? '✓' : '—'}</TableCell>
                                    <TableCell align="center">{c.enabled ? '✓' : '—'}</TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          )}
                        </Box>
                      </Collapse>
                    </TableCell>
                  </TableRow>
                </Fragment>
              )
            })}
          </TableBody>
        </Table>
      </Paper>

      {/* Create / edit user */}
      <Dialog open={openForm} onClose={() => setOpenForm(false)} fullWidth maxWidth="sm">
        <DialogTitle>{editingUser ? 'Edit User' : 'Add User'}</DialogTitle>
        <DialogContent sx={{ display: 'grid', gap: 2.5, pt: '20px !important' }}>
          <TextField label="Username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} fullWidth />
          <TextField label="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} fullWidth />
          <TextField label="Mobile" value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} fullWidth />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpenForm(false)}>Cancel</Button>
          <Button variant="contained" onClick={saveUser} disabled={saving}
            startIcon={saving ? <CircularProgress size={14} color="inherit" /> : null}>
            {saving ? 'Saving…' : (editingUser ? 'Save' : 'Create')}
          </Button>
        </DialogActions>
      </Dialog>

      <BrokerConfigDialog
        key={brokerUser?.id || 'broker-config'}
        open={!!brokerUser}
        user={brokerUser}
        onClose={() => setBrokerUser(null)}
        onChanged={() => brokerUser && refreshUserConfigs(brokerUser.id)}
        onToast={setToast}
      />

      <Snackbar open={!!toast} autoHideDuration={3000} onClose={() => setToast('')} anchorOrigin={{ vertical: 'top', horizontal: 'right' }}>
        <Alert severity="success" variant="filled" onClose={() => setToast('')}>{toast}</Alert>
      </Snackbar>
    </Box>
  )
}
