import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const STORAGE_KEY = 'angelone_react_clients_v1';
const LEGACY_STORAGE_KEY = 'angelone_multi_clients_v1';
const LEGACY_DB_NAME = 'angelone-client-panel';
const LEGACY_DB_VERSION = 1;
const LEGACY_STORE_NAME = 'state';

// Primary storage: IndexedDB (async, roomier than localStorage).
const DB_NAME = 'angelone-react-panel';
const DB_VERSION = 1;
const STORE_NAME = 'clients';
const CLIENTS_RECORD_KEY = 'clients';

const defaultClients = [
  {
    enabled: true,
    alias: 'SIMULATED1',
    clientCode: 'SIM1',
    broker: 'APITest',
    marketOrders: 'Allowed',
    apiKey: '',
    apiSecret: '',
    totpSecret: '',
    pin: '',
    historicalApi: false,
    sqoffTime: '15:16',
    loggedIn: false,
    status: 'Idle',
    netMargin: '0.00',
    availableCash: '0.00',
    collateral: '0.00',
    utilisedPayout: '0.00',
    mtmAll: '0.00',
    misMtm: '0.00',
    nrmlMtm: '0.00',
    session: null,
  },
  {
    enabled: true,
    alias: 'SEYH1006',
    clientCode: 'SEYH1006',
    broker: 'Angel',
    marketOrders: 'Allowed',
    apiKey: 'AQDK44U4',
    apiSecret: '',
    totpSecret: '',
    pin: '',
    historicalApi: false,
    sqoffTime: '00:00',
    loggedIn: false,
    status: 'Idle',
    netMargin: '0.00',
    availableCash: '0.00',
    collateral: '0.00',
    utilisedPayout: '0.00',
    mtmAll: '0.00',
    misMtm: '0.00',
    nrmlMtm: '0.00',
    session: null,
  },
];

