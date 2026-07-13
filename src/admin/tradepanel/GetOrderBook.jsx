import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Info, RefreshCw, Search } from 'lucide-react'
import { apiGet } from '../config/api'
import {
  buildClient, getSavedSession, isAngelBroker, isKotakBroker, isZerodhaBroker, saveSession,
} from '../feedmaster/feedMasterStore'
import { bookProductTag, parseTradingSymbol } from './symbolParse'
import { CompactSelect } from './PositionSelect'
import { useKotakPortfolioStream } from './useKotakPortfolioStream'
import './tradepanel.css'

function money(value) {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n === 0) return '-'
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Kite renders order prices as plain numbers, including 0.00 for market orders.
function orderMoney(value) {
  const n = Number(value || 0)
  if (!Number.isFinite(n)) return '0.00'
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function valueOf(row, keys, fallback = '') {
  for (const key of keys) {
    const value = row?.[key]
    if (value != null && value !== '') return value
  }
  return fallback
}

function sessionReady(client, broker) {
  if (broker === 'kotak') return Boolean(client?.session?.tradeToken && client.session.sid && client.session.baseUrl)
  if (broker === 'zerodha') return Boolean(client?.session?.accessToken)
  return Boolean(client?.session?.jwtToken)
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
  const [streamStatus, setStreamStatus] = useState('')
  const [query, setQuery] = useState('')
  const autoLoadedAccountRef = useRef('')
  const loadRef = useRef(null)
  const refreshTimerRef = useRef(0)

  const selectedConfig = configs.find((config) => String(config.id) === String(configId))
  const selectedBrokerName = selectedConfig?.broker_name || ''
  const selectedIsAngel = isAngelBroker(selectedBrokerName)
  const selectedIsZerodha = isZerodhaBroker(selectedBrokerName)
  const selectedIsKotak = isKotakBroker(selectedBrokerName)
  const selectedBroker = selectedIsKotak ? 'kotak' : selectedIsZerodha ? 'zerodha' : 'angel'
  const selectedIsSupported = selectedIsAngel || selectedIsZerodha || selectedIsKotak

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

      if (!selectedIsSupported) {
        setStatus(`${selectedBrokerName || 'Selected broker'} orderbook is not wired yet`)
        return
      }

      setStatus('Loading account credentials...')
      try {
        const res = await apiGet(`/users/broker-config/get?id=${configId}`)
        if (cancelled) return
        const config = res.data || {}
        const nextClient = buildClient(config, getSavedSession(configId))
        if (selectedIsAngel && (!nextClient?.clientCode || !nextClient?.apiKey || !nextClient?.pin || !nextClient?.totpSecret)) {
          setStatus('This Angel account is missing Client Code / PIN / TOTP / API Key')
          return
        }
        if (selectedIsZerodha && (!nextClient?.apiKey || !nextClient?.apiSecret)) {
          setStatus('This Zerodha account is missing API Key / API Secret')
          return
        }
        if (selectedIsKotak && (!nextClient?.clientCode || !nextClient?.accessToken)) {
          setStatus('This Kotak account is missing UCC / Access Token')
          return
        }
        setClient(nextClient)
        const loggedIn = sessionReady(nextClient, selectedBroker)
        setStatus(loggedIn ? '' : 'This account is not logged in. Login from Broker Configuration first.')
      } catch {
        if (!cancelled) setStatus('Failed to load account credentials')
      }
    }

    hydrateConfig()
    return () => { cancelled = true }
  }, [configId, selectedBroker, selectedBrokerName, selectedIsAngel, selectedIsKotak, selectedIsSupported, selectedIsZerodha])

  useEffect(() => {
    autoLoadedAccountRef.current = ''
  }, [configId])

  const load = useCallback(async (options) => {
    const silent = options?.silent === true
    if (!selectedConfig) {
      setStatus('Select an account first')
      return
    }
    if (!selectedIsSupported) {
      setStatus(`${selectedBrokerName || 'Selected broker'} orderbook is not wired yet`)
      return
    }
    if (!client) {
      setStatus(`${selectedBrokerName || 'Broker'} account credentials are not ready`)
      return
    }
    const loggedIn = sessionReady(client, selectedBroker)
    if (!loggedIn) {
      setStatus('This account is not logged in. Login from Broker Configuration first.')
      return
    }

    if (!silent) {
      setLoading(true)
      setStatus('Loading orderbook...')
    }
    try {
      const res = await fetch(`/api/${selectedBroker}/order-book`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.status === false) throw new Error(body.message || `HTTP ${res.status}`)
      if (body.session?.jwtToken || body.session?.accessToken || body.session?.tradeToken) {
        saveSession(configId, body.session)
        setClient((current) => (current ? { ...current, session: body.session, loggedIn: true } : current))
      }
      const orders = body.orders || []
      setRows(orders)
      if (!silent) setStatus(orders.length ? `${orders.length} orders` : 'No orders found')
    } catch (error) {
      if (!silent) setStatus(toOrderError(error))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [client, configId, selectedBroker, selectedBrokerName, selectedConfig, selectedIsSupported])

  useEffect(() => { loadRef.current = load }, [load])

  useEffect(() => {
    const accountKey = String(configId || '')
    const loggedIn = sessionReady(client, selectedBroker)
    if (!accountKey || !selectedConfig || !selectedIsSupported || !loggedIn || loading) return
    if (autoLoadedAccountRef.current === accountKey) return
    autoLoadedAccountRef.current = accountKey
    load()
  }, [client, configId, load, loading, selectedBroker, selectedConfig, selectedIsSupported])

  useEffect(() => {
    if (!selectedIsZerodha || !client?.session?.accessToken) {
      setStreamStatus('')
      return undefined
    }
    const userIdForStream = client.session.userId || client.userId || client.clientCode
    if (!userIdForStream) {
      setStreamStatus('')
      return undefined
    }

    let closed = false
    const stream = new EventSource(`/api/zerodha/order-stream?userId=${encodeURIComponent(userIdForStream)}`)
    setStreamStatus('Live order stream connecting')

    const handleOrders = (event) => {
      if (closed) return
      try {
        const body = JSON.parse(event.data || '{}')
        const orders = body.orders || []
        setRows(orders)
        setStatus(orders.length ? `${orders.length} orders` : 'No orders found')
        setStreamStatus(body.cached ? 'Live order stream cached' : 'Live order stream active')
      } catch {
        setStreamStatus('Live order stream parse failed')
      }
    }

    const handleStatus = (event) => {
      if (closed) return
      try {
        const body = JSON.parse(event.data || '{}')
        setStreamStatus(body.message || 'Live order stream active')
      } catch {
        setStreamStatus('Live order stream active')
      }
    }

    const handleErrorEvent = (event) => {
      if (closed) return
      try {
        const body = JSON.parse(event.data || '{}')
        setStreamStatus(body.message || 'Live order stream error')
      } catch {
        setStreamStatus('Live order stream error')
      }
    }

    stream.addEventListener('orders', handleOrders)
    stream.addEventListener('status', handleStatus)
    stream.addEventListener('rate-limit', handleErrorEvent)
    stream.addEventListener('error', handleErrorEvent)
    stream.onerror = () => {
      if (!closed) setStreamStatus('Live order stream reconnecting')
    }

    return () => {
      closed = true
      stream.close()
    }
  }, [client?.clientCode, client?.session?.accessToken, client?.session?.userId, selectedIsZerodha])

  const scheduleOrderRefresh = useCallback(() => {
    window.clearTimeout(refreshTimerRef.current)
    refreshTimerRef.current = window.setTimeout(() => loadRef.current?.({ silent: true }), 900)
  }, [])
  useEffect(() => () => window.clearTimeout(refreshTimerRef.current), [])
  const kotakStreamStatus = useKotakPortfolioStream({
    enabled: selectedIsKotak,
    client,
    onOrder: useCallback((order) => {
      const orderId = String(order?.orderid || order?.nOrdNo || '')
      if (!orderId) return
      setRows((current) => {
        const index = current.findIndex((row) => String(row.orderid || row.nOrdNo || '') === orderId)
        if (index < 0) return [order, ...current]
        return current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...order } : row))
      })
      scheduleOrderRefresh()
    }, [scheduleOrderRefresh]),
    onPosition: scheduleOrderRefresh,
    onResync: useCallback(() => loadRef.current?.({ silent: true }), []),
  })
  const liveStreamStatus = selectedIsKotak
    ? `Kotak portfolio stream ${kotakStreamStatus === 'live' ? 'active' : kotakStreamStatus}`
    : streamStatus

  const summary = useMemo(() => {
    let complete = 0
    let rejected = 0
    let open = 0
    for (const row of rows) {
      const kind = orderStatusMeta(row).kind
      if (kind === 'complete') complete += 1
      else if (kind === 'rejected' || kind === 'cancelled') rejected += 1
      else open += 1
    }
    return { complete, rejected, open }
  }, [rows])

  const visibleRows = useMemo(() => {
    const q = query.trim().toUpperCase()
    if (!q) return rows
    return rows.filter((row) => [
      valueOf(row, ['tradingsymbol', 'symbolname', 'symbol'], ''),
      orderStatus(row),
      orderSide(row),
      valueOf(row, ['producttype', 'product_type', 'product'], ''),
      valueOf(row, ['ordertype', 'order_type', 'variety'], ''),
      valueOf(row, ['orderid', 'uniqueorderid'], ''),
    ].join(' ').toUpperCase().includes(q))
  }, [query, rows])

  const grouped = useMemo(() => {
    const open = []
    const executed = []
    for (const row of visibleRows) {
      (orderStatusMeta(row).open ? open : executed).push(row)
    }
    return { open, executed }
  }, [visibleRows])

  return (
    <div className="trade-panel">
      <div className="positions-view positions-book-view order-book-view">
        <div className="positions-book-header order-book-header">
          <div className="positions-book-title">
            <strong>Orders{rows.length ? ` (${rows.length})` : ''}</strong>
            <span>{selectedBrokerName || 'Broker'} orderbook — status, price and execution time</span>
          </div>
          <div className="positions-book-actions order-book-actions">
            <label className="positions-book-search">
              <Search size={14} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search orders"
              />
            </label>
            <div className="order-book-step-tags" aria-label="Order status summary">
              <span className="order-book-step-tag pending">Open {summary.open}</span>
              <span className="order-book-step-tag done">Complete {summary.complete}</span>
              <span className="order-book-step-tag failed">Rejected {summary.rejected}</span>
            </div>
          </div>
        </div>

        <div className="positions-toolbar positions-book-accountbar order-book-toolbar">
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

          <button className="positions-load-btn" onClick={load} disabled={loading || !selectedConfig || (selectedIsSupported && !client)} type="button">
            {loading ? 'Loading' : 'Get Orderbook'}
          </button>
          {rows.length > 0 && <span className="positions-total order-book-count">{rows.length} Orders</span>}
          {status && <span className="positions-status order-book-status">{status}</span>}
          {liveStreamStatus && <span className="positions-status order-book-status live">{liveStreamStatus}</span>}
        </div>

        <div className="positions-table-wrap positions-book-table-wrap order-book-table-wrap">
          {visibleRows.length > 0 ? (
            <>
              {grouped.open.length > 0 && <OrderSection title="Open orders" orders={grouped.open} />}
              {grouped.executed.length > 0 && <OrderSection title="Executed orders" orders={grouped.executed} />}
            </>
          ) : (
            <div className="positions-empty order-book-empty">
              <div className="positions-empty-state">
                <button
                  className="positions-empty-action"
                  type="button"
                  onClick={load}
                  disabled={loading || !selectedConfig || (selectedIsSupported && !client)}
                >
                  {loading ? <RefreshCw className="spin" size={18} /> : <Info size={18} />}
                </button>
                <strong>{loading ? 'Loading orderbook' : rows.length ? 'No orders match your search' : 'No orders'}</strong>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function OrderSection({ title, orders }) {
  return (
    <section className="order-kite-section" aria-label={title}>
      <header className="order-kite-section-head">
        <h2>{title} <span>({orders.length})</span></h2>
      </header>
      <table className="order-kite-table">
        <thead>
          <tr>
            <th className="col-time">Time</th>
            <th className="col-type">Type</th>
            <th className="col-instrument">Instrument</th>
            <th className="col-product">Product</th>
            <th className="num col-qty">Qty.</th>
            <th className="num col-price">Price / Trigger</th>
            <th className="num col-avg">Avg. price</th>
            <th className="col-status">Status</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((row, index) => (
            <OrderRow row={row} key={orderKey(row, index)} />
          ))}
        </tbody>
      </table>
    </section>
  )
}

function OrderRow({ row }) {
  const sideRaw = String(orderSide(row) || '').toUpperCase()
  const sideKind = sideRaw === 'SELL' ? 'sell' : 'buy'
  const statusMeta = orderStatusMeta(row)
  const product = bookProductTag(valueOf(row, ['producttype', 'product_type', 'product']))
  const orderType = orderTypeMeta(valueOf(row, ['ordertype', 'order_type'], ''))
  const filled = Number(valueOf(row, ['filledshares', 'filled_quantity'], 0)) || 0
  const qty = Number(valueOf(row, ['quantity', 'qty'], 0)) || 0
  const price = Number(valueOf(row, ['price', 'orderprice'], 0)) || 0
  const trigger = Number(valueOf(row, ['triggerprice', 'trigger_price'], 0)) || 0
  const avg = Number(valueOf(row, ['averageprice', 'average_price'], 0)) || 0
  const reason = String(valueOf(row, ['text', 'status_message', 'statusmessage'], '')).trim()
  const time = orderTimeParts(row)
  const orderId = valueOf(row, ['orderid', 'uniqueorderid'], '')

  return (
    <tr className={`order-kite-row ${statusMeta.kind}`}>
      <td className="col-time" title={[time.full, orderId && `Order ${orderId}`].filter(Boolean).join(' — ')}>
        {time.clock}
      </td>
      <td className="col-type">
        <span className={`order-kite-side ${sideKind}`}>{sideRaw || 'BUY'}</span>
      </td>
      <td className="col-instrument"><OrderInstrumentCell row={row} /></td>
      <td className="col-product">
        <div className="order-kite-product-cell">
          <span className="book-tag product">{product}</span>
          {orderType.label && <span className={`order-kite-variety ${orderType.kind}`}>{orderType.label}</span>}
        </div>
      </td>
      <td className="num col-qty">
        <span className="order-kite-qty"><em>{filled.toLocaleString('en-IN')}</em> / {qty.toLocaleString('en-IN')}</span>
      </td>
      <td className="num col-price">
        <span className="order-kite-price">
          {orderMoney(price)}
          {trigger > 0 && <small> / {orderMoney(trigger)} trg.</small>}
        </span>
      </td>
      <td className="num col-avg">
        {avg > 0 ? <span className="order-kite-price">{money(avg)}</span> : <span className="position-price-muted">-</span>}
      </td>
      <td className="col-status">
        <span className={`order-kite-status ${statusMeta.kind}`} title={reason || statusMeta.label}>
          {statusMeta.label}
          {reason && <Info size={12} />}
        </span>
      </td>
    </tr>
  )
}

// Kite-style instrument line: "SENSEX 9th JUL 74100 PE" with the expiry-day
// ordinal superscripted and the exchange as a small muted suffix.
function OrderInstrumentCell({ row }) {
  const symbol = String(valueOf(row, ['tradingsymbol', 'symbolname', 'symbol'], '-'))
  const parsed = parseTradingSymbol(symbol)
  const expiry = splitExpiryDay(parsed.expiry)
  return (
    <div className="position-symbol-line" title={symbol}>
      <span className="position-symbol-name">
        {parsed.root || symbol}
        {expiry
          ? <> {expiry.day}<sup>{expiry.suffix}</sup> {expiry.month}</>
          : (parsed.expiry ? ` ${parsed.expiry}` : '')}
        {parsed.strike ? ` ${parsed.strike}` : ''}
        {parsed.optionType ? ` ${parsed.optionType}` : ''}
      </span>
      {row.exchange && <span className="position-symbol-exchange">{row.exchange}</span>}
    </div>
  )
}

function splitExpiryDay(expiry) {
  const match = String(expiry || '').match(/^(\d{1,2})\s+([A-Za-z]{3})/)
  if (!match) return null
  const day = Number(match[1])
  return { day, suffix: ordinalSuffix(day), month: match[2].toUpperCase() }
}

function ordinalSuffix(day) {
  if (day % 100 >= 11 && day % 100 <= 13) return 'th'
  return { 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] || 'th'
}

function orderStatusMeta(row) {
  const upper = String(orderStatus(row) || '').trim().toUpperCase()
  if (/COMPLETE|TRADED|EXECUTED|FILLED/.test(upper)) return { label: upper || 'COMPLETE', kind: 'complete', open: false }
  if (/REJECT/.test(upper)) return { label: upper || 'REJECTED', kind: 'rejected', open: false }
  if (/CANCEL/.test(upper)) return { label: upper || 'CANCELLED', kind: 'cancelled', open: false }
  return { label: upper || 'PENDING', kind: 'open', open: true }
}

function orderTimeParts(row) {
  const full = String(valueOf(row, ['updatetime', 'exchtime', 'orderentrytime', 'order_timestamp', 'time'], '')).trim()
  const clock = full.match(/\d{1,2}:\d{2}(?::\d{2})?/)?.[0] || ''
  return { clock: clock || full || '-', full }
}

function orderSide(row) {
  return valueOf(row, ['transactiontype', 'transaction_type', 'side', 'action'])
}

function orderStatus(row) {
  return valueOf(row, ['status', 'orderstatus', 'order_status', 'text'])
}

function orderTypeMeta(value) {
  const raw = String(value || '').trim()
  const key = raw.toUpperCase().replace(/[\s-]+/g, '_')
  if (!key) return { label: '', kind: 'market' }
  if (key === 'MARKET' || key === 'MKT') return { label: 'MARKET', kind: 'market' }
  if (key === 'LIMIT' || key === 'LMT') return { label: 'LIMIT', kind: 'limit' }
  if (key === 'SL_M' || key === 'STOPLOSS_MARKET' || key === 'STOP_LOSS_MARKET') return { label: 'SL-M', kind: 'slm' }
  if (
    key === 'SL' ||
    key === 'STOPLOSS_LIMIT' ||
    key === 'STOP_LOSS_LIMIT' ||
    key === 'OPLOSS_LIMIT' ||
    key === 'STOPLOSS'
  ) {
    return { label: 'SL-LIMIT', kind: 'sllimit' }
  }
  return { label: raw.replace(/_/g, ' '), kind: 'custom' }
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
