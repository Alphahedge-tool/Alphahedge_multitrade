// Shared Angel account picker state, used by both Enter Trade (option chain +
// basket) and Get Position. Hydrates a single logged-in `client` from a user's
// Angel broker config (the rows managed in Users -> Broker Configuration).
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet } from '../config/api';

export function useAngelAccount() {
  const [users, setUsers] = useState([]);
  const [userId, setUserId] = useState('');
  const [configs, setConfigs] = useState([]); // Angel configs for the selected user
  const [configId, setConfigId] = useState('');
  const [client, setClient] = useState(null); // hydrated client creds (single account)
  const [accStatus, setAccStatus] = useState('Select a user and Angel account');
  const [loginNotice, setLoginNotice] = useState({ open: false, message: '' });
  const lastNotifiedJwtRef = useRef('');

  // Load users ONCE on mount. Note: no `client` dependency — otherwise selecting
  // a user (which hydrates a client and changes its alias) would re-run this and
  // reset the selection back to list[0], snapping your pick back to the first
  // user. The default user is only chosen when none is selected yet.
  useEffect(() => {
    let cancelled = false;
    apiGet('/users/list')
      .then((usersOut) => {
        if (cancelled) return;
        const list = usersOut.data || [];
        setUsers(list);
        if (!list.length) { setAccStatus('No users available'); return; }
        // Only auto-select a default when the user hasn't chosen one.
        setUserId((prev) => {
          if (prev) return prev; // keep the user's current selection
          const first = list[0];
          if (first?.id) setAccStatus(`Loading Angel accounts for ${first.username || 'selected user'}...`);
          return first?.id ? String(first.id) : '';
        });
      })
      .catch(() => setAccStatus('Failed to load users'));

    return () => { cancelled = true; };
  }, []);

  // Load the selected user's Angel broker configs.
  useEffect(() => {
    if (!userId) {
      setConfigs([]);
      setConfigId('');
      return;
    }
    setConfigs([]);
    setConfigId('');
    setClient(null);
    apiGet(`/users/broker-config/list?user_id=${userId}`)
      .then((res) => {
        const angel = (res.data || []).filter((c) =>
          String(c.broker_name || '').toLowerCase().replace(/\s/g, '').includes('angel')
        );
        setConfigs(angel);
        if (angel.length > 0) {
          setConfigId(String(angel[0].id));
          setAccStatus('Loading first Angel account...');
        } else {
          setAccStatus('No Angel account configured for this user');
        }
      })
      .catch(() => setAccStatus('Failed to load broker configs'));
  }, [userId]);

  // Hydrate full credentials when an account is chosen.
  useEffect(() => {
    if (!configId) {
      setClient(null);
      return;
    }
        setAccStatus('Loading credentials...');
    apiGet(`/users/broker-config/get?id=${configId}`)
      .then((res) => {
        const c = res.data || {};
        if (!c.account_id || !c.app_key || !c.pin || !c.totp_secret) {
          setClient(null);
          setAccStatus('This Angel config is missing Client Code / PIN / TOTP / API Key - edit it in Users.');
          return;
        }
        const user = users.find((u) => String(u.id) === String(userId));
        setClient({
          enabled: true,
          alias: `${user?.username || 'user'} - ${c.account_id}`,
          clientCode: c.account_id,
          apiKey: c.app_key,
          pin: c.pin,
          totpSecret: c.totp_secret,
          loggedIn: false,
          session: null,
        });
        setAccStatus('Account ready');
      })
      .catch(() => {
        setClient(null);
        setAccStatus('Failed to load credentials');
      });
  }, [configId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist the live session back onto the client so re-loads reuse it.
  const handleClientSession = useCallback((_index, session) => {
    setClient((c) => (c ? { ...c, session, loggedIn: !!session?.jwtToken } : c));
    if (session?.jwtToken) {
      setAccStatus('Logged in - live');
      if (lastNotifiedJwtRef.current !== session.jwtToken) {
        lastNotifiedJwtRef.current = session.jwtToken;
        setLoginNotice({
          open: true,
          message: `${client?.alias || session.clientCode || 'Angel account'} logged in successfully`,
        });
      }
    }
  }, []);

  const clients = client ? [client] : [];

  return {
    users, userId, setUserId,
    configs, configId, setConfigId,
    client, clients, accStatus, setAccStatus,
    handleClientSession,
    loginNotice,
    clearLoginNotice: () => setLoginNotice({ open: false, message: '' }),
  };
}

function findLoggedInUser(users, principal = {}) {
  const candidates = [
    principal.id,
    principal.user_id,
    principal.userId,
    principal.admin_id,
  ].filter((value) => value != null).map(String);

  if (candidates.length) {
    const byId = users.find((u) => candidates.includes(String(u.id)));
    if (byId) return byId;
  }

  const names = [
    principal.username,
    principal.user_name,
    principal.email,
  ].filter(Boolean).map((value) => String(value).toLowerCase());

  if (!names.length) return null;
  return users.find((u) => {
    const username = String(u.username || '').toLowerCase();
    const email = String(u.email || '').toLowerCase();
    return names.includes(username) || names.includes(email);
  }) || null;
}
