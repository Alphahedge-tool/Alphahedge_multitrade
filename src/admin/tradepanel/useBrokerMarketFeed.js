import { useEffect, useMemo, useRef, useState } from 'react';

const KOTAK_MAX_INSTRUMENTS = 200;

function instrumentKey(item) {
  return `${String(item.exchange || '').toUpperCase()}|${String(item.token || '')}`;
}

export function useBrokerMarketFeed({ broker, instruments, enabled }) {
  const [status, setStatus] = useState('offline');
  const [ticks, setTicks] = useState({});
  const previousRef = useRef({});
  const itemsKey = useMemo(() => {
    const unique = new Map();
    for (const item of instruments || []) {
      if (!item?.token || !item?.exchange) continue;
      unique.set(instrumentKey(item), {
        exchange: String(item.exchange).toUpperCase(),
        token: String(item.token),
        symbol: item.symbol || '',
      });
      if (String(broker).toLowerCase() === 'kotak' && unique.size >= KOTAK_MAX_INSTRUMENTS) break;
    }
    return JSON.stringify([...unique.values()].sort((a, b) => instrumentKey(a).localeCompare(instrumentKey(b))));
  }, [broker, instruments]);
  const active = Boolean(enabled && broker && itemsKey !== '[]');

  useEffect(() => {
    if (!active) {
      setStatus('offline');
      return undefined;
    }

    const wanted = JSON.parse(itemsKey);
    const wantedKeys = new Set(wanted.map(instrumentKey));
    let socket = null;
    let retryTimer = 0;
    let attempts = 0;
    let stopped = false;

    const schedule = () => {
      if (stopped || retryTimer) return;
      const delay = Math.min(1000 * (2 ** attempts), 15000);
      attempts += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = 0;
        connect();
      }, delay);
    };

    const connect = () => {
      if (stopped) return;
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      setStatus('connecting');
      socket = new WebSocket(`${protocol}://${window.location.host}/ws/feed`);
      socket.onopen = () => {
        attempts = 0;
        socket.send(JSON.stringify({
          action: 'subscribe', broker, mode: 2, instruments: wanted,
        }));
      };
      socket.onmessage = (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'welcome') {
          const brokerState = message.brokers?.[broker];
          setStatus(brokerState?.connected ? 'live' : brokerState?.running ? 'connecting' : 'offline');
          return;
        }
        if (message.type === 'feed_status' && message.broker === broker) {
          setStatus(message.connected ? 'live' : 'offline');
          return;
        }
        if (message.type === 'subscribed' && message.broker === broker) {
          setStatus((current) => current === 'live' ? current : 'connecting');
          return;
        }
        if (message.type === 'error' && (!message.broker || message.broker === broker)) {
          setStatus('offline');
          return;
        }
        if (message.type !== 'tick' || message.broker !== broker) return;
        const key = instrumentKey(message);
        if (!wantedKeys.has(key) || !(Number(message.ltp) > 0)) return;
        const ltp = Number(message.ltp);
        const previous = previousRef.current[key];
        const dir = previous == null ? '' : ltp > previous ? 'up' : ltp < previous ? 'down' : '';
        previousRef.current[key] = ltp;
        setStatus('live');
        setTicks((current) => ({ ...current, [key]: { ...message, ltp, dir } }));
      };
      socket.onerror = () => setStatus('offline');
      socket.onclose = () => {
        if (stopped) return;
        setStatus('offline');
        schedule();
      };
    };

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(retryTimer);
      try { socket?.close(); } catch { /* already closed */ }
    };
  }, [active, broker, itemsKey]);

  return { status, ticks };
}
