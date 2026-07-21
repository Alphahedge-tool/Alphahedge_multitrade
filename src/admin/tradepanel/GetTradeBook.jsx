// Get TradeBook: today's executed fills for the selected user/account. Shares
// the same account-selection and auto-load scaffolding as GetOrderBook, but
// reads /api/{broker}/trade-book (returns `trades`) and renders fill-specific
// columns. Kotak refreshes live off the portfolio (HSI) stream; Angel/Zerodha
// load on demand and on account switch.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Info, RefreshCw, Search } from 'lucide-react'
import { apiGet } from '../config/api'
import {
  buildClient, getSavedSession, isAngelBroker, isKotakBroker, isZerodhaBroker, saveSession,
} from '../feedmaster/feedMasterStore'
import { bookProductTag, parseTradingSymbol } from './symbolParse'
import { CompactSelect } from './PositionSelect'
import { useKotakPortfolioStream } from './useKotakPortfolioStream'
import './tradepanel.css'

// Angel/Zerodha have no trade push, and a Kotak fill push can be missed, so a
// slow background re-read keeps the book fresh as a safety net.
const BACKGROUND_REFRESH_MS = 15000

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

function sessionReady(client, broker) {
  if (broker === 'kotak') return Boolean(client?.session?.tradeToken && client.session.sid && client.session.baseUrl)
  if (broker === 'zerodha') return Boolean(client?.session?.accessToken)
  return Boolean(client?.session?.jwtToken)
}

