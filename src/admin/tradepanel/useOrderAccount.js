import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiGet, brokerAutoLogin } from '../config/api';
import {
  brokerApiPath,
  buildClient,
  getSavedSession,
  saveSession,
} from '../feedmaster/feedMasterStore';

const ORDER_BROKERS = new Set(['angel', 'kotak', 'zerodha']);

export function useOrderAccount() {
  const [users, setUsers] = useState([]);
  const [userId, setUserId] = useState('');
  const [configs, setConfigs] = useState([]);
  const [configId, setConfigId] = useState('');
  const [client, setClient] = useState(null);
  const [status, setStatus] = useState('Select an order account');

  useEffect(() => {
    let cancelled = false;
    apiGet('/users/list').then((out) => {
      if (cancelled) return;
      const list = out.data || [];
      setUsers(list);
      setUserId((current) => current || (list[0]?.id ? String(list[0].id) : ''));
    }).catch((err) => setStatus(err.message || 'Failed to load users'));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setConfigs([]);
    setConfigId('');
    setClient(null);
    if (!userId) return;
    let cancelled = false;
    apiGet(`/users/broker-config/list?user_id=${userId}`).then((out) => {
      if (cancelled) return;
      const supported = (out.data || []).filter((config) => ORDER_BROKERS.has(brokerApiPath(config.broker_name)));
      setConfigs(supported);
      if (supported[0]?.id) setConfigId(String(supported[0].id));
      setStatus(supported.length ? 'Loading order account…' : 'No Angel, Kotak, or Zerodha account configured');
    }).catch((err) => setStatus(err.message || 'Failed to load broker accounts'));
    return () => { cancelled = true; };
  }, [userId]);

  useEffect(() => {
    setClient(null);
    if (!configId) return;
    let cancelled = false;
    setStatus('Loading order credentials…');
    apiGet(`/users/broker-config/get?id=${configId}`).then((out) => {
      if (cancelled) return;
      const config = out.data || null;
      const next = buildClient(config, getSavedSession(configId));
      setClient(next);
      setStatus(next?.loggedIn ? 'Order account session ready' : 'Order account ready — login occurs before placement');
    }).catch((err) => setStatus(err.message || 'Failed to load order credentials'));
    return () => { cancelled = true; };
  }, [configId]);

  const broker = useMemo(() => brokerApiPath(client?.broker), [client?.broker]);

  const handleSession = useCallback((session) => {
    if (!session) return;
    setClient((current) => current ? { ...current, session, loggedIn: true } : current);
    if (configId) saveSession(configId, session);
    setStatus('Order account logged in — live');
  }, [configId]);

  const ensureLogin = useCallback(async () => {
    if (!client) throw new Error('Select an order account');
    const path = brokerApiPath(client.broker);
    const result = await brokerAutoLogin(path, client);
    if (result.needsLogin) {
      throw new Error(`${client.broker || path} needs browser login from Users → Broker Configuration`);
    }
    if (!result.status || !result.session) throw new Error(result.message || `${client.broker || path} login failed`);
    handleSession(result.session);
    return { client: { ...client, session: result.session, loggedIn: true }, broker: path, result };
  }, [client, handleSession]);

  return {
    users, userId, setUserId,
    configs, configId, setConfigId,
    client, broker, status,
    ensureLogin, handleSession,
  };
}