function App() {
  const [activeTab, setActiveTab] = useState('settings');
  const [clients, setClients] = useState(defaultClients);
  const [selectedRows, setSelectedRows] = useState(new Set());
  const [demoMode, setDemoMode] = useState(false);
  const [backendUrl, setBackendUrl] = useState('/api/angel/auto-login');
  const hydrated = useRef(false);

  // Load saved clients from IndexedDB once on mount; fall back to the
  // older IndexedDB/localStorage stores if this is a first run.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let loaded = await loadClients();
      if (!loaded?.length) loaded = await migrateLegacyClients();
      if (!cancelled && loaded?.length) setClients(loaded);
      if (!cancelled) hydrated.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist to IndexedDB on change — but not before the initial load has
  // run, so we never overwrite stored data with the default seed.
  useEffect(() => {
    if (!hydrated.current) return;
    saveClients(clients).catch(() => {});
  }, [clients]);

  const selectedClientIndexes = useMemo(() => [...selectedRows], [selectedRows]);

  function updateClient(index, patch) {
    setClients((current) => current.map((client, row) => (row === index ? { ...client, ...patch } : client)));
  }

  function addClient() {
    setClients((current) => [
      ...current,
      {
        ...defaultClients[0],
        alias: '',
        clientCode: '',
        broker: 'Angel',
        status: 'Idle',
      },
    ]);
  }

  function deleteClient(index) {
    setClients((current) => current.filter((_, row) => row !== index));
    setSelectedRows((current) => {
      const next = new Set();
      current.forEach((row) => {
        if (row < index) next.add(row);
        if (row > index) next.add(row - 1);
      });
      return next;
    });
  }

  function toggleSelected(index, checked) {
    setSelectedRows((current) => {
      const next = new Set(current);
      if (checked) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  async function runAutoLogin() {
    const targetIndexes = selectedClientIndexes.length
      ? selectedClientIndexes
      : clients.map((client, index) => (client.enabled ? index : null)).filter((index) => index !== null);

    if (!targetIndexes.length) return;

    for (const index of targetIndexes) {
      const client = clients[index];
      if (!client?.enabled) continue;

      updateClient(index, { status: 'Logging in...', loggedIn: false, netMargin: '0.00' });
      try {
        const result = demoMode ? await demoLogin(client, index) : await liveLogin(client, backendUrl);
        updateClient(index, {
          loggedIn: true,
          status: demoMode ? 'Demo login' : `Logged in - ${result.sessionSource || 'live'}`,
          netMargin: formatMoney(result.availableMargin),
          availableCash: formatMoney(result.availableCash),
          collateral: formatMoney(result.collateral),
          utilisedPayout: formatMoney(result.utilisedPayout),
          mtmAll: formatMoney(result.mtmAll),
          misMtm: formatMoney(result.misMtm),
          nrmlMtm: formatMoney(result.nrmlMtm),
          session: result.session || client.session || null,
        });
      } catch (error) {
        updateClient(index, {
          loggedIn: false,
          status: error.message || 'Login failed',
          netMargin: '0.00',
          availableCash: '0.00',
          collateral: '0.00',
          utilisedPayout: '0.00',
          session: null,
        });
      }
    }
  }

  async function logoutClient(index) {
    const client = clients[index];
    if (!demoMode && client.clientCode) {
      await fetch('/api/angel/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCode: client.clientCode }),
      }).catch(() => {});
    }

    updateClient(index, {
      loggedIn: false,
      status: 'Idle',
      netMargin: '0.00',
      availableCash: '0.00',
      collateral: '0.00',
      utilisedPayout: '0.00',
      session: null,
    });
  }

  return (
    <main className="app-shell bg-[#151819] text-slate-100">
      <header className="topbar shadow-[0_1px_0_rgba(255,255,255,.08)]">
        <nav className="tabs" aria-label="Main sections">
          {[
            ['orders', 'Order Book'],
            ['positions', 'Positions'],
            ['settings', 'User Settings'],
            ['strategies', 'Strategies'],
            ['multi-leg', 'Multi-leg'],
          ].map(([key, label]) => (
            <button
              className={`tab ${activeTab === key ? 'active' : ''}`}
              key={key}
              onClick={() => setActiveTab(key)}
              type="button"
            >
              {label}
            </button>
          ))}
        </nav>
        <section className="actions" aria-label="Account actions">
          <button className="btn secondary" onClick={addClient} type="button">Add Client</button>
          <button className="btn primary" onClick={runAutoLogin} type="button">Auto Login</button>
        </section>
      </header>

      {activeTab === 'settings' && (
        <UserSettings
          backendUrl={backendUrl}
          clients={clients}
          demoMode={demoMode}
          onBackendUrlChange={setBackendUrl}
          onClientChange={updateClient}
          onDeleteClient={deleteClient}
          onDemoModeChange={setDemoMode}
          onLogoutClient={logoutClient}
          onToggleSelected={toggleSelected}
          selectedRows={selectedRows}
        />
      )}

      {activeTab === 'strategies' && (
        <Strategies
          clients={clients}
          demoMode={demoMode}
          onClientSession={(index, session) => updateClient(index, { session })}
        />
      )}

      {activeTab !== 'settings' && activeTab !== 'strategies' && (
        <EmptyState title={activeTab === 'orders' ? 'Order Book' : activeTab === 'positions' ? 'Positions' : 'Multi-leg'} />
      )}
    </main>
  );
}

function UserSettings({
  backendUrl,
  clients,
  demoMode,
  onBackendUrlChange,
  onClientChange,
  onDeleteClient,
  onDemoModeChange,
  onLogoutClient,
  onToggleSelected,
  selectedRows,
}) {
  const allSelected = clients.length > 0 && clients.every((_, index) => selectedRows.has(index));

  return (
    <>
      <section className="config-strip" aria-label="Backend configuration">
        <label>
          Backend URL
          <input type="url" value={backendUrl} onChange={(event) => onBackendUrlChange(event.target.value)} />
        </label>
        <label className="switch">
          <input checked={demoMode} onChange={(event) => onDemoModeChange(event.target.checked)} type="checkbox" />
          <span>Demo mode - fake margins</span>
        </label>
      </section>

      <section className="grid-wrap" aria-label="Client settings">
        <table className="client-table">
          <thead>
            <tr>
              <th className="tiny">
                <input
                  checked={allSelected}
                  onChange={(event) => clients.forEach((_, index) => onToggleSelected(index, event.target.checked))}
                  type="checkbox"
                  aria-label="Select all clients"
                />
              </th>
              {['Enable', 'Delete', 'Logout', 'Manual Square Off', 'Logged In', 'MTM (All)', 'MIS MTM', 'NRML MTM', 'Net Margin', 'Cash', 'Collateral', 'Payout Used', 'Market Orders', 'User Alias', 'User ID', 'Broker', 'API Key', 'API Secret', 'TOTP Secret', 'PIN', 'Historical API', 'SqOff Time', 'Status'].map((heading) => (
                <th key={heading}>{heading}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {clients.map((client, index) => (
              <ClientRow
                client={client}
                index={index}
                key={`${client.clientCode}-${index}`}
                onChange={onClientChange}
                onDelete={onDeleteClient}
                onLogout={onLogoutClient}
                onToggleSelected={onToggleSelected}
                selected={selectedRows.has(index)}
              />
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function ClientRow({ client, index, onChange, onDelete, onLogout, onToggleSelected, selected }) {
  const stateClass = client.status?.includes('Logging') ? 'running' : client.loggedIn ? 'success' : client.status !== 'Idle' ? 'failed' : '';

  return (
    <tr className={stateClass}>
      <td className="tiny"><input checked={selected} onChange={(event) => onToggleSelected(index, event.target.checked)} type="checkbox" /></td>
      <td><input checked={client.enabled} onChange={(event) => onChange(index, { enabled: event.target.checked })} type="checkbox" /></td>
      <td><button className="icon danger" onClick={() => onDelete(index)} type="button" title="Delete client">x</button></td>
      <td><button className="icon" onClick={() => onLogout(index)} type="button" title="Logout client">o</button></td>
      <td><button className="icon" type="button" title="Manual square off">*</button></td>
      <td className="login-state">{client.loggedIn ? 'Yes' : 'No'}</td>
      <td className="money">{client.mtmAll || '0.00'}</td>
      <td className="money">{client.misMtm || '0.00'}</td>
      <td className="money">{client.nrmlMtm || '0.00'}</td>
      <td className="margin net-margin">{client.netMargin || '0.00'}</td>
      <td className="margin cash-margin">{client.availableCash || '0.00'}</td>
      <td className="margin collateral-margin">{client.collateral || '0.00'}</td>
      <td className="margin payout-margin">{client.utilisedPayout || '0.00'}</td>
      <td><Select value={client.marketOrders} onChange={(marketOrders) => onChange(index, { marketOrders })} options={['Allowed', 'Blocked']} /></td>
      <td><TextInput className="alias" value={client.alias} onChange={(alias) => onChange(index, { alias })} /></td>
      <td><TextInput className="client-code" value={client.clientCode} onChange={(clientCode) => onChange(index, { clientCode })} /></td>
      <td><Select value={client.broker} onChange={(broker) => onChange(index, { broker })} options={['Angel', 'APITest', 'KotakNeoV3']} /></td>
      <td><TextInput className={`api-key cred-box${client.apiKey ? ' filled' : ''}`} placeholder="Enter API key" value={client.apiKey} onChange={(apiKey) => onChange(index, { apiKey })} /></td>
      <td><TextInput className={`api-secret cred-box${client.apiSecret ? ' filled' : ''}`} placeholder="API secret" type="password" value={client.apiSecret} onChange={(apiSecret) => onChange(index, { apiSecret })} /></td>
      <td><TextInput className={`totp-secret cred-box${client.totpSecret ? ' filled' : ''}`} placeholder="TOTP secret" type="password" value={client.totpSecret} onChange={(totpSecret) => onChange(index, { totpSecret })} /></td>
      <td><TextInput className={`pin cred-box${client.pin ? ' filled' : ''}`} placeholder="PIN" type="password" value={client.pin} onChange={(pin) => onChange(index, { pin })} /></td>
      <td><input checked={client.historicalApi} onChange={(event) => onChange(index, { historicalApi: event.target.checked })} type="checkbox" /></td>
      <td><TextInput type="time" value={client.sqoffTime} onChange={(sqoffTime) => onChange(index, { sqoffTime })} /></td>
      <td className="status">{client.status || 'Idle'}</td>
    </tr>
  );
}

function Strategies({ clients, demoMode, onClientSession }) {
  return (
    <section className="strategies-view">
      <OptionChainPanel clients={clients} demoMode={demoMode} onClientSession={onClientSession} />
      <section className="strategy-workspace" aria-label="Strategy workspace">
        <div className="strategy-header">
          <div>
            <h2>Strategy Builder</h2>
            <p>Use the option chain on the left to inspect strikes and prepare orders.</p>
          </div>
          <button className="btn secondary" type="button">Save Layout</button>
        </div>
        <div className="strategy-canvas">
          <div className="strategy-tile">
            <span>Active Legs</span>
            <strong>0</strong>
          </div>
          <div className="strategy-tile">
            <span>Estimated Margin</span>
            <strong>{formatPrice(0)}</strong>
          </div>
          <div className="strategy-tile">
            <span>Risk</span>
            <strong>Idle</strong>
          </div>
        </div>
        <div className="strategy-panel p-5">
          <div className="grid h-full place-items-center rounded-md border border-dashed border-slate-700/80 text-center">
            <div>
              <div className="text-base font-bold text-slate-200">Build strategy from selected strikes</div>
              <div className="mt-1 text-xs font-semibold text-slate-500">Buy/Sell actions from the option chain can be wired here next.</div>
            </div>
          </div>
        </div>
      </section>
    </section>
  );
}

function OptionChainPanel({ clients, demoMode, onClientSession }) {
  const [chainIndex, setChainIndex] = useState({});
  const [clientIndex, setClientIndex] = useState(0);
  const [symbol, setSymbol] = useState('');
  const [expiry, setExpiry] = useState('');
  const [status, setStatus] = useState('Loading master index...');
  const [chain, setChain] = useState(null);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState({});   // token -> { ltp, oi, dir }
  const [liveSpot, setLiveSpot] = useState(null); // live underlying price
  const [feedOn, setFeedOn] = useState(false);
  const esRef = useRef(null);              // active EventSource
  const prevRef = useRef({});              // token -> last ltp (for tick direction)

  // High-frequency tick buffering: ticks land in refs synchronously (no React
  // work), and a single rAF loop flushes them to state at most once per frame.
  // This caps re-renders at ~60fps no matter how fast the feed streams.
  const liveRef = useRef({});              // token -> latest tick (live snapshot)
  const spotRef = useRef(null);            // latest spot tick
  const dirtyRef = useRef(false);          // ticks pending since last flush
  const rafRef = useRef(0);

  // Tear down the live feed + rAF loop on unmount.
  useEffect(() => () => {
    closeStream(esRef);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  const symbols = useMemo(() => {
    const preferred = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'CRUDEOIL', 'NATURALGAS', 'GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'COPPER'];
    const all = Object.keys(chainIndex).sort();
    return [...preferred.filter((item) => all.includes(item)), ...all.filter((item) => !preferred.includes(item))];
  }, [chainIndex]);

  const expiries = chainIndex[symbol] || [];

  useEffect(() => {
    loadMasterIndex();
  }, []);

  useEffect(() => {
    if (!symbol && symbols.length) setSymbol(symbols[0]);
  }, [symbol, symbols]);

  useEffect(() => {
    if (expiries.length && !expiries.includes(expiry)) setExpiry(expiries[0]);
  }, [expiries, expiry]);

  async function loadMasterIndex() {
    setStatus('Loading master index...');
    try {
      const response = await fetch('/api/angel/master-index');
      const body = await response.json();
      setChainIndex(body);
      setStatus('Master ready');
    } catch (error) {
      setStatus(error.message || 'Master load failed');
    }
  }

  async function refreshMaster() {
    setLoading(true);
    setStatus('Refreshing master...');
    try {
      const response = await fetch('/api/angel/refresh-master', { method: 'POST' });
      const body = await response.json();
      if (!response.ok || body.status === false) throw new Error(body.message || 'Refresh failed');
      await loadMasterIndex();
      setStatus(`Master refreshed: ${body.totalTokens} tokens`);
    } catch (error) {
      setStatus(error.message || 'Refresh failed');
    } finally {
      setLoading(false);
    }
  }

  async function loadChain() {
    const client = clients[clientIndex];
    if (!client) {
      setStatus('Select a client');
      return;
    }
    if (demoMode) {
      setStatus('Disable demo mode for live option chain');
      return;
    }
    if (!client.apiKey) {
      setStatus('API key missing for selected client');
      return;
    }
    if (!client.session?.jwtToken && (!client.pin || !client.totpSecret)) {
      setStatus('Login first or add PIN and TOTP secret in User Settings');
      return;
    }

    setLoading(true);
    setStatus('Loading option chain...');
    try {
      const response = await fetch('/api/angel/option-chain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client, symbol, expiry }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.status === false) throw new Error(body.message || `HTTP ${response.status}`);
      setLive({});
      setLiveSpot(null);
      prevRef.current = {};
      liveRef.current = {};
      spotRef.current = null;
      dirtyRef.current = false;
      setChain(body);
      onClientSession(clientIndex, body.session || client.session || null);
      setStatus(`Loaded ${body.symbol} ${body.expiry}`);
      startLiveFeed(body);
    } catch (error) {
      setStatus(error.message || 'Option chain failed');
    } finally {
      setLoading(false);
    }
  }

  // Subscribe to the Angel feed for this chain's tokens, then stream ticks
  // in over SSE and fold each one into `live` state (with up/down direction).
  async function startLiveFeed(body) {
    closeStream(esRef);
    setFeedOn(false);
    const tokens = body.liveTokens || [];
    if (!body.feed?.feedToken || !tokens.length) {
      setStatus('Loaded (live feed unavailable - no feed token)');
      return;
    }

    try {
      const res = await fetch('/api/angel/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credentials: body.feed,
          exchange: body.exchange,
          tokens,
          spot: body.spotToken ? { token: body.spotToken, exchange: body.spotExchange } : null,
        }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || out.status === false) throw new Error(out.message || 'Subscribe failed');
    } catch (error) {
      setStatus(`Live feed: ${error.message}`);
      return;
    }

    const source = new EventSource('/api/angel/stream');
    esRef.current = source;
    source.addEventListener('status', (event) => {
      try {
        const info = JSON.parse(event.data);
        setFeedOn(Boolean(info.connected));
      } catch {}
    });
    const spotToken = body.spotToken ? String(body.spotToken) : null;
    source.onmessage = (event) => {
      let tick;
      try { tick = JSON.parse(event.data); } catch { return; }
      const token = String(tick.token);
      const prev = prevRef.current[token];
      const dir = prev == null ? '' : tick.ltp > prev ? 'up' : tick.ltp < prev ? 'down' : '';
      prevRef.current[token] = tick.ltp;
      const at = event.timeStamp || performance.now();
      // Write to a ref only — no React state update here. Cheap and constant.
      if (token === spotToken) {
        spotRef.current = { ltp: tick.ltp, dir, at };
      } else {
        liveRef.current[token] = { ltp: tick.ltp, oi: tick.oi, close: tick.close, dir, at };
      }
      scheduleFlush();
    };
    source.onerror = () => setFeedOn(false);
  }

  // Coalesce buffered ticks into state once per animation frame.
  function scheduleFlush() {
    dirtyRef.current = true;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      if (spotRef.current) setLiveSpot(spotRef.current);
      // New object reference so memoized rows can diff by token value.
      setLive({ ...liveRef.current });
    });
  }

  const maxOi = useMemo(() => {
    const all = [...(chain?.callOI || []), ...(chain?.putOI || [])].map(Number);
    return all.length ? Math.max(...all, 0) : 0;
  }, [chain]);

  // Header badges: segment/kind of the selected symbol, and W/M per expiry.
  const symbolMeta = useMemo(() => classifySymbol(symbol), [symbol]);
  const expiryKinds = useMemo(() => classifyExpiries(expiries), [expiries]);

  // Recompute ATM as the strike nearest the live underlying price.
  const liveAtm = useMemo(() => {
    const price = liveSpot?.ltp;
    const strikes = chain?.strikes;
    if (!price || !strikes?.length) return null;
    return strikes.reduce((best, s) => (Math.abs(s - price) < Math.abs(best - price) ? s : best), strikes[0]);
  }, [liveSpot, chain]);

  return (
    <aside className="option-chain-panel">
      <header className="chain-titlebar">
        <h1>Option Chain</h1>
        <div className="chain-window-actions">
          <span className={`live-pill ${feedOn ? 'on' : 'off'}`} title={feedOn ? 'WebSocket connected - streaming ticks' : 'Live feed disconnected'}>
            <span className="live-dot" />{feedOn ? 'LIVE' : 'OFF'}
          </span>
          <button className="window-btn" type="button" title="Pop out">□</button>
          <button className="window-btn" type="button" title="Close">×</button>
        </div>
      </header>

      <div className="chain-controls">
        <select value={clientIndex} onChange={(event) => setClientIndex(Number(event.target.value))} title="Client">
          {clients.map((client, index) => (
            <option key={`${client.clientCode}-${index}`} value={index}>
              {client.alias || client.clientCode || `Client ${index + 1}`}
            </option>
          ))}
        </select>
        <PillSelect
          title="Symbol"
          value={symbol}
          onChange={setSymbol}
          options={symbols.map((item) => {
            const meta = classifySymbol(item);
            const isIndex = meta.kind === 'Index';
            return {
              value: item,
              label: item,
              pill: isIndex ? 'IDX' : meta.kind === 'Commodity' ? 'COMM' : 'EQ',
              pillClass: isIndex ? 'pill-idx' : meta.kind === 'Commodity' ? 'pill-comm' : 'pill-eq',
            };
          })}
        />
        <PillSelect
          title="Expiry"
          value={expiry}
          onChange={setExpiry}
          options={expiries.map((item) => {
            const monthly = expiryKinds[item] === 'Monthly';
            return {
              value: item,
              label: formatExpiry(item),
              pill: monthly ? 'M' : 'W',
              pillClass: monthly ? 'pill-monthly' : 'pill-weekly',
            };
          })}
        />
        <button className="chain-icon-btn" disabled={loading} onClick={refreshMaster} type="button" title="Refresh master">↻</button>
        <button className="load-chain-btn" disabled={loading} onClick={loadChain} type="button">
          {loading ? 'Loading' : 'Load'}
        </button>
      </div>

      {symbol && (
        <div className="chain-tags" aria-label="Instrument details">
          <span className="tag-symbol">{symbol}</span>
          <span className={`tag seg-${symbolMeta.segment.toLowerCase()}`}>{symbolMeta.segment}</span>
          <span className={`tag kind-${symbolMeta.kind.toLowerCase()}`}>{symbolMeta.kind}</span>
          {expiry && expiryKinds[expiry] && (
            <span className={`tag exp-${expiryKinds[expiry].toLowerCase()}`}>
              {expiryKinds[expiry]}
            </span>
          )}
        </div>
      )}

      <div className="chain-meta">
        <span>Spot
          <strong className={liveSpot?.dir ? `spot-flash-${liveSpot.dir}` : ''} key={`spot-${liveSpot?.at || 0}`}>
            {formatMoney(liveSpot?.ltp ?? chain?.spot ?? 0)}
          </strong>
        </span>
        <span>ATM <strong>{liveAtm || chain?.atm || 0}</strong></span>
        <span>PCR <strong>{Number(chain?.pcr || 0).toFixed(2)}</strong></span>
      </div>

      <div className="chain-table-wrap">
        <table className="chain-table">
          <colgroup>
            <col className="col-oi" />
            <col className="col-chg" />
            <col className="col-ltp" />
            <col className="col-strike" />
            <col className="col-ltp" />
            <col className="col-chg" />
            <col className="col-oi" />
          </colgroup>
          <thead>
            <tr className="chain-side-head">
              <th className="side-call" colSpan="3">CALL</th>
              <th className="side-strike">STRIKE</th>
              <th className="side-put" colSpan="3">PUT</th>
            </tr>
            <tr>
              <th>OI</th>
              <th>Chng%</th>
              <th className="ltp-head">LTP</th>
              <th>Strike</th>
              <th className="ltp-head">LTP</th>
              <th>Chng%</th>
              <th>OI</th>
            </tr>
          </thead>
          <tbody>
            {(chain?.strikes || []).map((strike, index) => {
              // Resolve flat primitives per row so the memoized ChainRow can
              // shallow-compare and skip rows whose values didn't change.
              const callTick = live[chain.callTokens?.[index]];
              const putTick = live[chain.putTokens?.[index]];
              return (
                <ChainRow
                  key={strike}
                  strike={strike}
                  isAtm={strike === chain.atm}
                  callItm={strike < chain.atm}
                  putItm={strike > chain.atm}
                  callLtp={callTick?.ltp ?? chain.callLtp?.[index]}
                  putLtp={putTick?.ltp ?? chain.putLtp?.[index]}
                  callOi={Number(callTick?.oi ?? chain.callOI?.[index] ?? 0)}
                  putOi={Number(putTick?.oi ?? chain.putOI?.[index] ?? 0)}
                  callClose={callTick?.close ?? chain.callClose?.[index]}
                  putClose={putTick?.close ?? chain.putClose?.[index]}
                  callDir={callTick?.dir || ''}
                  putDir={putTick?.dir || ''}
                  callAt={callTick?.at || 0}
                  putAt={putTick?.at || 0}
                  maxOi={maxOi}
                />
              );
            })}
            {!chain && (
              <tr>
                <td className="chain-empty" colSpan="7">Select expiry and load chain</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="chain-status">{status}</div>
    </aside>
  );
}

function EmptyState({ title }) {
  return (
    <section className="empty-view">
      <h2>{title}</h2>
      <p>This section is ready for the next workflow.</p>
    </section>
  );
}

// One option-chain row, memoized on flat primitive props. Under a live feed,
// only rows whose values actually changed re-render; the rest are skipped by
// React.memo's shallow compare — keeping the table fast at high tick rates.
const ChainRow = React.memo(function ChainRow({
  strike, isAtm, callItm, putItm,
  callLtp, putLtp, callOi, putOi, callClose, putClose,
  callDir, putDir, callAt, putAt, maxOi,
}) {
  const callChg = changePct(callLtp, callClose);
  const putChg = changePct(putLtp, putClose);
  const callWidth = maxOi ? Math.round((callOi / maxOi) * 100) : 0;
  const putWidth = maxOi ? Math.round((putOi / maxOi) * 100) : 0;
  return (
    <tr className={isAtm ? 'atm-row' : ''}>
      <td className={`oi call-oi${callItm ? ' itm-call' : ''}`}>
        <span className="oi-bar" style={{ width: `${callWidth}%` }} />
        <span className="oi-val">{formatQty(callOi)}</span>
      </td>
      <td className={`chg ${chgClass(callChg)}${callItm ? ' itm-call' : ''}`}>{formatChange(callChg)}</td>
      <td className={`ltp call-ltp has-actions${callItm ? ' itm-call' : ''}${callDir ? ` flash-${callDir}` : ''}`} key={`cl-${callAt}`}>
        <span className="ltp-val">{formatPrice(callLtp)}</span>
        <TradeActions side="call" />
      </td>
      <td className="strike">{strike}</td>
      <td className={`ltp put-ltp has-actions${putItm ? ' itm-put' : ''}${putDir ? ` flash-${putDir}` : ''}`} key={`pl-${putAt}`}>
        <span className="ltp-val">{formatPrice(putLtp)}</span>
        <TradeActions side="put" />
      </td>
      <td className={`chg ${chgClass(putChg)}${putItm ? ' itm-put' : ''}`}>{formatChange(putChg)}</td>
      <td className={`oi put-oi${putItm ? ' itm-put' : ''}`}>
        <span className="oi-bar" style={{ width: `${putWidth}%` }} />
        <span className="oi-val">{formatQty(putOi)}</span>
      </td>
    </tr>
  );
});

// Floating Buy/Sell action group that slides in over an LTP cell on row hover.
// Memoized with a stable `side` prop, so live ticks never re-render the
// buttons — the CSS hover/slide stays smooth no matter how fast the feed runs.
const TradeActions = React.memo(function TradeActions({ side }) {
  const label = side === 'call' ? 'Call' : 'Put';
  return (
    <div className="trade-actions" role="group" aria-label={`${label} actions`}>
      <button className="trade-btn buy" type="button" title={`Buy ${label}`}>B</button>
      <button className="trade-btn sell" type="button" title={`Sell ${label}`}>S</button>
      <button className="trade-btn ghost" type="button" title="Chart" aria-label="Chart">📈</button>
      <button className="trade-btn ghost" type="button" title="More" aria-label="More">⋮</button>
    </div>
  );
});

function closeStream(ref) {
  if (ref.current) {
    ref.current.close();
    ref.current = null;
  }
}

function TextInput({ className = '', onChange, placeholder, type = 'text', value }) {
  return (
    <input
      className={className}
      type={type}
      value={value || ''}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function Select({ onChange, options, value }) {
  return (
    <select value={value || options[0]} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => <option key={option}>{option}</option>)}
    </select>
  );
}

// Custom dropdown that renders a colored pill badge beside each option —
// native <option> can't show styled badges, so we build our own panel.
function PillSelect({ title, value, onChange, options }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function pick(optionValue) {
    onChange(optionValue);
    setOpen(false);
  }

  return (
    <div className={`pill-select${open ? ' open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="pill-select-trigger"
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="pill-select-label">{selected?.label ?? value ?? title}</span>
        {selected?.pill && <span className={`opt-pill ${selected.pillClass}`}>{selected.pill}</span>}
        <span className="pill-select-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul className="pill-select-menu" role="listbox">
          {options.map((option) => (
            <li
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              className={`pill-select-option${option.value === value ? ' active' : ''}`}
              onClick={() => pick(option.value)}
            >
              <span className="pill-select-label">{option.label}</span>
              {option.pill && <span className={`opt-pill ${option.pillClass}`}>{option.pill}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

async function liveLogin(client, backendUrl) {
  const response = await fetch(backendUrl || '/api/angel/auto-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status === false) throw new Error(body.message || `HTTP ${response.status}`);

  return {
    availableMargin: pickMargin(body),
    availableCash: body.data?.availablecash ?? 0,
    collateral: body.data?.collateral ?? 0,
    utilisedPayout: body.data?.utilisedpayout ?? 0,
    sessionSource: body.sessionSource,
    session: body.session || null,
    mtmAll: body.mtmAll ?? 0,
    misMtm: body.misMtm ?? 0,
    nrmlMtm: body.nrmlMtm ?? 0,
  };
}

function demoLogin(client, index) {
  return new Promise((resolve, reject) => {
    window.setTimeout(() => {
      if (!client.clientCode) {
        reject(new Error('Missing User ID'));
        return;
      }
      const seed = client.clientCode.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
      resolve({
        availableMargin: 25000 + seed * 13 + index * 719,
        availableCash: 25000 + seed * 13 + index * 719,
        collateral: 0,
        utilisedPayout: 0,
        mtmAll: 0,
        misMtm: 0,
        nrmlMtm: 0,
      });
    }, 450);
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Read the saved clients from IndexedDB, falling back to a one-time
// migration of any data left behind in localStorage by older builds.
async function loadClients() {
  try {
    const db = await openDb();
    const stored = await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const getRequest = transaction.objectStore(STORE_NAME).get(CLIENTS_RECORD_KEY);
      getRequest.onsuccess = () => resolve(getRequest.result || null);
      getRequest.onerror = () => reject(getRequest.error);
    });
    db.close();
    if (Array.isArray(stored) && stored.length) return stored;
  } catch {
    // fall through to localStorage migration below
  }

  const migrated = migrateLocalStorageClients();
  if (migrated) {
    await saveClients(migrated).catch(() => {});
    return migrated;
  }
  return null;
}

async function saveClients(clients) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(clients, CLIENTS_RECORD_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  db.close();
}

// One-time pull of clients saved by the previous localStorage-based build.
function migrateLocalStorageClients() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (Array.isArray(stored) && stored.length) return stored;
  } catch {
    return null;
  }
  return null;
}

async function migrateLegacyClients() {
  const indexedClients = await readLegacyIndexedClients().catch(() => null);
  if (Array.isArray(indexedClients) && indexedClients.length) return normalizeClients(indexedClients);

  try {
    const localClients = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || 'null');
    if (Array.isArray(localClients) && localClients.length) return normalizeClients(localClients);
  } catch {
    return null;
  }

  return null;
}

function readLegacyIndexedClients() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      resolve(null);
      return;
    }

    const request = indexedDB.open(LEGACY_DB_NAME, LEGACY_DB_VERSION);
    request.onupgradeneeded = () => {
      request.transaction.abort();
      resolve(null);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LEGACY_STORE_NAME)) {
        db.close();
        resolve(null);
        return;
      }

      const transaction = db.transaction(LEGACY_STORE_NAME, 'readonly');
      const getRequest = transaction.objectStore(LEGACY_STORE_NAME).get(LEGACY_STORAGE_KEY);
      getRequest.onsuccess = () => {
        db.close();
        resolve(getRequest.result || null);
      };
      getRequest.onerror = () => {
        db.close();
        reject(getRequest.error);
      };
    };
  });
}

function normalizeClients(value) {
  return value.map((client) => ({
    ...defaultClients[0],
    ...client,
    status: client.status || 'Idle',
    netMargin: client.netMargin || '0.00',
    availableCash: client.availableCash || client.cashMargin || '0.00',
    collateral: client.collateral || '0.00',
    utilisedPayout: client.utilisedPayout || client.payoutMargin || '0.00',
    mtmAll: client.mtmAll || '0.00',
    misMtm: client.misMtm || '0.00',
    nrmlMtm: client.nrmlMtm || '0.00',
  }));
}

function pickMargin(body) {
  return body.availableMargin ?? body.data?.net ?? body.data?.availablecash ?? body.data?.availablelimitmargin ?? body.data?.collateral ?? 0;
}

// ── Symbol / expiry classification for the header badges ──
const MCX_SYMBOLS = new Set([
  'GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'CRUDEOIL', 'CRUDEOILM',
  'NATURALGAS', 'NATGASMINI', 'COPPER', 'ZINC', 'MCXBULLDEX',
]);
const INDEX_SYMBOLS = new Set([
  'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50',
  'SENSEX', 'BANKEX', 'SENSEX50',
]);
const BSE_SYMBOLS = new Set(['SENSEX', 'BANKEX', 'SENSEX50']);

// Returns { segment: 'MCX'|'BSE'|'NSE', kind: 'Index'|'Stock'|'Commodity' }.
function classifySymbol(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (MCX_SYMBOLS.has(s)) return { segment: 'MCX', kind: 'Commodity' };
  if (BSE_SYMBOLS.has(s)) return { segment: 'BSE', kind: 'Index' };
  if (INDEX_SYMBOLS.has(s)) return { segment: 'NSE', kind: 'Index' };
  return { segment: 'NSE', kind: 'Stock' };
}

// An expiry is "Monthly" when it's the last expiry in its calendar month for
// this symbol; the earlier ones in that month are "Weekly".
function classifyExpiries(expiries = []) {
  const parsed = expiries
    .map((e) => ({ e, ms: Date.parse(e) }))
    .filter((x) => !Number.isNaN(x.ms))
    .sort((a, b) => a.ms - b.ms);

  const lastOfMonth = new Map(); // "YYYY-M" -> latest ms in that month
  for (const { ms } of parsed) {
    const d = new Date(ms);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (!lastOfMonth.has(key) || ms > lastOfMonth.get(key)) lastOfMonth.set(key, ms);
  }

  const result = {};
  for (const { e, ms } of parsed) {
    const d = new Date(ms);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    result[e] = lastOfMonth.get(key) === ms ? 'Monthly' : 'Weekly';
  }
  return result;
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPrice(value) {
  const number = Number(value || 0);
  return number ? `₹${number.toFixed(2)}` : '-';
}

function formatQty(value) {
  const number = Number(value || 0);
  return number ? number.toLocaleString('en-IN') : '-';
}

// % change of LTP vs previous-day close. Returns null when not computable.
function changePct(ltp, close) {
  const l = Number(ltp || 0);
  const c = Number(close || 0);
  if (!l || !c) return null;
  return ((l - c) / c) * 100;
}

function formatChange(pct) {
  if (pct == null) return '-';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

function chgClass(pct) {
  if (pct == null) return 'chg-flat';
  return pct > 0 ? 'chg-up' : pct < 0 ? 'chg-down' : 'chg-flat';
}

function formatExpiry(value) {
  const match = String(value || '').match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (!match) return value;
  return `${match[1]} ${titleCase(match[2])} ${match[3]}`;
}

function titleCase(value) {
  return `${value.slice(0, 1)}${value.slice(1).toLowerCase()}`;
}

createRoot(document.getElementById('root')).render(<App />);