export default function GetTradeBook() {
  const [users, setUsers] = useState([])
  const [userId, setUserId] = useState('')
  const [configs, setConfigs] = useState([])
  const [configId, setConfigId] = useState('')
  const [client, setClient] = useState(null)
  const [rows, setRows] = useState([])
  const [status, setStatus] = useState('Select a user and account')
  const [loading, setLoading] = useState(false)
  const [configLoading, setConfigLoading] = useState(false)
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
        setStatus(list.length ? 'Select account, then Get TradeBook' : 'No broker accounts configured for this user')
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
        setStatus(`${selectedBrokerName || 'Selected broker'} trade book is not wired yet`)
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
      setStatus(`${selectedBrokerName || 'Selected broker'} trade book is not wired yet`)
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
      setStatus('Loading trade book...')
    }
    try {
      const res = await fetch(`/api/${selectedBroker}/trade-book`, {
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
      const trades = body.trades || []
      setRows(trades)
      if (!silent) setStatus(trades.length ? `${trades.length} trades for today` : 'No trades in trade book')
    } catch (error) {
      if (!silent) setStatus(toTradeError(error))
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

  // A fresh fill lands on the Kotak portfolio (HSI) stream as a completed order;
  // debounce a silent trade-book reload so the new trade shows without a manual
  // refresh. (Angel/Zerodha have no trade push, so they stay load-on-demand.)
  const scheduleTradeRefresh = useCallback(() => {
    window.clearTimeout(refreshTimerRef.current)
    refreshTimerRef.current = window.setTimeout(() => loadRef.current?.({ silent: true }), 900)
  }, [])
  useEffect(() => () => window.clearTimeout(refreshTimerRef.current), [])
  const kotakStreamStatus = useKotakPortfolioStream({
    enabled: selectedIsKotak,
    client,
    onOrder: useCallback((order) => {
      const statusText = String(order?.orderstatus || order?.status || '').toLowerCase()
      if (Number(order?.filledshares || 0) > 0 || statusText.includes('complete') || statusText.includes('traded')) {
        scheduleTradeRefresh()
      }
    }, [scheduleTradeRefresh]),
    onResync: useCallback(() => loadRef.current?.({ silent: true }), []),
  })
  const liveStreamStatus = selectedIsKotak
    ? `Kotak portfolio stream ${kotakStreamStatus === 'live' ? 'active' : kotakStreamStatus}`
    : ''

  // Last resort behind the Kotak fill push (and the only refresh Angel/Zerodha
  // get): a slow background re-read. Skipped while the tab is hidden.
  useEffect(() => {
    if (!configId || !selectedIsSupported) return undefined
    const timer = window.setInterval(() => {
      if (document.hidden) return
      loadRef.current?.({ silent: true })
    }, BACKGROUND_REFRESH_MS)
    const onVisible = () => {
      if (!document.hidden) loadRef.current?.({ silent: true })
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [configId, selectedIsSupported])

  const summary = useMemo(() => buildTradeSummary(rows), [rows])

  const visibleRows = useMemo(() => {
    const q = query.trim().toUpperCase()
    if (!q) return rows
    return rows.filter((row) => [
      valueOf(row, ['tradingsymbol', 'symbolname', 'symbol'], ''),
      tradeSide(row),
      valueOf(row, ['producttype', 'product_type', 'product'], ''),
      valueOf(row, ['orderid', 'uniqueorderid'], ''),
      valueOf(row, ['fillid', 'tradeid', 'trade_id'], ''),
      row.exchange || '',
    ].join(' ').toUpperCase().includes(q))
  }, [query, rows])

  const sortedRows = useMemo(
    () => [...visibleRows].sort((a, b) => String(tradeTime(b)).localeCompare(String(tradeTime(a)))),
    [visibleRows],
  )
  const tradeGroups = useMemo(() => groupTradesByExpiry(sortedRows), [sortedRows])

  return (
    <div className="trade-panel">
      <div className="positions-view positions-book-view order-book-view">
        <div className="positions-book-header order-book-header">
          <div className="positions-book-title">
            <strong>Trades{rows.length ? ` (${rows.length})` : ''}</strong>
            <span>{selectedBrokerName || 'Broker'} trade book — today&apos;s executed fills</span>
          </div>
          <div className="positions-book-actions order-book-actions">
            <label className="positions-book-search">
              <Search size={14} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search trades"
              />
            </label>
            <div className="order-book-step-tags" aria-label="Trade summary">
              <span className="order-book-step-tag done">Buy {summary.buy}</span>
              <span className="order-book-step-tag failed">Sell {summary.sell}</span>
              <span className="order-book-step-tag pending">Turnover {money(summary.turnover)}</span>
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
            {loading ? 'Loading' : 'Get TradeBook'}
          </button>
          <button
            className="orderbook-refresh-chip"
            type="button"
            title="Refresh trade book"
            onClick={() => load()}
            disabled={loading || !selectedConfig || (selectedIsSupported && !client)}
          >
            <RefreshCw className={loading ? 'spin' : ''} size={13} /> Refresh
          </button>
          {rows.length > 0 && <span className="positions-total order-book-count">{rows.length} Trades</span>}
          {status && <span className="positions-status order-book-status">{status}</span>}
          {liveStreamStatus && <span className="positions-status order-book-status live">{liveStreamStatus}</span>}
        </div>

        <div className="positions-table-wrap positions-book-table-wrap order-book-table-wrap">
          {sortedRows.length > 0 ? (
            tradeGroups.map((group) => (
              <TradeSection key={group.label} group={group} />
            ))
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
                <strong>{loading ? 'Loading trade book' : rows.length ? 'No trades match your search' : 'No trades'}</strong>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function TradeSection({ group }) {
  const [collapsed, setCollapsed] = useState(false)
  const trades = group.rows
  return (
    <section className={`order-kite-section${collapsed ? ' collapsed' : ''}`} aria-label={`Trades ${group.label}`}>
      <header className="order-kite-section-head">
        <button
          type="button"
          className="order-kite-section-toggle"
          onClick={() => setCollapsed((current) => !current)}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand group' : 'Collapse group'}
        >
          <ChevronDown size={15} className="order-kite-section-caret" aria-hidden="true" />
          <h2>
            {group.label} <span>({trades.length})</span>
          </h2>
        </button>
        <span className="order-kite-section-meta">
          Buy {group.buy} · Sell {group.sell} · Turnover {money(group.turnover)}
        </span>
      </header>
      {collapsed ? null : (
      <table className="order-kite-table">
        <thead>
          <tr>
            <th className="col-time">Fill time</th>
            <th className="col-type">Type</th>
            <th className="col-instrument">Instrument</th>
            <th className="col-product">Product</th>
            <th className="num col-qty">Qty.</th>
            <th className="num col-price">Fill price</th>
            <th className="num col-avg">Value</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((row, index) => (
            <TradeRow row={row} key={tradeRowKey(row, index)} />
          ))}
        </tbody>
      </table>
      )}
    </section>
  )
}

function groupTradesByExpiry(rows) {
  const groups = new Map()
  for (const row of rows) {
    const symbol = String(valueOf(row, ['tradingsymbol', 'symbolname', 'symbol'], '-'))
    const label = parseTradingSymbol(symbol).expiry || 'No Expiry'
    const group = groups.get(label) || { label, rows: [], buy: 0, sell: 0, turnover: 0 }
    group.rows.push(row)
    group.turnover += tradeValue(row)
    if (tradeSide(row) === 'SELL') group.sell += 1
    else group.buy += 1
    groups.set(label, group)
  }
  return [...groups.values()]
}

function TradeRow({ row }) {
  const side = tradeSide(row)
  const sideKind = side === 'SELL' ? 'sell' : 'buy'
  const product = bookProductTag(valueOf(row, ['producttype', 'product_type', 'product']))
  const qty = tradeQty(row)
  const lot = Number(valueOf(row, ['marketlot', 'lotsize', 'lot_size'], 0)) || 0
  const price = tradePrice(row)
  const value = tradeValue(row)
  const time = tradeTimeParts(row)
  const orderId = valueOf(row, ['orderid', 'uniqueorderid'], '')
  const fillId = valueOf(row, ['fillid', 'tradeid', 'trade_id'], '')

  return (
    <tr className={`order-kite-row ${sideKind}`}>
      <td className="col-time" title={[time.full, fillId && `Fill ${fillId}`, orderId && `Order ${orderId}`].filter(Boolean).join(' — ')}>
        {time.clock}
      </td>
      <td className="col-type">
        <span className={`order-kite-side ${sideKind}`}>{side}</span>
      </td>
      <td className="col-instrument"><TradeInstrumentCell row={row} /></td>
      <td className="col-product">
        <div className="order-kite-product-cell">
          <span className="book-tag product">{product}</span>
        </div>
      </td>
      <td className="num col-qty">
        <span className="order-kite-qty">
          {qty.toLocaleString('en-IN')}
          {lot > 1 && <small> / {lot} lot</small>}
        </span>
      </td>
      <td className="num col-price">
        <span className="order-kite-price">{money(price)}</span>
      </td>
      <td className="num col-avg">
        {value > 0 ? <span className="order-kite-price">{money(value)}</span> : <span className="position-price-muted">-</span>}
      </td>
    </tr>
  )
}

// Kite-style instrument line: "SENSEX 9th JUL 74100 PE" with the expiry-day
// ordinal superscripted and the exchange as a small muted suffix.
function TradeInstrumentCell({ row }) {
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

function tradeSide(row) {
  return String(valueOf(row, ['transactiontype', 'transaction_type', 'side', 'action'], '')).toUpperCase() === 'SELL'
    ? 'SELL'
    : 'BUY'
}

function tradeQty(row) {
  return Number(valueOf(row, ['fillsize', 'fillSize', 'quantity', 'qty', 'filled_quantity'], 0)) || 0
}

function tradePrice(row) {
  return Number(valueOf(row, ['fillprice', 'fillPrice', 'average_price', 'averageprice', 'price'], 0)) || 0
}

function tradeValue(row) {
  const direct = Number(valueOf(row, ['tradevalue', 'trade_value'], 0))
  if (Number.isFinite(direct) && direct > 0) return direct
  return tradePrice(row) * tradeQty(row)
}

function tradeTime(row) {
  return valueOf(row, ['filltime', 'fill_timestamp', 'exchange_timestamp', 'updatetime', 'exchtime', 'time'], '')
}

function tradeTimeParts(row) {
  const full = String(tradeTime(row)).trim()
  const clock = full.match(/\d{1,2}:\d{2}(?::\d{2})?/)?.[0] || ''
  return { clock: clock || full || '-', full }
}

function buildTradeSummary(rows) {
  return rows.reduce((acc, row) => {
    const qty = tradeQty(row)
    acc.turnover += tradeValue(row)
    if (tradeSide(row) === 'SELL') {
      acc.sell += 1
      acc.sellQty += qty
    } else {
      acc.buy += 1
      acc.buyQty += qty
    }
    return acc
  }, { buy: 0, sell: 0, buyQty: 0, sellQty: 0, turnover: 0 })
}

function tradeRowKey(row, fallback) {
  return [
    valueOf(row, ['fillid', 'tradeid', 'trade_id'], ''),
    valueOf(row, ['orderid', 'uniqueorderid'], ''),
    valueOf(row, ['tradingsymbol', 'symbolname', 'symbol'], ''),
    tradeTime(row),
    fallback,
  ].filter(Boolean).join('|')
}

function toTradeError(error) {
  const message = String(error?.message || '')
  if (/session|login|auth|token|jwt|unauthor/i.test(message)) {
    return 'This account is not logged in. Login from Broker Configuration first.'
  }
  return message || 'Failed to load trade book'
}
