import { useEffect, useRef, useState } from 'react';

const RETRY_MAX_MS = 15000;

function parseSseChunk(chunk, handlers) {
  if (!chunk) return;
  let event = 'message';
  let data = '';
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  let payload = null;
  try { payload = data ? JSON.parse(data) : null; } catch { payload = { raw: data }; }
  if (event === 'order') handlers.onOrder?.(payload);
  else if (event === 'position') handlers.onPosition?.(payload);
  else if (event === 'status') handlers.onStatus?.(payload);
  else if (event === 'error') handlers.onError?.(payload);
}

async function readSse(body, handlers) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      parseSseChunk(buffer.slice(0, boundary).trim(), handlers);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
    }
  }
}

export function useKotakPortfolioStream({ enabled, client, onOrder, onPosition, onResync }) {
  const [status, setStatus] = useState('offline');
  const clientRef = useRef(client);
  const onOrderRef = useRef(onOrder);
  const onPositionRef = useRef(onPosition);
  const onResyncRef = useRef(onResync);

  useEffect(() => { clientRef.current = client; }, [client]);
  useEffect(() => { onOrderRef.current = onOrder; }, [onOrder]);
  useEffect(() => { onPositionRef.current = onPosition; }, [onPosition]);
  useEffect(() => { onResyncRef.current = onResync; }, [onResync]);

  const session = client?.session;
  const active = Boolean(enabled && session?.tradeToken && session?.sid && session?.baseUrl);
  const streamKey = `${session?.tradeToken || ''}|${session?.sid || ''}|${session?.dataCenter || session?.baseUrl || ''}`;

  useEffect(() => {
    if (!active) {
      setStatus('offline');
      return undefined;
    }
    let stopped = false;
    let controller = null;
    let retryTimer = 0;
    let retries = 0;
    let connectedOnce = false;
    let connectionLive = false;

    const schedule = () => {
      if (stopped || retryTimer) return;
      const delay = Math.min(1000 * (2 ** retries), RETRY_MAX_MS);
      retries += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = 0;
        connect();
      }, delay);
    };

    const markLive = () => {
      if (connectionLive) return;
      connectionLive = true;
      setStatus('live');
      retries = 0;
      if (connectedOnce) onResyncRef.current?.();
      connectedOnce = true;
    };

    const connect = async () => {
      if (stopped) return;
      controller = new AbortController();
      setStatus('connecting');
      try {
        const response = await fetch('/api/kotak/portfolio-stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client: clientRef.current }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`Portfolio stream HTTP ${response.status}`);
        await readSse(response.body, {
          onOrder: (payload) => { markLive(); onOrderRef.current?.(payload); },
          onPosition: (payload) => { markLive(); onPositionRef.current?.(payload); },
          onStatus: (payload) => {
            if (payload?.connected === false || payload?.status === false) {
              connectionLive = false;
              setStatus('offline');
            }
            else markLive();
          },
          onError: () => { connectionLive = false; setStatus('offline'); },
        });
        if (!stopped) { connectionLive = false; setStatus('offline'); schedule(); }
      } catch {
        if (!stopped && !controller?.signal.aborted) {
          connectionLive = false;
          setStatus('offline');
          schedule();
        }
      }
    };

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(retryTimer);
      controller?.abort();
    };
  }, [active, streamKey]);

  return active ? status : 'offline';
}
