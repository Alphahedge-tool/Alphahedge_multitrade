import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Info, RefreshCw } from 'lucide-react'
import { apiGet } from '../config/api'
import { buildClient, getSavedSession, isAngelBroker, saveSession } from '../feedmaster/feedMasterStore'
import { compactProductTag, parseTradingSymbol } from './symbolParse'
import { CompactSelect } from './PositionSelect'
import './tradepanel.css'

const ORDER_COLUMNS = ['stock', 'product', 'qty', 'price', 'trigger', 'status', 'time']

function money(value) {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n === 0) return '-'
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function valueOf(row, keys, fallback = '') {
  for (const key of keys) {
    const value = row?.[key]
    if (value != null && value !== '') return value
  }
  return fallback
}

export default function GetOrderBook() {
  const [users, setUsers] = useState([])
  const [userId, setUserId] = useState('')
  const [configs, setConfigs] = useState([])
  const [configId, setConfigId] = useState('')
  const [client, setClient] = useState(null)
  const [rows, setRows] = useState([])
  const [status, setStatus] = useState('Select a user and account')
  const [loading, setLoading] = useState(false)
  const [configLoading, setConfigLoading] = useState(false)
  const autoLoadedAccountRef = useRef('')

  const selectedConfig = configs.find((config) => String(config.id) === String(configId))
  const selectedBrokerName = selectedConfig?.broker_name || ''
  const selectedIsAngel = isAngelBroker(selectedBrokerName)

  useEffect(() => {
    let cancelled = false

    async function loadUsers() {
      try {
        const res = await apiGet('/users/list')
        if (cancelled) return
        const list = res.data || []
        setUsers(list)
        if (list[0]?.id) {
          setUserId(String(list[0].id))
          setStatus(`Select account for ${list[0].username || 'user'}`)
        } else {
          setStatus('No users available')
        }
      } catch {
        if (!cancelled) setStatus('Failed to load users')
      }
    }

    loadUsers()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadConfigs() {
      if (!userId) {
        setConfigs([])
        setConfigId('')
        setClient(null)
        return
      }

      setConfigLoading(true)
      setRows([])
      setClient(null)
      try {
        const res = await apiGet(`/users/broker-config/list?user_id=${userId}`)
        if (cancelled) return
        const list = res.data || []
        setConfigs(list)
        setConfigId(String(list[0]?.id || ''))
        setStatus(list.length ? 'Select account, then Get Orderbook' : 'No broker accounts configured for this user')
      } catch {
        if (!cancelled) setStatus('Failed to load broker accounts')
      } finally {
        if (!cancelled) setConfigLoading(false)
      }
    }

    loadConfigs()
    return () => { cancelled = true }
  }, [userId])

  useEffect(() => {
    let cancelled = false

    async function hydrateConfig() {
      setRows([])
      setClient(null)
      if (!configId) return

      if (!selectedIsAngel) {
        setStatus(`${selectedBrokerName || 'Selected broker'} orderbook is not wired yet`)
        return
      }

      setStatus('Loading account credentials...')
      try {
        const res = await apiGet(`/users/broker-config/get?id=${configId}`)
        if (cancelled) return
        const config = res.data || {}
        const nextClient = buildClient(config, getSavedSession(configId))
        if (!nextClient?.clientCode || !nextClient?.apiKey || !nextClient?.pin || !nextClient?.totpSecret) {
          setStatus('This Angel account is missing Client Code / PIN / TOTP / API Key')
          return
        }
        setClient(nextClient)
        setStatus(nextClient.session?.jwtToken ? '' : 'This account is not logged in. Login from Broker Configuration first.')
      } catch {
        if (!cancelled) setStatus('Failed to load account credentials')
      }
    }

    hydrateConfig()
    return () => { cancelled = true }
  }, [configId, selectedBrokerName, selectedIsAngel])

  useEffect(() => {
    autoLoadedAccountRef.current = ''
  }, [configId])

  const load = useCallback(async () => {
    if (!selectedConfig) {
      setStatus('Select an account first')
      return
    }
    if (!selectedIsAngel) {
      setStatus(`${selectedBrokerName || 'Selected broker'} orderbook is not wired yet`)
      return
    }
    if (!client) {
      setStatus('Angel account credentials are not ready')
      return
    }
    if (!client.session?.jwtToken) {
      setStatus('This account is not logged in. Login from Broker Configuration first.')
      return
    }

    setLoading(true)
    setStatus('Loading orderbook...')
    try {
      const res = await fetch('/api/angel/order-book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.status === false) throw new Error(body.message || `HTTP ${res.status}`)
      if (body.session?.jwtToken) {
        saveSession(configId, body.session)
        setClient((current) => (current ? { ...current, session: body.session, loggedIn: true } : current))
      }
      const orders = body.orders || []
      setRows(orders)
      setStatus(orders.length ? `${orders.length} orders` : 'No orders found')
    } catch (error) {
      setStatus(toOrderError(error))
    } finally {
      setLoading(false)
    }
  }, [client, configId, selectedBrokerName, selectedConfig, selectedIsAngel])

  useEffect(() => {
    const accountKey = String(configId || '')
    if (!accountKey || !selectedConfig || !selectedIsAngel || !client?.session?.jwtToken || loading) return
    if (autoLoadedAccountRef.current === accountKey) return
    autoLoadedAccountRef.current = accountKey
    load()
  }, [client, configId, load, loading, selectedConfig, selectedIsAngel])

  const summary = useMemo(() => {
    const complete = rows.filter((row) => /complete|traded|executed/i.test(String(orderStatus(row)))).length
    const rejected = rows.filter((row) => /reject|cancel|fail/i.test(String(orderStatus(row)))).length
    return { complete, rejected, pending: Math.max(rows.length - complete - rejected, 0) }
  }, [rows])

  return (
    <div className="trade-panel">
      <div className="positions-view">
        <div className="positions-toolbar">
          <CompactSelect
            title="User"
            value={userId}
            onChange={setUserId}
            options={users.map((user) => ({
              value: String(user.id),
              label: user.username || `${user.first_name || ''} ${user.last_name || ''}`.trim() || `User ${user.id}`,
            }))}
          />

          <CompactSelect
            title="Account"
            value={configId}
            onChange={setConfigId}
            disabled={configLoading || !configs.length}
            options={configs.map((config) => ({
              value: String(config.id),
              label: config.account_id || `Account ${config.id}`,
              meta: config.broker_name || 'Broker',
            }))}
          />

          <button className="positions-load-btn" onClick={load} disabled={loading || !selectedConfig || (selectedIsAngel && !client)} type="button">
            {loading ? 'Loading' : 'Get Orderbook'}
          </button>
          {rows.length > 0 && <span className="positions-total up">{rows.length} Orders</span>}
          {status && <span className="positions-status">{status}</span>}
        </div>

        {rows.length > 0 && (
          <div className="position-book-summary">
            <div>
              <span className="buy">Complete</span>
              <strong>{summary.complete}</strong>
              <em>Executed orders</em>
            </div>
            <div>
              <span>Pending</span>
              <strong>{summary.pending}</strong>
              <em>Open or queued</em>
            </div>
            <div>
              <span className="sell">Rejected / Cancelled</span>
              <strong className={summary.rejected ? 'down' : ''}>{summary.rejected}</strong>
              <em>{rows.length} total orders</em>
            </div>
          </div>
        )}

        <div className="positions-table-wrap">
          <table className="positions-table position-book-table order-book-table">
            <thead>
              <tr>
                {ORDER_COLUMNS.map((column) => (
                  <th key={column} className={['qty', 'price', 'trigger'].includes(column) ? 'num' : ''}>
                    {orderLabel(column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={orderKey(row, index)} className={/sell/i.test(String(orderSide(row))) ? 'position-row-short' : ''}>
                  {ORDER_COLUMNS.map((column) => (
                    <td key={column} className={['qty', 'price', 'trigger'].includes(column) ? 'num' : ''}>
                      {renderOrderCell(row, column)}
                    </td>
                  ))}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td className="positions-empty" colSpan={ORDER_COLUMNS.length}>
                    <div className="positions-empty-state">
                      <button
                        className="positions-empty-action"
                        type="button"
                        onClick={load}
                        disabled={loading || !selectedConfig || (selectedIsAngel && !client)}
                      >
                        {loading ? <RefreshCw className="spin" size={18} /> : <Info size={18} />}
                      </button>
                      <strong>{loading ? 'Loading orderbook' : 'No orders'}</strong>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function orderLabel(column) {
  return {
    stock: 'Stock Name',
    product: 'Product Type',
    qty: 'Qty.',
    price: 'Price',
    trigger: 'Trigger',
    status: 'Status',
    time: 'Time',
  }[column] || column
}

function renderOrderCell(row, column) {
  if (column === 'stock') return <OrderStockCell row={row} />
  if (column === 'product') return <OrderProductCell row={row} />
  if (column === 'qty') return <OrderQtyCell row={row} />
  if (column === 'price') return <span className="position-price">{money(valueOf(row, ['price', 'orderprice']))}</span>
  if (column === 'trigger') return <span className="position-price-muted">{money(valueOf(row, ['triggerprice', 'trigger_price']))}</span>
  if (column === 'status') return <OrderStatusCell row={row} />
  if (column === 'time') return <span className="position-price-muted">{valueOf(row, ['updatetime', 'exchtime', 'orderentrytime', 'time'], '-')}</span>
  return '-'
}

function OrderStockCell({ row }) {
  const symbol = String(valueOf(row, ['tradingsymbol', 'symbolname', 'symbol'], '-'))
  const parsed = parseTradingSymbol(symbol)
  return (
    <div className="position-symbol-line" title={symbol}>
      <strong>{parsed.root}</strong>
      {parsed.expiry && <span className="position-expiry">{parsed.expiry}</span>}
      {parsed.strike && <span className="position-strike">{parsed.strike}</span>}
      {parsed.optionType && <span className={`book-tag option ${parsed.optionType.toLowerCase()}`}>{parsed.optionType}</span>}
      {row.exchange && <span className="book-tag exchange">{row.exchange}</span>}
    </div>
  )
}

function OrderProductCell({ row }) {
  const side = String(orderSide(row)).toUpperCase()
  const product = compactProductTag(valueOf(row, ['producttype', 'product_type', 'product']))
  return (
    <div className="book-product-cell">
      {side && <span className={`book-tag side ${side === 'SELL' ? 'sell' : 'buy'}`}>{side}</span>}
      <span className="book-tag product">{product}</span>
    </div>
  )
}

function OrderQtyCell({ row }) {
  const qty = Number(valueOf(row, ['quantity', 'qty', 'filledshares', 'unfilledshares'], 0))
  return (
    <div className="book-qty-cell">
      <span>{Number.isFinite(qty) ? qty.toLocaleString('en-IN') : '-'}</span>
      <small>{valueOf(row, ['ordertype', 'order_type', 'variety'], '')}</small>
    </div>
  )
}

function OrderStatusCell({ row }) {
  const status = String(orderStatus(row) || '-')
  const failed = /reject|cancel|fail/i.test(status)
  const ok = /complete|traded|executed/i.test(status)
  return (
    <div className="book-status-cell">
      <span className={`book-status-main ${failed ? 'down' : ok ? 'up' : ''}`}>{status}</span>
      <small>{valueOf(row, ['orderid', 'uniqueorderid'], '')}</small>
    </div>
  )
}

function orderSide(row) {
  return valueOf(row, ['transactiontype', 'transaction_type', 'side', 'action'])
}

function orderStatus(row) {
  return valueOf(row, ['status', 'orderstatus', 'order_status', 'text'])
}

function orderKey(row, fallback) {
  return [
    valueOf(row, ['orderid', 'uniqueorderid'], ''),
    valueOf(row, ['tradingsymbol', 'symbolname', 'symbol'], ''),
    valueOf(row, ['updatetime', 'exchtime', 'orderentrytime'], ''),
    fallback,
  ].filter(Boolean).join('|')
}

function toOrderError(error) {
  const message = String(error?.message || '')
  if (/session|login|auth|token|jwt|unauthor/i.test(message)) {
    return 'This account is not logged in. Login from Broker Configuration first.'
  }
  return message || 'Failed to load orderbook'
}
