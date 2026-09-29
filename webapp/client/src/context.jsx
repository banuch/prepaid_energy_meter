import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, setUnauthorizedHandler } from './api.js';

// --- auth ----------------------------------------------------------------------

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [operator, setOperator] = useState(undefined); // undefined = still checking

  useEffect(() => {
    setUnauthorizedHandler(() => setOperator(null));
    api
      .get('/auth/me')
      .then((r) => setOperator(r.operator))
      .catch(() => setOperator(null));
  }, []);

  const login = useCallback(async (username, password) => {
    const r = await api.post('/auth/login', { username, password });
    setOperator(r.operator);
  }, []);

  const logout = useCallback(async () => {
    await api.post('/auth/logout').catch(() => {});
    setOperator(null);
  }, []);

  return <AuthContext.Provider value={{ operator, login, logout, isAdmin: operator?.role === 'admin' }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

// --- reader / card taps ----------------------------------------------------------
//
// One websocket per logged-in screen. `tap` is the card currently on the
// reader (with its DB record), or null. `tap.seq` changes on every new tap or
// re-read, so pages can reset their per-card state.

const ReaderContext = createContext(null);

export function ReaderProvider({ children }) {
  const [status, setStatus] = useState(null);
  const [tap, setTap] = useState(null);
  const [socketUp, setSocketUp] = useState(false);
  const [settings, setSettings] = useState(null);
  const seq = useRef(0);

  const refreshSettings = useCallback(() => {
    api
      .get('/status')
      .then((r) => {
        setSettings(r.settings);
        setStatus(r.reader);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshSettings();
    let ws;
    let retry;
    let closed = false;

    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onopen = () => setSocketUp(true);
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'status') setStatus(msg.status);
        else if (msg.type === 'card') setTap({ ...msg, seq: ++seq.current, at: Date.now() });
        else if (msg.type === 'removed') setTap(null);
      };
      ws.onclose = () => {
        setSocketUp(false);
        if (!closed) retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws && ws.close();
    };
  }, [refreshSettings]);

  const reread = useCallback(async () => {
    const r = await api.post('/cards/reread');
    return r.tap;
  }, []);

  return (
    <ReaderContext.Provider value={{ status, tap, socketUp, reread, settings, refreshSettings }}>{children}</ReaderContext.Provider>
  );
}

export const useReader = () => useContext(ReaderContext);
