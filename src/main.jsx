import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BarChart3,
  BriefcaseBusiness,
  Database,
  Layers,
  Pencil,
  Plus,
  RefreshCw,
  Rss,
  Search,
  Settings2,
  Trash2,
  UserRound,
  UsersRound,
  X,
} from 'lucide-react';
import Basket from './Basket.jsx';
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
    phone: '',
    autoLogin: false,
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
    phone: '',
    autoLogin: false,
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

export default function App() {
  const [activeTab, setActiveTab] = useState('settings');
  // Tabs opened at least once. The Strategies tab hosts the option chain and its
  // live WebSocket feed; once it's mounted we keep it mounted (just hidden) so
  // switching tabs never tears the chain down and forces a full reload/re-login.
  const [mountedTabs, setMountedTabs] = useState(() => new Set([activeTab]));
  useEffect(() => {
    setMountedTabs((prev) => (prev.has(activeTab) ? prev : new Set(prev).add(activeTab)));
  }, [activeTab]);
  const [clients, setClients] = useState(defaultClients);
  const [selectedRows, setSelectedRows] = useState(new Set());
  const [demoMode, setDemoMode] = useState(false);
  const [backendUrl, setBackendUrl] = useState('/api/angel/auto-login');
  const [saveMsg, setSaveMsg] = useState('');
  const hydrated = useRef(false);

  // Set once Supabase provided the accounts, so the auto-login-on-open effect
  // fires only for a Supabase-backed load (not local-only runs).
  const supabaseLoaded = useRef(false);

  async function loadSupabaseClients() {
    const res = await fetch('/api/accounts');
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status === false) throw new Error(body.message || `HTTP ${res.status}`);
    if (!body.enabled || !Array.isArray(body.accounts) || !body.accounts.length) return null;
    return body.accounts.map((a) => ({ ...defaultClients[0], ...a, status: 'Idle', loggedIn: false, session: null }));
  }

  // Load saved clients on mount. Priority: Supabase (if the backend has it
  // configured) → local IndexedDB → legacy stores. Supabase is the shared source
  // of truth so opening the app on any machine restores the same accounts.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let loaded = null;
      try {
        loaded = await loadSupabaseClients();
        if (loaded?.length) {
          supabaseLoaded.current = true;
        }
      } catch (e) {
        /* Supabase not reachable — fall back to local storage below. */
      }
      if (!loaded?.length) loaded = await loadClients();
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
    let loginClients = clients;
    if (!demoMode) {
      try {
        const fresh = await loadSupabaseClients();
        if (fresh?.length) {
          loginClients = fresh;
          supabaseLoaded.current = true;
          setClients(fresh);
          setSaveMsg(`Loaded ${fresh.length} account(s) from Supabase`);
          setTimeout(() => setSaveMsg(''), 3000);
        }
      } catch (error) {
        setSaveMsg(`Supabase load failed: ${error.message}`);
        setTimeout(() => setSaveMsg(''), 4000);
      }
    }

    const targetIndexes = selectedClientIndexes.length
      ? selectedClientIndexes
      : loginClients.map((client, index) => (client.enabled ? index : null)).filter((index) => index !== null);

    if (!targetIndexes.length) return;

    for (const index of targetIndexes) {
      const client = loginClients[index];
      if (!client?.enabled) continue;
      const hasLiveToken = client.session?.jwtToken || client.session?.accessToken || client.session?.tradeToken || client.session?.sessionToken;
      if (client.loggedIn && (demoMode || hasLiveToken)) continue;

      updateClient(index, { status: 'Logging in...', loggedIn: false, netMargin: '0.00' });
      try {
        let result;
        if (demoMode) {
          result = await demoLogin(client, index);
        } else if (client.broker === 'Upstox') {
          result = await upstoxLogin(client);
        } else if (client.broker === 'KotakNeoV3') {
          result = await kotakLogin(client);
        } else if (client.broker === 'Nubra') {
          result = await nubraLogin(client);
        } else {
          result = await liveLogin(client, backendUrl);
        }
        updateClient(index, {
          loggedIn: true,
          status: demoMode ? 'Demo login' : `Logged in - ${result.sessionSource || 'live'}`,
          ...(result.totpSecret ? { totpSecret: result.totpSecret } : {}),
          ...(result.clearSetupToken ? { apiSecret: '' } : {}),
          netMargin: formatMoney(result.availableMargin),
          availableCash: formatMoney(result.availableCash),
          collateral: formatMoney(result.collateral),
          utilisedPayout: formatMoney(result.utilisedPayout),
          mtmAll: formatMoney(result.mtmAll),
          misMtm: formatMoney(result.misMtm),
          nrmlMtm: formatMoney(result.nrmlMtm),
          session: result.session || client.session || null,
        });
        if (result.totpSecret) {
          loginClients = loginClients.map((rowClient, row) => (row === index ? { ...rowClient, totpSecret: result.totpSecret, apiSecret: '' } : rowClient));
          if (supabaseLoaded.current) {
            saveAccountsToSupabase(loginClients).catch((error) => {
              setSaveMsg(`TOTP secret save failed: ${error.message}`);
              setTimeout(() => setSaveMsg(''), 4000);
            });
          }
        }
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

  // After accounts load FROM SUPABASE, auto-login all enabled accounts once —
  // so opening the app in the browser restores creds and logs in hands-free.
  const autoLoginFired = useRef(false);
  useEffect(() => {
    if (autoLoginFired.current) return;
    if (!supabaseLoaded.current) return;      // only for Supabase-backed loads
    if (!clients.some((c) => c.enabled)) return;
    autoLoginFired.current = true;
    runAutoLogin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients]);

  // saveToSupabase pushes the current table to Supabase so it's the shared
  // source of truth. Only the credential/config fields are stored (not live
  // session/margin state, which is per-run).
  function accountPayloads(rows) {
    return rows.map((c) => ({
      enabled: !!c.enabled,
      alias: c.alias || '',
      clientCode: c.clientCode || '',
      broker: c.broker || 'Angel',
      marketOrders: c.marketOrders || 'Allowed',
      apiKey: c.apiKey || '',
      apiSecret: c.apiSecret || '',
      totpSecret: c.totpSecret || '',
      pin: c.pin || '',
      phone: c.phone || '',
      autoLogin: !!c.autoLogin,
      historicalApi: !!c.historicalApi,
      sqoffTime: c.sqoffTime || '15:16',
    }));
  }

  async function saveAccountsToSupabase(rows) {
    const accounts = accountPayloads(rows);
    const res = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accounts }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status === false) throw new Error(body.message || `HTTP ${res.status}`);
    return body;
  }

  async function saveToSupabase() {
    try {
      const body = await saveAccountsToSupabase(clients);
      setSaveMsg(body.enabled ? `Saved ${body.saved} account(s) to Supabase` : 'Supabase not configured on the backend');
    } catch (e) {
      setSaveMsg(`Save failed: ${e.message}`);
    }
    setTimeout(() => setSaveMsg(''), 4000);
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
    <main className="app-shell app-shell-sidebar">
      <aside className="app-sidebar" aria-label="Main sections">
        <div className="sidebar-brand">
          <span className="sidebar-brand-mark"><BarChart3 size={17} /></span>
          <span>
            <strong>AlphaHedge</strong>
            <em>Multitrade</em>
          </span>
        </div>

        <nav className="sidebar-nav">
          {[
            ['users', 'Users', UsersRound],
            ['feedmaster', 'Feedmaster', Rss],
            ['orders', 'Order Book', Database],
            ['positions', 'Positions', BriefcaseBusiness],
            ['settings', 'User Settings', Settings2],
            ['strategies', 'Strategies', BarChart3],
            ['multi-leg', 'Multi-leg', Layers],
          ].map(([key, label, Icon]) => (
            <button
              className={`sidebar-link ${activeTab === key ? 'active' : ''}`}
              key={key}
              onClick={() => setActiveTab(key)}
              type="button"
              title={label}
            >
              <Icon size={16} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <section className="app-workspace">
        <header className="workspace-topbar">
          <div className="workspace-title">
            <strong>{sectionTitle(activeTab)}</strong>
            <span>{sectionSubtitle(activeTab)}</span>
          </div>
          <section className="actions" aria-label="Account actions">
            {saveMsg && <span className="save-msg">{saveMsg}</span>}
            <button className="btn secondary" onClick={addClient} type="button"><Plus size={15} /> Add Client</button>
            <button className="btn secondary" onClick={saveToSupabase} type="button" title="Save all accounts to Supabase">Save to Supabase</button>
            <button className="btn primary" onClick={runAutoLogin} type="button">Auto Login</button>
          </section>
        </header>

        <div className="app-content">
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

          {activeTab === 'users' && <UsersView />}

          {activeTab === 'feedmaster' && <FeedmasterView />}

          {mountedTabs.has('strategies') && (
            <div className="tab-keepalive" style={{ display: activeTab === 'strategies' ? 'contents' : 'none' }}>
              <Strategies
                clients={clients}
                demoMode={demoMode}
                onClientSession={(index, session) => updateClient(index, { session, loggedIn: !!session?.jwtToken })}
              />
            </div>
          )}

          {mountedTabs.has('orders') && (
            <div className="tab-keepalive" style={{ display: activeTab === 'orders' ? 'contents' : 'none' }}>
              <OrderBookView
                clients={clients}
                demoMode={demoMode}
                active={activeTab === 'orders'}
                onClientSession={(index, session) => updateClient(index, { session, loggedIn: !!session?.jwtToken })}
              />
            </div>
          )}

          {mountedTabs.has('positions') && (
            <div className="tab-keepalive" style={{ display: activeTab === 'positions' ? 'contents' : 'none' }}>
              <PositionBookView
                clients={clients}
                demoMode={demoMode}
                active={activeTab === 'positions'}
                onClientSession={(index, session) => updateClient(index, { session, loggedIn: !!session?.jwtToken })}
              />
            </div>
          )}

          {activeTab !== 'settings' && activeTab !== 'users' && activeTab !== 'feedmaster' && activeTab !== 'strategies' && activeTab !== 'orders' && activeTab !== 'positions' && (
            <EmptyState title={activeTab === 'orders' ? 'Order Book' : activeTab === 'positions' ? 'Positions' : 'Multi-leg'} />
          )}
        </div>
      </section>
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
              {['Enable', 'Delete', 'Logout', 'Manual Square Off', 'Logged In', 'MTM (All)', 'MIS MTM', 'NRML MTM', 'Net Margin', 'Cash', 'Collateral', 'Payout Used', 'Market Orders', 'User Alias', 'User ID', 'Broker', 'API Key', 'API Secret', 'TOTP Secret', 'PIN', 'Phone', 'Auto Login', 'Historical API', 'SqOff Time', 'Status'].map((heading) => (
                <th key={heading}>{heading}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {clients.map((client, index) => (
              <ClientRow
                client={client}
                index={index}
                // Key on the stable row position only. Previously this included
                // client.clientCode (the User ID field), so every keystroke in
                // the User ID box changed the key → React remounted the whole
                // row → the input lost focus and the table jumped/scrolled.
                key={index}
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

function sectionTitle(activeTab) {
  return {
    users: 'Users',
    feedmaster: 'Feedmaster',
    orders: 'Order Book',
    positions: 'Positions',
    settings: 'User Settings',
    strategies: 'Strategies',
    'multi-leg': 'Multi-leg',
  }[activeTab] || 'AlphaHedge';
}

function sectionSubtitle(activeTab) {
  return {
    users: 'Alias-based users from Supabase broker accounts',
    feedmaster: 'Shared live feed account selector',
    orders: 'Live order and trade books',
    positions: 'Live net position book',
    settings: 'Broker account credentials and login state',
    strategies: 'Option chain and basket workflow',
    'multi-leg': 'Multi-leg workflow',
  }[activeTab] || '';
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
      <td><Select value={client.broker} onChange={(broker) => onChange(index, { broker })} options={['Angel', 'Upstox', 'APITest', 'KotakNeoV3', 'Nubra']} /></td>
      <td><TextInput className={`api-key cred-box${client.apiKey ? ' filled' : ''}`} placeholder="Enter API key" value={client.apiKey} onChange={(apiKey) => onChange(index, { apiKey })} /></td>
      <td><TextInput className={`api-secret cred-box${client.apiSecret ? ' filled' : ''}`} placeholder={client.broker === 'Nubra' ? 'Setup session token' : 'API secret'} type="password" value={client.apiSecret} onChange={(apiSecret) => onChange(index, { apiSecret })} /></td>
      <td><TextInput className={`totp-secret cred-box${client.totpSecret ? ' filled' : ''}`} placeholder={client.broker === 'Nubra' ? 'TOTP secret / auto-fill' : 'TOTP secret'} type="password" value={client.totpSecret} onChange={(totpSecret) => onChange(index, { totpSecret })} /></td>
      <td><TextInput className={`pin cred-box${client.pin ? ' filled' : ''}`} placeholder="PIN" type="password" value={client.pin} onChange={(pin) => onChange(index, { pin })} /></td>
      <td><TextInput className={`phone cred-box${client.phone ? ' filled' : ''}`} placeholder="Mobile" value={client.phone} onChange={(phone) => onChange(index, { phone })} /></td>
      <td><input checked={!!client.autoLogin} onChange={(event) => onChange(index, { autoLogin: event.target.checked })} type="checkbox" title="Auto Login (Upstox: mobile → TOTP → PIN, fully automated)" /></td>
      <td><input checked={client.historicalApi} onChange={(event) => onChange(index, { historicalApi: event.target.checked })} type="checkbox" /></td>
      <td><TextInput type="time" value={client.sqoffTime} onChange={(sqoffTime) => onChange(index, { sqoffTime })} /></td>
      <td className="status">{client.status || 'Idle'}</td>
    </tr>
  );
}

const FEEDMASTER_KEY = 'ahc_feed_master_account';
const FEEDMASTER_CHANGED = 'feedmaster:changed';

const FEED_BROKERS_LOCAL = [
  { id: 'angelone', label: 'Angel One', apiPath: 'angel' },
  { id: 'angel', label: 'Angel One', apiPath: 'angel' },
  { id: 'upstox', label: 'Upstox', apiPath: 'upstox' },
  { id: 'kotak', label: 'Kotak Neo', apiPath: 'kotak' },
  { id: 'kotakneov3', label: 'Kotak Neo', apiPath: 'kotak' },
  { id: 'nubra', label: 'Nubra', apiPath: 'nubra' },
];

async function apiGetLocal(path) {
  const response = await fetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false || body.status === false) throw new Error(body.message || `HTTP ${response.status}`);
  return body;
}

async function apiPostLocal(path, payload = {}) {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false || body.status === false) throw new Error(body.message || `HTTP ${response.status}`);
  return body;
}

function brokerMeta(name = '') {
  const normalized = String(name).toLowerCase().replace(/\s/g, '');
  return FEED_BROKERS_LOCAL.find((broker) => broker.id === normalized) || FEED_BROKERS_LOCAL.find((broker) => normalized.includes(broker.id));
}

function brokerLabel(name = '') {
  return brokerMeta(name)?.label || name || '-';
}

function getSavedFeedmasterLocal() {
  try { return JSON.parse(localStorage.getItem(FEEDMASTER_KEY)) || null; } catch { return null; }
}

function saveFeedmasterLocal(setting) {
  localStorage.setItem(FEEDMASTER_KEY, JSON.stringify(setting));
  window.dispatchEvent(new CustomEvent(FEEDMASTER_CHANGED, { detail: setting }));
}

function feedSessionKey(configId) {
  return `ahc_session_${configId}`;
}

function getFeedSession(configId) {
  try { return JSON.parse(localStorage.getItem(feedSessionKey(configId))) || null; } catch { return null; }
}

function saveFeedSession(configId, session) {
  if (configId && session) localStorage.setItem(feedSessionKey(configId), JSON.stringify(session));
}

function brokerClientFromConfig(config) {
  const session = getFeedSession(config.id);
  return {
    enabled: true,
    broker: config.broker_name,
    configId: config.id,
    userId: config.user_id || '',
    clientCode: config.account_id,
    apiKey: config.app_key,
    apiSecret: config.app_secret,
    accessToken: config.app_key || config.app_secret,
    ucc: config.account_id,
    pin: config.pin,
    mpin: config.pin,
    totpSecret: config.totp_secret,
    phone: config.phone,
    mobileNumber: config.phone,
    autoLogin: true,
    session,
    loggedIn: !!(session?.jwtToken || session?.accessToken || session?.tradeToken || session?.sessionToken),
  };
}

async function brokerAutoLoginLocal(config, { feedRegister = false, userName = '' } = {}) {
  const client = brokerClientFromConfig(config);
  if (feedRegister) {
    client.feedRegister = true;
    client.userName = userName;
  }
  const apiPath = brokerMeta(config.broker_name)?.apiPath || 'angel';
  const response = await fetch(`/api/${apiPath}/auto-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client, ...client, feedRegister, userName }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status === false) {
    if (body.needsOtp || body.needsLogin) return body;
    throw new Error(body.message || `HTTP ${response.status}`);
  }
  if (body.session) saveFeedSession(config.id, body.session);
  return body;
}

function UsersView() {
  const [users, setUsers] = useState([]);
  const [status, setStatus] = useState('Loading users...');
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [form, setForm] = useState({ username: '', email: '', mobile: '' });
  const [brokerUser, setBrokerUser] = useState(null);
  const [brokerConfigs, setBrokerConfigs] = useState([]);
  const [brokerLoading, setBrokerLoading] = useState(false);

  useEffect(() => { loadUsers(); }, []);

  async function loadUsers() {
    setLoading(true);
    setStatus('Loading users...');
    try {
      const body = await apiGetLocal('/users/list');
      setUsers(body.data || []);
      setStatus(`${(body.data || []).length} users loaded`);
    } catch (error) {
      setStatus(error.message || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }

  function editUser(user) {
    setEditingId(String(user.id));
    setForm({
      username: user.username || '',
      email: user.email || '',
      mobile: user.mobile || '',
    });
  }

  function clearForm() {
    setEditingId('');
    setForm({ username: '', email: '', mobile: '' });
  }

  async function saveUser() {
    if (!form.username.trim()) {
      setStatus('Username is required');
      return;
    }
    setLoading(true);
    try {
      if (editingId) {
        await apiPostLocal('/users/update', { id: editingId, ...form });
        setStatus('User updated');
      } else {
        await apiPostLocal('/users/create', form);
        setStatus('User created');
      }
      clearForm();
      await loadUsers();
    } catch (error) {
      setStatus(error.message || 'Failed to save user');
    } finally {
      setLoading(false);
    }
  }

  async function deleteUser(user) {
    if (!window.confirm(`Delete user "${user.username}"?`)) return;
    setLoading(true);
    try {
      await apiPostLocal('/users/delete', { id: user.id });
      setStatus('User deleted');
      await loadUsers();
    } catch (error) {
      setStatus(error.message || 'Failed to delete user');
    } finally {
      setLoading(false);
    }
  }

  async function openBrokerConfig(user) {
    setBrokerUser(user);
    setBrokerConfigs([]);
    setBrokerLoading(true);
    setStatus(`Loading broker accounts for ${user.username || user.id}...`);
    try {
      const body = await apiGetLocal(`/users/broker-config/list?user_id=${encodeURIComponent(user.id)}`);
      setBrokerConfigs(body.data || []);
      setStatus(`${(body.data || []).length} broker accounts loaded for ${user.username || user.id}`);
    } catch (error) {
      setStatus(error.message || 'Failed to load broker accounts');
    } finally {
      setBrokerLoading(false);
    }
  }

  const totalBrokers = users.reduce((sum, user) => sum + Number(user.brokers || 0), 0);

  return (
    <section className="users-view">
      <header className="user-page-head">
        <div>
          <span className="section-kicker">Supabase users</span>
          <h2>Users</h2>
          <p>Each user is an alias. Broker account rows under the same alias belong to that user.</p>
        </div>
        <button className="btn secondary" type="button" disabled={loading} onClick={loadUsers}>
          <RefreshCw size={15} /> Refresh
        </button>
      </header>

      <div className="user-metrics">
        <div>
          <span>Total Users</span>
          <strong>{users.length}</strong>
          <em>Distinct aliases</em>
        </div>
        <div>
          <span>Broker Accounts</span>
          <strong>{totalBrokers}</strong>
          <em>Supabase rows</em>
        </div>
        <div>
          <span>Selected User</span>
          <strong>{brokerUser?.username || '-'}</strong>
          <em>{brokerConfigs.length} linked accounts</em>
        </div>
      </div>

      <div className="config-strip user-editor-strip" aria-label="User editor">
        <label>
          Username
          <input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="User alias" />
        </label>
        <label>
          Email
          <input value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="Email" />
        </label>
        <label>
          Mobile
          <input value={form.mobile} onChange={(event) => setForm({ ...form, mobile: event.target.value })} placeholder="Mobile" />
        </label>
        <div className="inline-actions">
          <button className="btn primary" type="button" disabled={loading} onClick={saveUser}>
            {editingId ? <Pencil size={15} /> : <Plus size={15} />}
            {editingId ? 'Save User' : 'Add User'}
          </button>
          {editingId && <button className="btn secondary" type="button" onClick={clearForm}>Cancel</button>}
        </div>
      </div>

      <div className="book-status">{status}</div>

      <div className="users-grid">
        <div className="book-table-wrap user-table-card">
          <table className="book-table app-admin-table">
            <thead>
              <tr>
                <th>User Alias</th>
                <th>Email</th>
                <th>Mobile</th>
                <th>Brokers</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className={brokerUser?.id === user.id ? 'selected-row' : ''}>
                  <td>
                    <div className="user-name-cell">
                      <span><UserRound size={15} /></span>
                      <strong>{user.username || '-'}</strong>
                    </div>
                  </td>
                  <td>{user.email || '-'}</td>
                  <td>{user.mobile || '-'}</td>
                  <td><span className="book-tag product">{user.brokers ?? 0} broker{Number(user.brokers || 0) === 1 ? '' : 's'}</span></td>
                  <td>
                    <div className="row-actions">
                      <button className="icon" type="button" title="Broker Config" onClick={() => openBrokerConfig(user)}><Settings2 size={14} /></button>
                      <button className="icon" type="button" title="Edit User" onClick={() => editUser(user)}><Pencil size={14} /></button>
                      <button className="icon danger" type="button" title="Delete User" onClick={() => deleteUser(user)}><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {!users.length && (
                <tr><td className="book-empty" colSpan="5">No users to show</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <aside className="broker-config-panel">
          <div className="broker-panel-head">
            <div>
              <span className="section-kicker">Broker Config</span>
              <strong>{brokerUser?.username || 'Select a user'}</strong>
            </div>
            {brokerLoading && <RefreshCw size={15} className="spin" />}
          </div>

          {!brokerUser && (
            <div className="broker-empty">Select a user row to inspect broker accounts.</div>
          )}

          {brokerUser && brokerConfigs.length === 0 && !brokerLoading && (
            <div className="broker-empty">No broker accounts saved for this alias yet.</div>
          )}

          {brokerConfigs.map((config) => (
            <div className="broker-config-card" key={config.id}>
              <div>
                <strong>{brokerLabel(config.broker_name)}</strong>
                <span>{config.account_id || 'No account ID'}</span>
              </div>
              <em>{config.totp_secret ? 'TOTP set' : 'TOTP missing'}</em>
            </div>
          ))}
        </aside>
      </div>
    </section>
  );
}

function FeedmasterView() {
  const [users, setUsers] = useState([]);
  const [configs, setConfigs] = useState([]);
  const [userId, setUserId] = useState('');
  const [configId, setConfigId] = useState('');
  const [status, setStatus] = useState('Loading users...');
  const [loading, setLoading] = useState(false);

  const selectedConfig = configs.find((config) => String(config.id) === String(configId));
  const selectedUser = users.find((user) => String(user.id) === String(userId));
  const canSave = Boolean(userId && configId);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = getSavedFeedmasterLocal();
        const body = await apiGetLocal('/users/list');
        if (cancelled) return;
        const list = body.data || [];
        setUsers(list);
        setUserId(saved?.userId ? String(saved.userId) : String(list[0]?.id || ''));
        setConfigId(saved?.configId ? String(saved.configId) : '');
        setStatus(saved?.configId ? 'Saved Feedmaster loaded' : 'Select a feed account');
      } catch (error) {
        if (!cancelled) setStatus(error.message || 'Failed to load users');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!userId) {
        setConfigs([]);
        setConfigId('');
        return;
      }
      try {
        const saved = getSavedFeedmasterLocal();
        const body = await apiGetLocal(`/users/broker-config/list?user_id=${encodeURIComponent(userId)}`);
        if (cancelled) return;
        const list = body.data || [];
        setConfigs(list);
        if (saved?.userId && String(saved.userId) === String(userId) && saved?.configId) setConfigId(String(saved.configId));
        else setConfigId(String(list[0]?.id || ''));
      } catch (error) {
        if (!cancelled) setStatus(error.message || 'Failed to load broker accounts');
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  function saveFeedmaster() {
    if (!canSave) {
      setStatus('Select a user and broker account first');
      return;
    }
    saveFeedmasterLocal({
      userId,
      configId,
      broker: selectedConfig?.broker_name || '',
      accountId: selectedConfig?.account_id || '',
    });
    setStatus('Feedmaster saved');
  }

  async function testLogin() {
    if (!selectedConfig) {
      setStatus('Select a broker account first');
      return;
    }
    setLoading(true);
    setStatus('Testing feed account login...');
    try {
      const body = await brokerAutoLoginLocal(selectedConfig, {
        feedRegister: true,
        userName: selectedUser?.username || userId,
      });
      if (body.needsOtp) setStatus('Nubra needs one-time OTP');
      else if (body.needsLogin) setStatus('Upstox needs browser login');
      else {
        saveFeedmaster();
        setStatus(body.sessionSource === 'session' ? 'Feedmaster live - session reused' : 'Feedmaster live - fresh login saved');
      }
    } catch (error) {
      setStatus(error.message || 'Feedmaster login failed');
    } finally {
      setLoading(false);
    }
  }

  function clearFeedmaster() {
    localStorage.removeItem(FEEDMASTER_KEY);
    setConfigId('');
    setStatus('Feedmaster cleared');
  }

  const saved = getSavedFeedmasterLocal();

  return (
    <section className="book-view">
      <header className="book-top-tabs" aria-label="Feedmaster">
        <div className="book-tabs" role="tablist">
          <button className="active" type="button">Feedmaster</button>
          <button className="muted" disabled type="button">Live Feed</button>
          <button className="muted" disabled type="button">Sessions</button>
        </div>
      </header>

      <div className="config-strip feedmaster-strip" aria-label="Feedmaster selector">
        <label>
          User
          <select value={userId} onChange={(event) => setUserId(event.target.value)}>
            {users.map((user) => <option key={user.id} value={String(user.id)}>{user.username || `User ${user.id}`}</option>)}
          </select>
        </label>
        <label>
          Broker Account
          <select value={configId} onChange={(event) => setConfigId(event.target.value)} disabled={!configs.length}>
            {configs.map((config) => (
              <option key={config.id} value={String(config.id)}>
                {brokerLabel(config.broker_name)} - {config.account_id || config.id}
              </option>
            ))}
          </select>
        </label>
        <div className="inline-actions">
          <button className="btn primary" type="button" disabled={!canSave || loading} onClick={saveFeedmaster}>Save Feedmaster</button>
          <button className="btn secondary" type="button" disabled={!canSave || loading} onClick={testLogin}>Test Login</button>
          <button className="btn secondary" type="button" onClick={clearFeedmaster}>Clear</button>
        </div>
      </div>

      <div className="book-summary">
        <div>
          <span>Current User</span>
          <strong>{saved?.userId || '-'}</strong>
          <em>Saved feed owner</em>
        </div>
        <div>
          <span>Broker</span>
          <strong>{brokerLabel(saved?.broker) || '-'}</strong>
          <em>{saved?.accountId || 'No account saved'}</em>
        </div>
        <div>
          <span>Status</span>
          <strong>{status}</strong>
          <em>{configs.length} accounts available</em>
        </div>
      </div>
    </section>
  );
}

function OrderBookView({ clients, demoMode, onClientSession, active = true }) {
  const [bookTab, setBookTab] = useState('history');
  const [clientIndex, setClientIndex] = useState(0);
  const [orderRows, setOrderRows] = useState([]);
  const [tradeRows, setTradeRows] = useState([]);
  // Which books we've already fetched for the CURRENT account. The first fetch
  // shows a spinner; after that Open <-> History (which share the order book)
  // just filter the cached rows. New orders arrive via the 3 s silent poll.
  const loadedRef = useRef({ orders: false, trades: false });
  // Guards the poll so a slow fetch can't pile up overlapping requests.
  const pollingRef = useRef(false);
  const [status, setStatus] = useState('Select a logged-in account');
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');

  const loggedInIndexes = useMemo(
    () => clients.map((client, index) => (client.loggedIn ? index : -1)).filter((index) => index >= 0),
    [clients],
  );
  const selectedClient = clients[clientIndex];

  useEffect(() => {
    if (loggedInIndexes.length && !loggedInIndexes.includes(clientIndex)) {
      setClientIndex(loggedInIndexes[0]);
    }
  }, [loggedInIndexes, clientIndex]);

  // Switching account (or demo mode) invalidates the cached books so the new
  // account is fetched (and its token verified) once.
  useEffect(() => {
    loadedRef.current = { orders: false, trades: false };
    setOrderRows([]);
    setTradeRows([]);
  }, [clientIndex, demoMode]);

  // Live book via PUSH: first paint fetches (with spinner), then Angel's
  // order-status WebSocket (relayed through our SSE) pushes an event the instant
  // an order is placed/executed/cancelled/modified — we refresh the rows on that
  // event. No fixed polling. A slow 20 s safety refresh covers a missed event or
  // a briefly dropped socket. Runs only while the tab is visible (active).
  useEffect(() => {
    if (!active || !selectedClient?.loggedIn || demoMode) return;
    const which = bookTab === 'trades' ? 'trades' : 'orders';
    if (!loadedRef.current[which]) loadBook(which); // first paint for this book

    const refresh = () => {
      if (pollingRef.current) return; // don't overlap a still-running fetch
      pollingRef.current = true;
      // An order change can affect BOTH books (an execution flips the order to
      // "complete" AND creates a trade), so invalidate the other book's cache —
      // it reloads fresh when next viewed while we refresh the visible one now.
      loadedRef.current[which === 'trades' ? 'orders' : 'trades'] = false;
      loadBook(which, true, true).finally(() => { pollingRef.current = false; });
    };
    // Debounce bursts (an order fill can emit several events in a row).
    let debounce = null;
    const nudge = () => { clearTimeout(debounce); debounce = setTimeout(refresh, 400); };

    const session = selectedClient.session;
    const creds = session?.jwtToken && session?.feedToken ? {
      jwtToken: session.jwtToken,
      feedToken: session.feedToken,
      apiKey: selectedClient.apiKey,
      clientCode: selectedClient.clientCode,
    } : null;

    const subscribe = () => {
      if (!creds) return;
      fetch('/api/angel/order-subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentials: creds }),
      }).catch(() => {});
    };

    let es = null;
    if (creds) {
      subscribe();
      es = new EventSource('/api/angel/order-stream');
      es.addEventListener('order', nudge);   // an order changed → refresh the book
      es.onopen = subscribe;                  // (re)assert the watch on (re)connect
    }

    const safety = setInterval(refresh, 20000); // fallback if an event is missed

    return () => {
      clearTimeout(debounce);
      clearInterval(safety);
      if (es) es.close();
    };
  }, [active, bookTab, clientIndex, selectedClient?.loggedIn, selectedClient?.session?.jwtToken, demoMode]);

  async function loadBook(which = bookTab === 'trades' ? 'trades' : 'orders', force = false, silent = false) {
    const client = clients[clientIndex];
    if (!client?.loggedIn) {
      if (!silent) setStatus('Log in an account first');
      return;
    }
    if (demoMode) {
      if (!silent) setStatus('Disable demo mode for live order book');
      return;
    }
    if (loadedRef.current[which] && !force) return; // already have it — don't re-check

    if (!silent) {
      setLoading(true);
      setStatus(which === 'trades' ? 'Loading trade book...' : 'Loading order book...');
    }
    try {
      const response = await fetch(which === 'trades' ? '/api/angel/trade-book' : '/api/angel/order-book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.status === false) throw new Error(body.message || `HTTP ${response.status}`);
      if (body.session?.jwtToken) onClientSession?.(clientIndex, body.session);
      const nextRows = which === 'trades' ? body.trades || [] : body.orders || [];
      if (which === 'trades') setTradeRows(nextRows);
      else setOrderRows(nextRows);
      loadedRef.current[which] = true;
      setStatus(`${nextRows.length} ${which === 'trades' ? 'trades' : 'orders'} loaded`);
    } catch (error) {
      if (!silent) {
        loadedRef.current[which] = false; // visible failure — allow a retry
        setStatus(error.message || 'Book load failed');
      }
      // Silent poll failures keep the last good rows on screen (no flicker); the
      // next poll retries, and the book call itself re-logins on a dead token.
    } finally {
      if (!silent) setLoading(false);
    }
  }

  const visibleRows = useMemo(() => {
    const base = bookTab === 'trades' ? tradeRows : orderRows;
    const source = bookTab === 'open' ? base.filter((row) => isOpenOrder(row)) : base;
    const needle = query.trim().toLowerCase();
    if (!needle) return source;
    return source.filter((row) => JSON.stringify(row).toLowerCase().includes(needle));
  }, [orderRows, tradeRows, bookTab, query]);
  const summary = useMemo(() => bookSummary(visibleRows), [visibleRows]);
  const orderHistoryCount = useMemo(() => orderRows.filter((row) => !isOpenOrder(row)).length, [orderRows]);
  const columns = useMemo(() => bookDisplayColumns(bookTab), [bookTab]);

  return (
    <section className="book-view">
      <header className="book-top-tabs" aria-label="Order sections">
        <div className="book-tabs" role="tablist" aria-label="Order book tabs">
          <button className={bookTab === 'open' ? 'active' : ''} type="button" onClick={() => setBookTab('open')}>Open Orders</button>
          <button className={bookTab === 'history' ? 'active' : ''} type="button" onClick={() => setBookTab('history')}>Order History ({orderHistoryCount})</button>
          <button className={bookTab === 'trades' ? 'active' : ''} type="button" onClick={() => setBookTab('trades')}>Trades</button>
          {['Stock SIP', 'GTT', 'Basket Orders', 'Alerts'].map((label) => (
            <button className="muted" disabled key={label} type="button">{label}</button>
          ))}
        </div>
      </header>

      <div className="book-toolbar">
        <label className="book-search">
          <Search size={18} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" />
        </label>
        <button className="book-filter" type="button" title="Filters">≡</button>
        <div className="book-toolbar-spacer" />
        <PillSelect
          title="Account"
          value={String(clientIndex)}
          onChange={(value) => setClientIndex(Number(value))}
          options={clients.map((client, index) => ({
            value: String(index),
            label: client.alias || client.clientCode || `Client ${index + 1}`,
            pill: client.loggedIn ? 'ON' : 'OFF',
            pillClass: client.loggedIn ? 'pill-idx' : 'pill-eq',
          }))}
        />
        <button className="btn secondary" disabled={loading} type="button" onClick={() => loadBook(undefined, true)}>
          {loading ? 'Loading' : 'Refresh'}
        </button>
      </div>

      <div className="book-summary">
        <div>
          <span className="buy">Total Buy</span>
          <strong>{formatMoney(summary.buyValue)}</strong>
          <em>{summary.buyCount} Transactions</em>
        </div>
        <div>
          <span className="sell">Total Sell</span>
          <strong>{formatMoney(summary.sellValue)}</strong>
          <em>{summary.sellCount} Transactions</em>
        </div>
        <div>
          <span>Today's Charges</span>
          <strong>₹0.00</strong>
          <em>{visibleRows.length} Transactions</em>
        </div>
      </div>

      <div className="book-status">{status}</div>

      <div className="book-table-wrap">
        <table className="book-table">
          <thead>
            <tr>{columns.map((column) => <th key={column}>{bookLabel(column)}</th>)}</tr>
          </thead>
          <tbody>
            {visibleRows.map((row, index) => (
              <tr key={row.orderid || row.order_id || row.tradeid || row.fillid || index}>
                {columns.map((column) => <td key={column}>{renderBookCell(row, column)}</td>)}
              </tr>
            ))}
            {!visibleRows.length && (
              <tr><td className="book-empty" colSpan={Math.max(columns.length, 1)}>No {bookTab === 'trades' ? 'trades' : 'orders'} to show</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function bookDisplayColumns(tab) {
  return tab === 'trades'
    ? ['stock', 'product', 'qty', 'executedPrice', 'orderId', 'time']
    : ['stock', 'product', 'qty', 'placedPrice', 'executedPrice', 'ltp', 'status'];
}

function bookLabel(key) {
  const labels = {
    stock: 'Stock Name',
    product: 'Product Type',
    qty: 'Qty.',
    placedPrice: 'Placed Price',
    executedPrice: 'Executed Price',
    ltp: 'LTP',
    status: 'Status',
    orderId: 'Order ID',
    time: 'Time',
  };
  if (labels[key]) return labels[key];
  return String(key).replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase();
}

function renderBookCell(row, column) {
  if (column === 'stock') return <BookStockCell row={row} />;
  if (column === 'product') return <BookProductCell row={row} />;
  if (column === 'qty') return <BookQtyCell row={row} />;
  if (column === 'placedPrice') return formatOrderPrice(row);
  if (column === 'executedPrice') return <span className="book-price-strong">{formatBookPrice(row.averageprice || row.fillprice)}</span>;
  if (column === 'ltp') return <span className="book-ltp">{formatBookPrice(row.ltp || row.close || row.averageprice || row.fillprice)}</span>;
  if (column === 'status') return <BookStatusCell row={row} />;
  if (column === 'orderId') return formatBookCell(row.orderid || row.order_id);
  if (column === 'time') return formatBookCell(row.exchtime || row.updatetime || row.filltime);
  return formatBookCell(row[column], column);
}

function BookStockCell({ row }) {
  const symbol = String(row.tradingsymbol || row.symbolname || row.symbol || '-');
  const parsed = parseTradingSymbol(symbol);
  return (
    <div className="book-stock-cell">
      <div className="book-stock-line">
        <strong>{parsed.root}</strong>
        {row.exchange && <span className="book-tag exchange">{row.exchange}</span>}
      </div>
      {parsed.detail && (
        <div className="book-stock-sub">
          <span>{parsed.detail}</span>
          {parsed.optionType && <span className={`book-tag option ${parsed.optionType.toLowerCase()}`}>{parsed.optionType}</span>}
        </div>
      )}
    </div>
  );
}

function BookProductCell({ row }) {
  const side = String(row.transactiontype || row.transaction_type || '').toUpperCase();
  const product = compactProductTag(row.producttype || row.product_type || '-');
  const orderType = orderTypeTag(row.ordertype || row.orderType);
  return (
    <div className="book-product-cell">
      {side && <span className={`book-tag side ${side === 'BUY' ? 'buy' : 'sell'}`}>{side}</span>}
      <span className="book-tag product">{product}</span>
      {orderType && <span className={`book-tag ordertype ${orderType.toLowerCase().replace(/[^a-z]/g, '')}`}>{orderType}</span>}
    </div>
  );
}

function compactProductTag(value) {
  const product = String(value || '-').toUpperCase();
  if (product === 'CARRYFORWARD' || product === 'NRML') return 'CF';
  if (product === 'INTRADAY') return 'MIS';
  return product;
}

function BookQtyCell({ row }) {
  const qty = Number(row.quantity || 0) || 0;
  const filled = Number(row.filledshares || row.fillshares || 0) || 0;
  const lotSize = Number(row.lotsize || row.lotSize || row.lot_size || 0) || 0;
  const unit = lotSize > 1 ? 'Lots' : 'Shares';
  return (
    <div className="book-qty-cell">
      <span>{filled}/{qty} {unit}</span>
      {lotSize > 1 && <small>(1 Lot = {lotSize})</small>}
    </div>
  );
}

function BookStatusCell({ row }) {
  const state = String(row.status || row.orderstatus || '').toUpperCase();
  const time = row.updatetime || row.exchtime || row.filltime || '';
  const reason = orderReason(row);
  return (
    <div className="book-status-cell">
      <div className="book-status-main">
        {reason && (
          <span className="book-reason-wrap">
            <button className="book-reason-btn" type="button" aria-label={`Order reason: ${reason}`}>i</button>
            <span className="book-reason-tip" role="tooltip">{renderReasonText(reason)}</span>
          </span>
        )}
        {state ? <span className={`book-status-pill ${state.toLowerCase()}`}>{state}</span> : <span>-</span>}
      </div>
      {time && <small>{String(time)}</small>}
    </div>
  );
}

function orderReason(row) {
  return String(
    row.text ||
    row.rejreason ||
    row.rejectreason ||
    row.rejectionreason ||
    row.reason ||
    row.message ||
    ''
  ).trim();
}

function renderReasonText(reason) {
  const parts = String(reason).split(/(Insufficient Funds|Rs\.?\s*[\d,.]+)/gi);
  return parts.map((part, index) => {
    const important = /^(Insufficient Funds|Rs\.?\s*[\d,.]+)$/i.test(part);
    return important ? <mark key={index}>{part}</mark> : <span key={index}>{part}</span>;
  });
}

function inferOptionType(symbol) {
  const text = String(symbol).toUpperCase();
  if (/\bCE\b|CE$/.test(text)) return 'CE';
  if (/\bPE\b|PE$/.test(text)) return 'PE';
  return '';
}

function parseTradingSymbol(symbol) {
  const text = String(symbol || '-').trim();
  const spaced = text.match(/^([A-Z]+)\s+(.+?)\s+(CE|PE)$/i);
  if (spaced) {
    return { root: spaced[1].toUpperCase(), detail: spaced[2], optionType: spaced[3].toUpperCase() };
  }

  const compact = text.match(/^([A-Z]+)(\d+)(CE|PE)$/i);
  if (compact) {
    const [, root, digits, optionType] = compact;
    const strike = digits.length > 5 ? digits.slice(-5) : digits;
    const prefix = strike ? digits.slice(0, -strike.length) : digits;
    const detail = [formatSymbolCode(prefix), trimStrike(strike)].filter(Boolean).join(' ');
    return { root: root.toUpperCase(), detail, optionType: optionType.toUpperCase() };
  }

  const optionType = inferOptionType(text);
  return { root: optionType ? text.slice(0, -2) : text, detail: '', optionType };
}

function formatSymbolCode(value) {
  if (!value) return '';
  const weekly5 = value.match(/^(\d{2})(\d)(\d{2})$/);
  if (weekly5) return `${weekly5[3]} ${monthName(Number(weekly5[2]))} 20${weekly5[1]}`;
  const weekly6 = value.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (weekly6) return `${weekly6[3]} ${monthName(Number(weekly6[2]))} 20${weekly6[1]}`;
  if (value.length === 5) return `${value.slice(0, 2)} ${value.slice(2, 3)} ${value.slice(3)}`;
  if (value.length === 6) return `${value.slice(0, 2)} ${value.slice(2, 4)} ${value.slice(4)}`;
  return value;
}

function trimStrike(value) {
  return String(value || '').replace(/^0+(?=\d)/, '');
}

function monthName(month) {
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1] || '';
}

// Placed price for an order row, matching what Angel's own order book shows:
//   • LIMIT / SL-LIMIT / SL-MARKET → the order `price` (Angel shows this even for
//     SL-Market, e.g. price 11 while the trigger is 10)
//   • only a trigger, no price → the `triggerprice`
//   • plain MARKET (no price/trigger) → "MKT"
function formatOrderPrice(row) {
  const type = String(row?.ordertype || row?.orderType || '').toUpperCase();
  const price = Number(row?.price) || 0;
  const trigger = Number(row?.triggerprice ?? row?.triggerPrice ?? row?.trigger_price) || 0;
  if (price > 0) return formatBookPrice(price);
  if (trigger > 0) return formatBookPrice(trigger);
  return type && type !== 'MARKET' && type !== 'MKT' ? '-' : 'MKT';
}

// Short tag for an order's type, e.g. STOPLOSS_MARKET → "SL-M", LIMIT → "LMT".
function orderTypeTag(value) {
  const t = String(value || '').toUpperCase();
  if (t === 'STOPLOSS_MARKET') return 'SL-M';
  if (t === 'STOPLOSS_LIMIT') return 'SL';
  if (t === 'LIMIT') return 'LMT';
  if (t === 'MARKET') return 'MKT';
  return t.replace('STOPLOSS_', 'SL-') || '';
}

function formatBookPrice(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num === 0) return '-';
  return num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatBookCell(value, column = '') {
  if (value == null || value === '') return '-';
  if (/status/i.test(column)) {
    const state = String(value).toUpperCase();
    return <span className={`book-status-pill ${state.toLowerCase()}`}>{state}</span>;
  }
  if (/transactiontype/i.test(column)) {
    const side = String(value).toUpperCase();
    return <span className={side === 'BUY' ? 'book-buy' : side === 'SELL' ? 'book-sell' : ''}>{side}</span>;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString('en-IN') : '-';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// An order is "open" (still working) when it's neither filled nor killed. Angel's
// order book uses `status`/`orderstatus` strings; we key off those, but also fall
// back to unfilled shares so a working order still shows even if the status text
// is blank/unexpected. Angel's non-terminal states include: open, open pending,
// trigger pending, validation pending, modified, modify pending, after market
// order req received.
function isOpenOrder(row) {
  const state = String(row?.status ?? row?.orderstatus ?? '').trim().toLowerCase();
  const terminal = ['complete', 'completed', 'executed', 'rejected', 'cancelled', 'canceled', 'cancelled amo'];
  if (terminal.includes(state)) return false;
  // Explicit working/pending states.
  if (/(open|pending|trigger|modif|validation|received|placed)/.test(state)) return true;
  // Fallback: unknown/blank status but shares still unfilled → treat as open.
  const unfilled = Number(row?.unfilledshares ?? row?.unfilledshare);
  if (Number.isFinite(unfilled) && unfilled > 0) return true;
  // Any other non-empty, non-terminal status: keep showing it (permissive).
  return state !== '';
}

function bookSummary(rows) {
  return rows.reduce((acc, row) => {
    // A "transaction" is an EXECUTED fill. Skip cancelled / rejected / open
    // (unfilled) orders so Total Buy/Sell reflect what actually traded — count
    // and value both come from the filled quantity at its average price.
    const filled = Number(row.filledshares ?? row.fillshares ?? 0) || 0;
    if (filled <= 0) return acc;
    const side = String(row.transactiontype || row.transaction_type || '').toUpperCase();
    const price = Number(row.averageprice || row.fillprice || row.price || 0) || 0;
    const value = filled * price;
    if (side === 'BUY') {
      acc.buyCount += 1;
      acc.buyValue += value;
    }
    if (side === 'SELL') {
      acc.sellCount += 1;
      acc.sellValue += value;
    }
    return acc;
  }, { buyCount: 0, sellCount: 0, buyValue: 0, sellValue: 0 });
}

function PositionBookView({ clients, demoMode, onClientSession, active = true }) {
  const [clientIndex, setClientIndex] = useState(0);
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState('Select a logged-in account');
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const loadedRef = useRef(false);

  const loggedInIndexes = useMemo(
    () => clients.map((client, index) => (client.loggedIn ? index : -1)).filter((index) => index >= 0),
    [clients],
  );
  const selectedClient = clients[clientIndex];

  useEffect(() => {
    if (loggedInIndexes.length && !loggedInIndexes.includes(clientIndex)) {
      setClientIndex(loggedInIndexes[0]);
    }
  }, [loggedInIndexes, clientIndex]);

  useEffect(() => {
    loadedRef.current = false;
    setRows([]);
  }, [clientIndex, demoMode]);

  useEffect(() => {
    if (!active || !selectedClient?.loggedIn || demoMode || loadedRef.current) return;
    loadPositions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, clientIndex, selectedClient?.loggedIn, selectedClient?.session?.jwtToken, demoMode]);

  async function loadPositions(force = false) {
    const client = clients[clientIndex];
    if (!client?.loggedIn) {
      setStatus('Log in an account first');
      return;
    }
    if (demoMode) {
      setStatus('Disable demo mode for live positions');
      return;
    }
    if (loadedRef.current && !force) return;

    setLoading(true);
    setStatus('Loading positions...');
    try {
      const response = await fetch('/api/angel/positions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.status === false) throw new Error(body.message || `HTTP ${response.status}`);
      if (body.session?.jwtToken) onClientSession?.(clientIndex, body.session);
      const nextRows = body.positions || [];
      setRows(nextRows);
      loadedRef.current = true;
      setStatus(`${nextRows.length} positions loaded`);
    } catch (error) {
      loadedRef.current = false;
      setStatus(error.message || 'Positions load failed');
    } finally {
      setLoading(false);
    }
  }

  const visibleRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => JSON.stringify(row).toLowerCase().includes(needle));
  }, [rows, query]);

  const summary = useMemo(() => positionSummary(visibleRows), [visibleRows]);

  return (
    <section className="book-view">
      <header className="book-top-tabs" aria-label="Position sections">
        <div className="book-tabs" role="tablist" aria-label="Position book tabs">
          <button className="active" type="button">Position Book</button>
          <button className="muted" disabled type="button">Holdings</button>
          <button className="muted" disabled type="button">Groups</button>
          <button className="muted" disabled type="button">Reports</button>
        </div>
      </header>

      <div className="book-toolbar">
        <label className="book-search">
          <Search size={18} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search positions" />
        </label>
        <button className="book-filter" type="button" title="Filters">≡</button>
        <div className="book-toolbar-spacer" />
        <PillSelect
          title="Account"
          value={String(clientIndex)}
          onChange={(value) => setClientIndex(Number(value))}
          options={clients.map((client, index) => ({
            value: String(index),
            label: client.alias || client.clientCode || `Client ${index + 1}`,
            pill: client.loggedIn ? 'ON' : 'OFF',
            pillClass: client.loggedIn ? 'pill-idx' : 'pill-eq',
          }))}
        />
        <button className="btn secondary" disabled={loading} type="button" onClick={() => loadPositions(true)}>
          {loading ? 'Loading' : 'Refresh'}
        </button>
      </div>

      <div className="book-summary">
        <div>
          <span className="buy">Long Positions</span>
          <strong>{summary.longCount}</strong>
          <em>Net qty above zero</em>
        </div>
        <div>
          <span className="sell">Short Positions</span>
          <strong>{summary.shortCount}</strong>
          <em>Net qty below zero</em>
        </div>
        <div>
          <span>Total P&amp;L</span>
          <strong className={summary.pnl >= 0 ? 'book-buy' : 'book-sell'}>{formatMoney(summary.pnl)}</strong>
          <em>{visibleRows.length} Positions</em>
        </div>
      </div>

      <div className="book-status">{status}</div>

      <div className="book-table-wrap">
        <table className="book-table">
          <thead>
            <tr>
              {['Stock Name', 'Product Type', 'Net Qty.', 'Buy Avg', 'Sell Avg', 'LTP', 'P&L'].map((heading) => <th key={heading}>{heading}</th>)}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, index) => (
              <tr key={positionRowKey(row, index)}>
                <td><BookStockCell row={row} /></td>
                <td><PositionProductCell row={row} /></td>
                <td><PositionQtyCell row={row} /></td>
                <td>{formatBookPrice(positionBuyAvg(row))}</td>
                <td>{formatBookPrice(positionSellAvg(row))}</td>
                <td><span className="book-ltp">{formatBookPrice(positionValue(row, ['ltp', 'LTP', 'lasttradedprice']))}</span></td>
                <td><span className={pnlOf(row) >= 0 ? 'book-buy' : 'book-sell'}>{formatMoney(pnlOf(row))}</span></td>
              </tr>
            ))}
            {!visibleRows.length && (
              <tr><td className="book-empty" colSpan="7">No positions to show</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PositionProductCell({ row }) {
  const qty = Number(row.netqty || row.net_qty || 0);
  const product = compactProductTag(row.producttype || row.product_type || '-');
  return (
    <div className="book-product-cell">
      {qty !== 0 && <span className={`book-tag side ${qty > 0 ? 'buy' : 'sell'}`}>{qty > 0 ? 'LONG' : 'SHORT'}</span>}
      <span className="book-tag product">{product}</span>
    </div>
  );
}

function PositionQtyCell({ row }) {
  const qty = Number(row.netqty || row.net_qty || 0);
  return (
    <div className="book-qty-cell">
      <span className={qty >= 0 ? 'book-buy' : 'book-sell'}>{qty.toLocaleString('en-IN')}</span>
      <small>{row.lotsize ? `Lot ${row.lotsize}` : ''}</small>
    </div>
  );
}

function positionSummary(rows) {
  return rows.reduce((acc, row) => {
    const qty = Number(row.netqty || row.net_qty || 0);
    if (qty > 0) acc.longCount += 1;
    if (qty < 0) acc.shortCount += 1;
    acc.pnl += pnlOf(row);
    return acc;
  }, { longCount: 0, shortCount: 0, pnl: 0 });
}

function pnlOf(row) {
  if (row.pnl != null && row.pnl !== '') return Number(row.pnl) || 0;
  return (Number(row.realised || 0) || 0) + (Number(row.unrealised || 0) || 0);
}

function positionValue(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value != null && value !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
}

function positionBuyAvg(row) {
  const direct = positionValue(row, ['totalbuyavgprice', 'buyavgprice', 'buyAvgPrice', 'buyaverageprice', 'buy_avg_price', 'buyAvg', 'cfbuyavgprice']);
  if (direct) return direct;
  const amount = positionValue(row, ['totalbuyvalue', 'buyamount', 'buyAmount', 'cfbuyamount', 'buy_value', 'buyValue']);
  const qty = Math.abs(positionValue(row, ['totalbuyqty', 'buyqty', 'buyQty', 'buyquantity', 'cfbuyqty']));
  return amount && qty ? amount / qty : 0;
}

function positionSellAvg(row) {
  const direct = positionValue(row, ['totalsellavgprice', 'sellavgprice', 'sellAvgPrice', 'sellaverageprice', 'sell_avg_price', 'sellAvg', 'cfsellavgprice']);
  if (direct) return direct;
  const amount = positionValue(row, ['totalsellvalue', 'sellamount', 'sellAmount', 'cfsellamount', 'sell_value', 'sellValue']);
  const qty = Math.abs(positionValue(row, ['totalsellqty', 'sellqty', 'sellQty', 'sellquantity', 'cfsellqty']));
  return amount && qty ? amount / qty : 0;
}

function positionRowKey(row, fallback) {
  return [
    row.symboltoken,
    row.tradingsymbol,
    row.exchange,
    row.producttype || row.product_type,
    row.netqty || row.net_qty,
    fallback,
  ].filter((value) => value != null && value !== '').join('|');
}

// Fallback strike interval, used only when the live strike ladder can't be
// loaded (offline / not logged in). The chain ladder is always preferred.
function strikeStepFor(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (s === 'BANKNIFTY' || s === 'SENSEX' || s === 'BANKEX') return 100;
  return 50;
}

function marginOrderType(value) {
  const type = String(value || '').toUpperCase();
  return type === 'LIMIT' || type === 'SL' ? 'LIMIT' : 'MARKET';
}

function Strategies({ clients, demoMode, onClientSession }) {
  // Basket legs live here (above the option chain) so Buy/Sell clicks from the
  // chain accumulate into the basket shown on the right.
  const [legs, setLegs] = useState([]);
  // Always-current mirror of legs so async callbacks (resolve) read the LATEST
  // leg — including changes from an earlier resolve still in flight. Capturing
  // the target inside a setLegs updater was racy when expiry AND strike changed
  // back-to-back; the ref makes each resolve see the merged, up-to-date leg.
  const legsRef = useRef([]);
  legsRef.current = legs;
  // Which logged-in client (with its session) the margin/charges calculators
  // should use — the same account that loaded the option chain.
  const [marginClient, setMarginClient] = useState(null);
  // Always-current mirror of the logged-in client so async callbacks (resolve)
  // never read a stale session from a captured closure.
  const marginClientRef = useRef(null);
  marginClientRef.current = marginClient;
  const [margin, setMargin] = useState({ status: 'idle', value: 0, message: '' });
  const [charges, setCharges] = useState({ status: 'idle', value: 0, message: '' });
  // symbol -> [expiries], shared from the option chain so the basket's expiry
  // dropdown can list the alternatives for each leg.
  const [expiryIndex, setExpiryIndex] = useState({});
  // token -> latest tick, mirrored from the option chain's live feed so basket
  // legs show a live LTP. Kept OUT of the leg state on purpose: ticks must not
  // retrigger the (expensive) margin/charges calc — that refreshes on demand.
  const [liveTicks, setLiveTicks] = useState({});
  const liveTicksRef = useRef({});
  liveTicksRef.current = liveTicks;
  // Bumped by the manual "refresh margin" button to force a recompute even when
  // no leg field changed (e.g. to re-price MARKET legs at the current tick).
  const [marginNonce, setMarginNonce] = useState(0);
  const legSeq = useRef(0);

  const addLeg = useCallback((leg) => {
    setLegs((current) => [...current, { ...leg, id: `leg-${++legSeq.current}` }]);
  }, []);

  const updateLeg = useCallback((id, patch) => {
    setLegs((current) => current.map((leg) => (leg.id === id ? { ...leg, ...patch } : leg)));
  }, []);

  // Per-leg monotonic request id, so only the LATEST resolve for a leg applies
  // its result (discards stale/overlapping responses).
  const resolveSeq = useRef({});
  // Cache of full option chains keyed by "SYMBOL|EXPIRY". Changing a leg's
  // expiry loads that expiry's chain once (in the background); strike changes
  // then read the LTP/token straight from the cache — instant, no per-strike
  // backend call, no races.
  const chainCache = useRef({});
  // In-flight chain loads keyed by "SYMBOL|EXPIRY" so a strike change that lands
  // while the same expiry's chain is still loading reuses the one request
  // instead of firing a second identical option-chain call.
  const chainPending = useRef({});

  // Pull a strike's contract (token, ltp, lotSize, etc.) out of a cached chain.
  const lookupFromChain = (chain, strike, optionType) => {
    if (!chain?.strikes?.length) return null;
    const want = Number(strike) || 0;
    // exact strike, else nearest available in this chain window
    let idx = chain.strikes.indexOf(want);
    if (idx < 0) {
      idx = chain.strikes.reduce((best, s, i) =>
        Math.abs(s - want) < Math.abs(chain.strikes[best] - want) ? i : best, 0);
    }
    const isCall = String(optionType).toUpperCase() !== 'PE';
    const ltp = (isCall ? chain.callLtp : chain.putLtp)?.[idx];
    const close = (isCall ? chain.callClose : chain.putClose)?.[idx];
    const token = (isCall ? chain.callTokens : chain.putTokens)?.[idx] || null;
    const tradingSymbol = (isCall ? chain.callSymbols : chain.putSymbols)?.[idx] || null;
    const changePct = (ltp && close) ? Number((((ltp - close) / close) * 100).toFixed(2)) : null;
    return {
      strike: chain.strikes[idx],
      ltp: ltp ?? null,
      close: close ?? null,
      changePct,
      token,
      tradingSymbol,
      exchange: chain.exchange,
      lotSize: chain.lotSize || 1,
    };
  };

  // Fetch (and cache) the full option chain for a symbol+expiry. Reused across
  // strike changes so the LTP for any strike of that expiry is already local.
  const loadExpiryChain = useCallback(async (symbol, expiry) => {
    const key = `${symbol}|${expiry}`;
    if (chainCache.current[key]) return chainCache.current[key];
    if (chainPending.current[key]) return chainPending.current[key]; // reuse in-flight
    const liveClient = marginClientRef.current;
    if (!liveClient?.session?.jwtToken) return null;
    const request = (async () => {
      const res = await fetch('/api/angel/option-chain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: liveClient, symbol, expiry, window: 30 }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status === false) throw new Error(body.message || 'Chain load failed');
      chainCache.current[key] = body;
      return body;
    })();
    chainPending.current[key] = request;
    try {
      return await request;
    } finally {
      delete chainPending.current[key];
    }
  }, []);

  // Re-resolve a leg when a contract-defining field changes (strike/expiry/side).
  // Strategy: on expiry change, background-load that expiry's full chain; then
  // read the new strike's LTP + token from that cached chain. Strike/side changes
  // are then instant local lookups. Falls back to /resolve-leg if uncached.
  const resolveLegContract = useCallback(async (id, changes = {}) => {
    // Read the target from the always-current ref (NOT inside the setLegs
    // updater) so a strike change that lands while an expiry change is still
    // resolving sees the merged leg — both edits are applied, not lost.
    const found = legsRef.current.find((leg) => leg.id === id);
    if (!found) return;
    const target = { ...found, ...changes };
    // Apply the field changes optimistically and mark the leg resolving.
    setLegs((current) => current.map((leg) => (leg.id === id ? { ...leg, ...changes, resolving: true } : leg)));

    const seq = (resolveSeq.current[id] || 0) + 1;
    resolveSeq.current[id] = seq;
    const isLatest = () => resolveSeq.current[id] === seq;
    const finish = (patch) => {
      if (!isLatest()) return;
      setLegs((current) => current.map((leg) => (leg.id === id ? { ...leg, ...patch, resolving: false } : leg)));
    };

    try {
      const key = `${target.symbol}|${target.expiry}`;
      let chain = chainCache.current[key];
      // Need the chain when switching expiry (or when this expiry isn't cached).
      if (!chain) chain = await loadExpiryChain(target.symbol, target.expiry);

      const hit = chain && lookupFromChain(chain, target.strike, target.optionType);
      if (hit && hit.token) {
        finish({
          expiry: target.expiry,
          strike: hit.strike,
          optionType: target.optionType,
          token: hit.token,
          tradingSymbol: hit.tradingSymbol,
          exchange: hit.exchange,
          lotSize: hit.lotSize,
          ltp: hit.ltp,
          close: hit.close,
          changePct: hit.changePct,
          resolveError: null,
        });
        return;
      }

      // Fallback: strike outside the cached window (or no chain) — resolve the
      // single contract directly.
      const liveClient = marginClientRef.current;
      const res = await fetch('/api/angel/resolve-leg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client: liveClient || null,
          symbol: target.symbol,
          expiry: target.expiry,
          strike: Number(target.strike) || 0,
          optionType: target.optionType,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status === false) throw new Error(body.message || 'Contract not found');
      finish({
        expiry: body.expiry || target.expiry,
        strike: body.strike ?? target.strike,
        optionType: body.optionType || target.optionType,
        token: body.token ?? target.token,
        tradingSymbol: body.tradingSymbol ?? target.tradingSymbol,
        exchange: body.exchange || target.exchange,
        lotSize: body.lotSize || target.lotSize,
        ltp: body.ltp ?? null,
        close: body.close ?? null,
        changePct: body.changePct ?? null,
        resolveError: body.quoteError || null,
      });
    } catch (error) {
      console.error('resolve-leg failed:', error);
      finish({ resolveError: error.message || 'Contract not found' });
    }
  }, [loadExpiryChain]);

  // Strike stepper for a leg's ▲/▼ arrows: move to the ADJACENT real strike in
  // this symbol+expiry's ladder — NOT a fixed ±50, which is wrong for BANKNIFTY/
  // SENSEX (100 apart) and most stocks, where +50 lands between valid strikes and
  // snaps back. Uses the cached chain (loading it if needed); if the ladder can't
  // be fetched, falls back to a per-symbol gap.
  const stepStrike = useCallback(async (id, dir) => {
    const leg = legsRef.current.find((l) => l.id === id);
    if (!leg) return;
    const current = Number(leg.strike) || 0;
    const key = `${leg.symbol}|${leg.expiry}`;
    let chain = chainCache.current[key];
    if (!chain) chain = await loadExpiryChain(leg.symbol, leg.expiry).catch(() => null);
    const strikes = chain?.strikes;
    let target;
    if (strikes?.length) {
      // strikes are ascending: first strike above / last strike below the current.
      target = dir > 0 ? strikes.find((s) => s > current) : [...strikes].reverse().find((s) => s < current);
      if (target == null) return; // already at the top/bottom of the ladder
    } else {
      const step = strikeStepFor(leg.symbol);
      target = Math.max(0, current + dir * step);
      if (target === current) return;
    }
    resolveLegContract(id, { strike: target });
  }, [loadExpiryChain, resolveLegContract]);

  // Manual margin/charges refresh. Snapshots the latest live LTP into each leg
  // (so MARKET legs re-price at the current tick) and forces a recompute. Margin
  // deliberately does NOT follow every tick — the user pulls a fresh figure here.
  const refreshMargin = useCallback(() => {
    const ticks = liveTicksRef.current;
    setLegs((current) => current.map((leg) => {
      const tick = leg.token != null ? ticks[leg.token] : null;
      if (!tick || tick.ltp == null) return leg;
      const changePct = (tick.ltp && tick.close)
        ? Number((((tick.ltp - tick.close) / tick.close) * 100).toFixed(2))
        : leg.changePct;
      return { ...leg, ltp: tick.ltp, changePct };
    }));
    setMarginNonce((n) => n + 1);
  }, []);

  // Distinct set of basket-leg contracts to keep live: "exchange|token". A leg
  // on a different expiry/symbol than the on-screen chain has a token the chain
  // feed never subscribed, so without this its LTP would freeze. Recomputed only
  // when the leg tokens actually change (not on every tick / qty edit).
  const legFeedKey = useMemo(() => {
    const seen = new Set();
    for (const leg of legs) {
      if (leg.token != null) seen.add(`${leg.exchange || 'NFO'}|${leg.token}`);
    }
    return [...seen].sort().join(',');
  }, [legs]);

  // Keep the live feed in sync with EXACTLY the basket's current leg tokens.
  // We send the full current set and let the server reconcile: it subscribes new
  // tokens and unsubscribes ones the basket dropped. So when a leg changes strike
  // or expiry, its OLD token is released and only the NEW one stays subscribed —
  // nothing accumulates toward Angel's 1000-token cap. Fires only when the leg
  // token set actually changes (not per tick / qty edit), or on account change.
  useEffect(() => {
    const client = marginClientRef.current;
    const session = client?.session;
    if (!session?.jwtToken || !session?.feedToken) return;

    const items = (legFeedKey ? legFeedKey.split(',') : []).map((pair) => {
      const [exchange, token] = pair.split('|');
      return { exchange, token };
    });

    fetch('/api/angel/basket-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        credentials: {
          jwtToken: session.jwtToken,
          feedToken: session.feedToken,
          apiKey: client.apiKey,
          clientCode: client.clientCode,
        },
        items, // the FULL current basket set; server diffs against the previous
      }),
    }).catch((error) => console.error('basket-tokens sync failed:', error));
  }, [legFeedKey, marginClient]);

  const removeLeg = useCallback((id) => {
    setLegs((current) => current.filter((leg) => leg.id !== id));
  }, []);

  const clearLegs = useCallback(() => setLegs([]), []);

  // Price sent to Angel per leg: the typed price for limit legs, live LTP for
  // market legs. Shared by both the margin and charge calculators.
  const priceFor = (leg) => {
    const orderType = String(leg.priceType || 'MARKET').toUpperCase();
    if (orderType === 'LIMIT' || orderType === 'SL') return Number(leg.price) || 0;
    // MARKET / SL-M: captured ltp, else the LATEST live tick, else the day's close. The
    // tick is read from a REF (not state) so margin does NOT recompute on every
    // tick — it's only consulted when the basket changes or the user hits
    // Refresh, which is enough to give a correct figure instead of 0.
    const tick = leg.token != null ? liveTicksRef.current[leg.token] : null;
    return Number(leg.ltp) || Number(tick?.ltp) || Number(leg.close) || 0;
  };

  // Fields that change the calculated figures. Both margin and charges depend on
  // token/qty/side/product/price; charges also need the per-leg price even on
  // market legs (margin already gets it via priceFor). A checkbox toggle alone
  // never refetches. Stringified so the debounced effect can diff cheaply.
  const calcKey = useMemo(
    () => JSON.stringify(legs.map((leg) => [
      leg.token, leg.exchange, leg.qty, leg.lotSize, leg.action, leg.product,
      leg.priceType, leg.triggerPrice, priceFor(leg),
    ])),
    [legs],
  );

  // Recompute real margin AND charges (debounced together) whenever the relevant
  // inputs or the account change. The margin batch endpoint nets spread benefits
  // across all legs; estimateCharges returns the basket's total brokerage + taxes.
  useEffect(() => {
    if (!legs.length) {
      setMargin({ status: 'idle', value: 0, message: '' });
      setCharges({ status: 'idle', value: 0, message: '' });
      return undefined;
    }
    if (!marginClient?.session?.jwtToken) {
      const msg = 'Load the option chain on a logged-in account to price this basket';
      setMargin({ status: 'error', value: 0, message: msg });
      setCharges({ status: 'error', value: 0, message: msg });
      return undefined;
    }

    let cancelled = false;
    const handle = setTimeout(async () => {
      setMargin((m) => ({ ...m, status: 'loading' }));
      setCharges((c) => ({ ...c, status: 'loading' }));

      const legPayload = legs.map((leg) => ({
        token: leg.token,
        symbol: leg.tradingSymbol,
        exchange: leg.exchange,
        qty: leg.qty,
        lotSize: leg.lotSize,
        price: priceFor(leg),
        triggerPrice: Number(leg.triggerPrice) || 0,
        tradeType: leg.action,
        productType: leg.product,
        orderType: marginOrderType(leg.priceType),
      }));

      const post = (url) => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: marginClient, legs: legPayload }),
      }).then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status === false) throw new Error(body.message || `HTTP ${res.status}`);
        return body;
      });

      const [marginOut, chargesOut] = await Promise.allSettled([
        post('/api/angel/margin'),
        post('/api/angel/charges'),
      ]);
      if (cancelled) return;

      let nextSession = null;
      if (marginOut.status === 'fulfilled') {
        nextSession = marginOut.value.session || nextSession;
        setMargin({ status: 'ready', value: Number(marginOut.value.totalMarginRequired || 0), message: '' });
      } else {
        setMargin({ status: 'error', value: 0, message: marginOut.reason?.message || 'Margin failed' });
      }

      if (chargesOut.status === 'fulfilled') {
        nextSession = chargesOut.value.session || nextSession;
        setCharges({
          status: 'ready',
          value: Number(chargesOut.value.totalCharges || 0),
          breakup: chargesOut.value.breakup || null,
          message: '',
        });
      } else {
        setCharges({ status: 'error', value: 0, breakup: null, message: chargesOut.reason?.message || 'Charges failed' });
      }

      if (nextSession?.jwtToken && nextSession.jwtToken !== marginClientRef.current?.session?.jwtToken) {
        setMarginClient((current) => (current ? { ...current, session: nextSession } : current));
      }
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [calcKey, marginClient, marginNonce]);

  const placeBasket = useCallback(async () => {
    const client = marginClientRef.current;
    if (!client?.session?.jwtToken) throw new Error('Load the option chain on a logged-in account first');
    const selected = legsRef.current.filter((leg) => leg.selected !== false);
    if (!selected.length) throw new Error('Select at least one order');

    const legPayload = selected.map((leg) => ({
      token: leg.token,
      symbol: leg.tradingSymbol,
      exchange: leg.exchange,
      qty: leg.qty,
      lotSize: leg.lotSize,
      price: priceFor(leg),
      triggerPrice: Number(leg.triggerPrice) || 0,
      tradeType: leg.action,
      productType: leg.product,
      orderType: leg.priceType || 'MARKET',
    }));

    const response = await fetch('/api/angel/place-basket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client, legs: legPayload }),
    });
    const body = await response.json().catch(() => ({}));
    if (body.session?.jwtToken) {
      setMarginClient((current) => (current ? { ...current, session: body.session } : current));
      const clientIndex = clients.findIndex((item) => item.clientCode === client.clientCode);
      if (clientIndex >= 0) onClientSession?.(clientIndex, body.session);
    }
    if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
    return body;
  }, [clients, onClientSession]);

  // Basket visibility: hidden until the user adds a leg (clicks B/S on the
  // chain), then it pops up; when the last leg is removed it pops back down.
  // `basketRender` keeps it mounted through the closing animation, `basketOpen`
  // drives the CSS pop state.
  const hasLegs = legs.length > 0;
  const [basketRender, setBasketRender] = useState(hasLegs);
  const [basketOpen, setBasketOpen] = useState(hasLegs);
  useEffect(() => {
    if (hasLegs) {
      setBasketRender(true);
      const id = requestAnimationFrame(() => setBasketOpen(true)); // next frame → animate in
      return () => cancelAnimationFrame(id);
    }
    setBasketOpen(false); // play the pop-down, then unmount after it finishes
    const t = setTimeout(() => setBasketRender(false), 260);
    return () => clearTimeout(t);
  }, [hasLegs]);

  return (
    <section className={`strategies-view${basketRender ? '' : ' no-basket'}`}>
      <OptionChainPanel
        clients={clients}
        demoMode={demoMode}
        onClientSession={onClientSession}
        onAddLeg={addLeg}
        onMarginContext={setMarginClient}
        onExpiryIndex={setExpiryIndex}
        onLiveTicks={setLiveTicks}
      />
      {basketRender && (
        <Basket
          legs={legs}
          name="MY BASKET"
          className={basketOpen ? 'is-open' : 'is-closing'}
          margin={margin}
          charges={charges}
          expiryIndex={expiryIndex}
          liveTicks={liveTicks}
          onUpdateLeg={updateLeg}
          onResolveLeg={resolveLegContract}
          onStepStrike={stepStrike}
          onAddLeg={addLeg}
          onRemoveLeg={removeLeg}
          onRefreshMargin={refreshMargin}
          onPlaceBasket={placeBasket}
          onClear={clearLegs}
          onClose={clearLegs}
        />
      )}
    </section>
  );
}

const OptionChainPanel = React.memo(function OptionChainPanel({ clients, demoMode, onClientSession, onAddLeg, onMarginContext, onExpiryIndex, onLiveTicks }) {
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
  const autoLoadRef = useRef('');

  // High-frequency tick buffering: ticks land in refs synchronously (no React
  // work), and a single rAF loop flushes them to state at most once per frame.
  // This caps re-renders at ~60fps no matter how fast the feed streams.
  const liveRef = useRef({});              // token -> latest tick (live snapshot)
  const spotRef = useRef(null);            // latest spot tick
  const dirtyRef = useRef(false);          // ticks pending since last flush
  const rafRef = useRef(0);

  // Current symbol/expiry/exchange/lotSize mirrored into refs so the memoized
  // onTrade can read them without being re-created on every selection change.
  const symbolRef = useRef('');
  const expiryRef = useRef('');
  const exchangeRef = useRef('NFO');
  const lotSizeRef = useRef(1);

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

  // Only real, logged-in accounts may drive the option chain — never the
  // SIMULATED/demo seed or an account that hasn't authenticated yet.
  const loggedInIndexes = useMemo(
    () => clients.map((client, index) => (client.loggedIn ? index : -1)).filter((index) => index >= 0),
    [clients],
  );

  const expiries = chainIndex[symbol] || [];

  useEffect(() => {
    loadMasterIndex();
  }, []);

  useEffect(() => {
    if (!symbol && symbols.length) setSymbol(symbols[0]);
  }, [symbol, symbols]);

  // Keep the selected account pointed at a logged-in client. If the current
  // pick logs out (or was the simulated seed), jump to the first logged-in one.
  useEffect(() => {
    if (loggedInIndexes.length && !loggedInIndexes.includes(clientIndex)) {
      setClientIndex(loggedInIndexes[0]);
    }
  }, [loggedInIndexes, clientIndex]);

  useEffect(() => {
    if (expiries.length && !expiries.includes(expiry)) setExpiry(expiries[0]);
  }, [expiries, expiry]);

  async function loadMasterIndex() {
    setStatus('Loading master index...');
    try {
      const response = await fetch('/api/angel/master-index');
      const body = await response.json();
      setChainIndex(body);
      onExpiryIndex?.(body); // share symbol→expiries with the basket
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

  // Can this account authenticate? Either it already holds a live JWT, or it has
  // the credentials (API key + PIN + TOTP) for a fresh login.
  const canAuth = (c) => !!(c?.apiKey && (c.session?.jwtToken || (c.pin && c.totpSecret)));

  async function loadChain() {
    if (demoMode) {
      setStatus('Disable demo mode for live option chain');
      return;
    }
    // Drive the chain with the selected account if it can authenticate; else fall
    // back to the first account that can, so the chain works without forcing the
    // user to hand-pick/pre-login an account on the Settings tab.
    let index = clientIndex;
    let client = clients[index];
    if (!canAuth(client)) {
      const found = clients.findIndex(canAuth);
      if (found >= 0) {
        index = found;
        client = clients[found];
        setClientIndex(found);
      }
    }
    if (!client) {
      setStatus('Select a client');
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
    // ── Phase 0: ensure a LIVE SESSION. The chain's live LTP comes from the
    // WebSocket feed, which needs a feedToken — and that only exists once the
    // account is logged in. If it isn't yet, call auto-login on demand here (this
    // is the login the feed depends on), persist the session, then carry on.
    if (!client.session?.jwtToken) {
      setStatus('Logging in...');
      try {
        const result = await liveLogin(client, '/api/angel/auto-login');
        const session = result.session || null;
        if (!session?.jwtToken) throw new Error('no session returned');
        onClientSession(index, session);          // persist up to App (sets loggedIn)
        client = { ...client, loggedIn: true, session };
      } catch (error) {
        setLoading(false);
        autoLoadRef.current = '';                  // allow a retry once creds/session change
        setStatus(`Login failed: ${error.message || 'auto-login'}`);
        return;
      }
    }

    setStatus('Loading option chain...');
    try {
      // ── Phase 1: instant skeleton from OUR scrip master (no Angel round-trip
      // for the ladder). Renders every strike + tokens immediately, then the
      // live feed streams prices in — the same two-phase pattern Angel's own web
      // app uses (all-scrip-options → live). spot/atm come from one cheap quote.
      const skelRes = await fetch('/api/angel/all-scrip-options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client, TradeSymbol: symbol, ExpiryDate: expiry }),
      });
      const skeleton = await skelRes.json().catch(() => ({}));
      if (!skelRes.ok || skeleton.status === false) throw new Error(skeleton.message || `HTTP ${skelRes.status}`);

      // Reset live state for the new chain.
      setLive({});
      onLiveTicks?.({});
      setLiveSpot(null);
      prevRef.current = {};
      liveRef.current = {};
      spotRef.current = null;
      dirtyRef.current = false;

      // The skeleton endpoint logs in if needed and returns the feed block +
      // session (fresh feedToken), so the live feed can start reliably.
      const liveSession = skeleton.session || client.session || null;
      const liveClient = { ...client, session: liveSession };

      // Render the skeleton right away (OI/LTP arrays start empty; live fills them).
      setChain(skeleton);
      onClientSession(index, liveSession);
      onMarginContext?.(liveClient);
      setStatus(`Loaded ${skeleton.symbol} ${skeleton.expiry} (${skeleton.count} scrips)`);
      startLiveFeed(skeleton);

      // ── Phase 2: prices in the BACKGROUND (doesn't block the render above).
      // The ladder is already on screen; this fills LTP/OI/close for every strike
      // (live ticks overlay it during market hours; after hours it's the close).
      // Because the skeleton and this response share the same strike order, we
      // merge by INDEX. Only apply if this is still the chain on screen.
      fetch('/api/angel/chain-prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: liveClient, TradeSymbol: symbol, ExpiryDate: expiry }),
      })
        .then((r) => r.json().catch(() => ({})))
        .then((p) => {
          if (!p || p.status === false || !Array.isArray(p.strikes)) return;
          setChain((current) => {
            // Guard against a stale response for a chain the user already switched away from.
            if (!current || current.symbol !== skeleton.symbol || current.expiry !== skeleton.expiry) return current;
            return {
              ...current,
              spot: p.spot ?? current.spot,
              atm: p.atm ?? current.atm,
              pcr: p.pcr ?? current.pcr ?? 0,
              callOI: p.callOI, putOI: p.putOI,
              callLtp: p.callLtp, putLtp: p.putLtp,
              callClose: p.callClose, putClose: p.putClose,
            };
          });
        })
        .catch(() => { /* prices are best-effort; live feed still fills them */ });
    } catch (error) {
      autoLoadRef.current = ''; // let the auto-loader retry after the transient failure
      setStatus(error.message || 'Option chain failed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!symbol || !expiry || loading || demoMode) return;
    // As long as SOME account can authenticate, auto-load — loadChain logs in on
    // demand, so the user no longer has to pre-login on the Settings tab first.
    if (!clients.some(canAuth)) return;

    const key = `${symbol}|${expiry}`;
    if (autoLoadRef.current === key) return;
    autoLoadRef.current = key;
    loadChain();
  }, [clients, symbol, expiry, loading, demoMode]);

  // Keep refs current so onTrade (memoized with no deps) reads live values.
  symbolRef.current = symbol;
  expiryRef.current = expiry;
  exchangeRef.current = chain?.exchange || 'NFO';
  lotSizeRef.current = Number(chain?.lotSize) || 1;

  // Buy/Sell action buttons — push a leg into the basket. UI only (no order is
  // placed). Memoized with no deps so streaming ticks never re-render the
  // action buttons; current symbol/expiry/exchange/lotSize come from refs.
  // tradingSymbol is the per-strike contract symbol (e.g. NIFTY...CE) needed by
  // the charges estimator; passed through from the clicked row.
  const onTrade = useCallback((side, action, strike, token, ltp, changePct, tradingSymbol, close) => {
    onAddLeg?.({
      symbol: symbolRef.current,
      tradingSymbol: tradingSymbol || null,
      expiry: expiryRef.current,
      exchange: exchangeRef.current,
      lotSize: lotSizeRef.current,
      strike,
      optionType: side === 'call' ? 'CE' : 'PE',
      action,                 // 'BUY' | 'SELL'
      product: 'CF',
      qty: 1,                 // in LOTS; server multiplies by lotSize for units
      price: '',
      priceType: 'MARKET',
      ltp: ltp ?? null,
      close: close ?? null,   // day's close — LTP fallback when no live tick
      changePct: changePct ?? null,
      token: token ?? null,
      selected: true,
    });
    setStatus(`${action} ${side.toUpperCase()} ${strike} added to basket`);
  }, [onAddLeg]);

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
      const snapshot = { ...liveRef.current };
      setLive(snapshot);
      // Share the same tick snapshot with the basket so its legs' LTP ticks live.
      onLiveTicks?.(snapshot);
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
    return nearestStrike(strikes, price);
  }, [liveSpot, chain]);

  const snapshotAtm = useMemo(() => {
    const value = Number(chain?.atm || 0);
    if (value > 0) return value;
    const spot = Number(chain?.spot || 0);
    if (spot > 0 && chain?.strikes?.length) return nearestStrike(chain.strikes, spot);
    return null;
  }, [chain]);

  // The ATM the table renders against — live value when the spot feed is up,
  // else the snapshot from load. Drives the ATM box, the highlighted ATM row and
  // the ITM shading, so all three shift together as the underlying moves.
  const atm = liveAtm ?? snapshotAtm;
  const hasAtm = atm != null && atm > 0;

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
        <PillSelect
          title="Symbol"
          searchable
          searchPlaceholder="Search underlying..."
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
            {formatSpot(liveSpot?.ltp ?? chain?.spot)}
          </strong>
        </span>
        <span>ATM <strong className={liveAtm && snapshotAtm && liveAtm !== snapshotAtm ? 'atm-shifted' : ''}>{hasAtm ? atm : '-'}</strong></span>
        <span>PCR <strong>{Number(chain?.pcr || 0).toFixed(2)}</strong></span>
      </div>

      <div className="chain-table-wrap">
        <table className="chain-table">
          <colgroup>
            <col className="col-oi" />
            <col className="col-chg" />
            <col className="col-ltp" />
            <col className="col-action" />
            <col className="col-strike" />
            <col className="col-action" />
            <col className="col-ltp" />
            <col className="col-chg" />
            <col className="col-oi" />
          </colgroup>
          <thead>
            <tr className="chain-side-head">
              <th className="side-call" colSpan="4">CALL</th>
              <th className="side-strike">STRIKE</th>
              <th className="side-put" colSpan="4">PUT</th>
            </tr>
            <tr>
              <th>OI</th>
              <th>Chng%</th>
              <th className="ltp-head">LTP</th>
              <th>Action</th>
              <th>Strike</th>
              <th>Action</th>
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
                  isAtm={hasAtm && strike === atm}
                  callItm={hasAtm && strike < atm}
                  putItm={hasAtm && strike > atm}
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
                  callToken={chain.callTokens?.[index] || null}
                  putToken={chain.putTokens?.[index] || null}
                  callSymbol={chain.callSymbols?.[index] || null}
                  putSymbol={chain.putSymbols?.[index] || null}
                  onTrade={onTrade}
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
    </aside>
  );
});

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
  callDir, putDir, callAt, putAt, callToken, putToken,
  callSymbol, putSymbol, onTrade, maxOi,
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
      <td className={`ltp call-ltp${callItm ? ' itm-call' : ''}${callDir ? ` flash-${callDir}` : ''}`} key={`cl-${callAt}`}>
        <span className="ltp-val">{formatPrice(callLtp)}</span>
      </td>
      <td className={`action call-action${callItm ? ' itm-call' : ''}`}>
        <TradeActions side="call" strike={strike} token={callToken} symbol={callSymbol} ltp={callLtp} chg={callChg} close={callClose} onTrade={onTrade} />
      </td>
      <td className="strike">{strike}</td>
      <td className={`action put-action${putItm ? ' itm-put' : ''}`}>
        <TradeActions side="put" strike={strike} token={putToken} symbol={putSymbol} ltp={putLtp} chg={putChg} close={putClose} onTrade={onTrade} />
      </td>
      <td className={`ltp put-ltp${putItm ? ' itm-put' : ''}${putDir ? ` flash-${putDir}` : ''}`} key={`pl-${putAt}`}>
        <span className="ltp-val">{formatPrice(putLtp)}</span>
      </td>
      <td className={`chg ${chgClass(putChg)}${putItm ? ' itm-put' : ''}`}>{formatChange(putChg)}</td>
      <td className={`oi put-oi${putItm ? ' itm-put' : ''}`}>
        <span className="oi-bar" style={{ width: `${putWidth}%` }} />
        <span className="oi-val">{formatQty(putOi)}</span>
      </td>
    </tr>
  );
});

// Always-visible Buy/Sell pair in the Action column. Memoized on stable props
// (side/strike/token/onTrade) so live ticks never re-render the buttons — the
// streaming ltp/chg are mirrored into refs and only read at click time, so they
// don't count toward the memo's shallow compare.
// Default React.memo (shallow compare): the buttons re-render when ltp/chg
// change so a click always captures the CURRENT live price for the basket leg.
// These are two tiny buttons, so per-tick re-rendering is cheap.
const TradeActions = React.memo(function TradeActions({ side, strike, token, symbol, ltp, chg, close, onTrade }) {
  const label = side === 'call' ? 'Call' : 'Put';
  const disabled = !token;
  return (
    <div className="trade-actions" role="group" aria-label={`${label} actions`}>
      <button
        className="trade-btn buy"
        type="button"
        title={`Buy ${label} ${strike}`}
        disabled={disabled}
        onClick={() => onTrade?.(side, 'BUY', strike, token, ltp, chg, symbol, close)}
      >B</button>
      <button
        className="trade-btn sell"
        type="button"
        title={`Sell ${label} ${strike}`}
        disabled={disabled}
        onClick={() => onTrade?.(side, 'SELL', strike, token, ltp, chg, symbol, close)}
      >S</button>
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
function PillSelect({ title, value, onChange, options, searchable = false, searchPlaceholder = 'Search...' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef(null);
  const searchRef = useRef(null);
  const selected = options.find((o) => o.value === value);

  // Case-insensitive filter over the option label/value when searching.
  const visibleOptions = useMemo(() => {
    if (!searchable || !query.trim()) return options;
    const needle = query.trim().toLowerCase();
    return options.filter((o) =>
      String(o.label).toLowerCase().includes(needle) || String(o.value).toLowerCase().includes(needle));
  }, [options, query, searchable]);

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

  // Reset the query each time the menu closes, and focus the search box when it
  // opens so the user can type immediately.
  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    if (searchable) {
      const id = requestAnimationFrame(() => searchRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    return undefined;
  }, [open, searchable]);

  function pick(optionValue) {
    onChange(optionValue);
    setOpen(false);
  }

  // Enter in the search box selects the first match — quick keyboard flow.
  function onSearchKeyDown(event) {
    if (event.key === 'Enter' && visibleOptions.length) {
      event.preventDefault();
      pick(visibleOptions[0].value);
    }
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
        <div className="pill-select-menu" role="listbox">
          {searchable && (
            <div className="pill-select-search">
              <Search className="pill-select-search-icon" size={14} aria-hidden="true" />
              <input
                ref={searchRef}
                type="text"
                className="pill-select-search-input"
                placeholder={searchPlaceholder}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKeyDown}
              />
              {query && (
                <button
                  type="button"
                  className="pill-select-search-clear"
                  title="Clear search"
                  onClick={() => { setQuery(''); searchRef.current?.focus(); }}
                ><X size={13} /></button>
              )}
            </div>
          )}
          <ul className="pill-select-list">
            {visibleOptions.map((option) => (
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
            {!visibleOptions.length && (
              <li className="pill-select-empty">No matches for "{query}"</li>
            )}
          </ul>
        </div>
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

// upstoxLogin drives the Upstox OAuth flow. It first asks the backend to reuse a
// same-day token; if none exists the backend returns {needsLogin, loginUrl}, so
// we open that URL in a popup, wait for the /api/upstox/callback page to
// postMessage success back, then re-run auto-login to pick up the fresh token.
// Result shape matches liveLogin so runAutoLogin treats both brokers uniformly.
async function upstoxLogin(client) {
  // Per-account OAuth state so the backend can match the popup callback to the
  // account's credentials (mirrors how Angel sends creds in the request body).
  const state = `${client.clientCode || 'upstox'}-${Date.now()}`;
  const attempt = async (userId = client.clientCode) => {
    const response = await fetchWithTimeout('/api/upstox/auto-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        state,
        // Upstox app credentials come straight from the account row — like Angel,
        // the backend uses what the frontend sends (no env vars needed).
        apiKey: client.apiKey || '',
        apiSecret: client.apiSecret || '',
        // When Auto Login is ticked the backend drives Upstox's login page with
        // Selenium (mobile → TOTP → PIN, fully automated); otherwise it returns
        // a loginUrl for the OAuth popup below.
        autoLogin: !!client.autoLogin,
        phone: client.phone || '',
        pin: client.pin || '',
        totpSecret: client.totpSecret || '',
      }),
    }, 150000, 'Upstox login timed out. Check Chrome/Selenium is installed and Upstox credentials are correct.');
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
    return body;
  };

  let body = await attempt();
  if (body.needsLogin && body.loginUrl) {
    const userId = await openUpstoxPopup(body.loginUrl); // callback returns Upstox's canonical user_id
    body = await attempt(userId || client.clientCode);   // token now stored server-side
  }
  if (body.status === false) throw new Error(body.message || 'Upstox login failed');

  const eq = body.data?.equity || {};
  const sessionSource = body.fundsAvailable === false
    ? `${body.sessionSource || 'live'} (funds closed)`
    : body.sessionSource;
  return {
    availableMargin: body.availableMargin ?? eq.available_margin ?? 0,
    availableCash: eq.available_margin ?? 0,
    collateral: eq.notional_cash ?? 0,
    utilisedPayout: eq.used_margin ?? 0,
    sessionSource,
    session: body.session || null,
    mtmAll: 0,
    misMtm: 0,
    nrmlMtm: 0,
  };
}

// openUpstoxPopup opens the Upstox OAuth page and resolves once its callback
// posts back a success message (or rejects on failure / if the user closes it).
function openUpstoxPopup(loginUrl) {
  return new Promise((resolve, reject) => {
    const popup = window.open(loginUrl, 'upstox-login', 'width=480,height=720');
    if (!popup) {
      reject(new Error('Popup blocked — allow popups for Upstox login'));
      return;
    }
    const onMessage = (event) => {
      const data = event.data;
      if (!data || data.source !== 'upstox-oauth') return;
      cleanup();
      if (data.success) resolve(data.detail);
      else reject(new Error(data.detail || 'Upstox login failed'));
    };
    const closedTimer = window.setInterval(() => {
      if (popup.closed) {
        cleanup();
        reject(new Error('Login window closed before completing'));
      }
    }, 700);
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Upstox popup login timed out. Complete the popup login within 3 minutes or enable Auto Login with Phone, PIN and TOTP Secret.'));
    }, 180000);
    function cleanup() {
      window.removeEventListener('message', onMessage);
      window.clearInterval(closedTimer);
      window.clearTimeout(timeout);
      try { popup.close(); } catch (e) { /* already closed */ }
    }
    window.addEventListener('message', onMessage);
  });
}

async function fetchWithTimeout(url, options, timeoutMs, message) {
  const controller = new AbortController();
  const id = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(message || 'Request timed out');
    throw error;
  } finally {
    window.clearTimeout(id);
  }
}

// kotakLogin runs the Kotak NEO V3 fully-headless Login-with-TOTP flow. The
// backend generates the TOTP from the stored secret and does tradeApiLogin →
// tradeApiValidate server-side — no browser, no popup. Row fields map as:
//   apiKey → NEO access token, phone → mobileNumber (with ISD),
//   clientCode → UCC, pin → MPIN, totpSecret → TOTP secret.
// Result shape matches liveLogin so runAutoLogin treats all brokers uniformly.
async function kotakLogin(client) {
  // Kotak's NEO access token can be typed in either the API KEY or API SECRET
  // box (the column labels don't map 1:1 to Kotak), so accept whichever is set.
  const accessToken = client.apiKey || client.apiSecret || '';
  const payload = {
    accessToken,
    mobileNumber: client.phone || '',
    ucc: client.clientCode || '',
    mpin: client.pin || '',
    totpSecret: client.totpSecret || '',
  };
  // Name the exact missing field(s) up front, so the user isn't left guessing
  // which off-screen column is blank.
  const labels = {
    accessToken: 'API Key (Kotak access token)',
    mobileNumber: 'Phone (with ISD, e.g. +91…)',
    ucc: 'User ID (UCC)',
    mpin: 'PIN (MPIN)',
    totpSecret: 'TOTP Secret',
  };
  const missing = Object.keys(labels).filter((k) => !payload[k]);
  if (missing.length) throw new Error(`Fill in: ${missing.map((k) => labels[k]).join(', ')}`);

  const response = await fetch('/api/kotak/auto-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status === false) throw new Error(body.message || `HTTP ${response.status}`);

  return {
    availableMargin: body.availableMargin ?? 0,
    availableCash: 0,
    collateral: 0,
    utilisedPayout: 0,
    sessionSource: body.sessionSource,
    session: body.session || null,
    mtmAll: 0,
    misMtm: 0,
    nrmlMtm: 0,
  };
}

// nubraLogin follows Nubra's full-automation model: keep the shared TOTP secret
// once, then generate fresh login TOTPs server-side on every login. API Secret
// is used only as a one-time setup session token when the TOTP secret is absent
// or the saved secret is rejected.
async function nubraLogin(client) {
  const basePayload = {
    phone: client.phone || '',
    mpin: client.pin || '',
    totpSecret: client.totpSecret || '',
    clientCode: client.clientCode || '',
  };
  const labels = {
    phone: 'Phone',
    mpin: 'PIN (MPIN)',
  };
  const missing = Object.keys(labels).filter((k) => !basePayload[k]);
  if (missing.length) throw new Error(`Fill in: ${missing.map((k) => labels[k]).join(', ')}`);

  let generatedSecret = '';
  let sessionSourceHint = '';
  let payload = basePayload;

  if (!payload.totpSecret && client.apiSecret) {
    const setup = await nubraSetupTOTP(client);
    generatedSecret = setup.totpSecret || '';
    if (!generatedSecret) throw new Error('Nubra TOTP setup did not return a TOTP secret');
    payload = { ...basePayload, totpSecret: generatedSecret };
    sessionSourceHint = 'totp-setup';
  } else if (!payload.totpSecret) {
    throw new Error('Fill in: TOTP Secret, or paste Nubra first-time session token in API Secret');
  }

  try {
    return await nubraAutoLoginPayload(payload, generatedSecret, sessionSourceHint);
  } catch (error) {
    if (!client.apiSecret || generatedSecret || !looksLikeTOTPError(error)) throw error;
    const setup = await nubraSetupTOTP(client);
    generatedSecret = setup.totpSecret || '';
    if (!generatedSecret) throw error;
    return nubraAutoLoginPayload({ ...basePayload, totpSecret: generatedSecret }, generatedSecret, 'totp-setup');
  }
}

async function nubraSetupTOTP(client) {
  const response = await fetch('/api/nubra/totp/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionToken: client.apiSecret || '',
      mpin: client.pin || '',
      phone: client.phone || '',
      clientCode: client.clientCode || '',
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status === false) throw new Error(body.message || `HTTP ${response.status}`);
  return body;
}

async function nubraAutoLoginPayload(payload, generatedSecret = '', sessionSourceHint = '') {
  const response = await fetch('/api/nubra/auto-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status === false) throw new Error(body.message || `HTTP ${response.status}`);

  return {
    availableMargin: body.availableMargin ?? 0,
    availableCash: body.availableMargin ?? 0,
    collateral: 0,
    utilisedPayout: 0,
    sessionSource: sessionSourceHint || body.sessionSource,
    session: body.session || null,
    totpSecret: generatedSecret,
    clearSetupToken: !!generatedSecret,
    mtmAll: 0,
    misMtm: 0,
    nrmlMtm: 0,
  };
}

function looksLikeTOTPError(error) {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('totp') || message.includes('otp') || message.includes('invalid');
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

function formatSpot(value) {
  const number = Number(value || 0);
  return number > 0 ? formatMoney(number) : '-';
}

function nearestStrike(strikes = [], price) {
  const number = Number(price || 0);
  if (!number || !strikes.length) return null;
  return strikes.reduce((best, s) => (Math.abs(s - number) < Math.abs(best - number) ? s : best), strikes[0]);
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

const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(<App />);
