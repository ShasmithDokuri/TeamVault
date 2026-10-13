import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { API_BASE_URL, api } from './api.js';

export function useWorkspaceRealtime(workspaceId, onResourceChanged) {
  const [status, setStatus] = useState(workspaceId ? 'connecting' : 'disconnected');

  useEffect(() => {
    if (!workspaceId) { setStatus('disconnected'); return undefined; }
    let stopped = false;
    let socket;
    let timer;
    let retries = 0;
    setStatus('connecting');

    async function connect() {
      try {
        const { ticket } = await api.auth.realtimeTicket();
        if (stopped) return;
        socket = io(API_BASE_URL || window.location.origin, {
          path: '/socket.io',
          // The API validates the browser Origin on the initial Socket.IO
          // handshake. Same-origin polling GETs omit Origin in some browsers;
          // a WebSocket handshake reliably includes it.
          transports: ['websocket'],
          auth: { ticket },
          autoConnect: false,
          reconnection: false,
          withCredentials: true,
        });
        socket.on('connect', () => {
          retries = 0;
          setStatus('connected');
          socket.emit('workspace:subscribe', { workspaceId }, (result) => {
            if (!result?.ok) setStatus('unavailable');
          });
        });
        socket.on('workspace:event', (event) => {
          if (event?.workspaceId === workspaceId) onResourceChanged(event);
        });
        socket.on('disconnect', scheduleReconnect);
        socket.on('connect_error', scheduleReconnect);
        socket.connect();
      } catch (error) {
        if (error.status === 401) { setStatus('disconnected'); return; }
        scheduleReconnect();
      }
    }

    function scheduleReconnect() {
      if (stopped || timer) return;
      socket?.removeAllListeners();
      socket?.disconnect();
      socket = undefined;
      retries += 1;
      setStatus('reconnecting');
      const delay = Math.min(500 * (2 ** Math.min(retries - 1, 5)), 15000);
      timer = window.setTimeout(() => { timer = undefined; void connect(); }, delay);
    }

    void connect();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      socket?.removeAllListeners();
      socket?.disconnect();
    };
  }, [workspaceId, onResourceChanged]);

  return status;
}
