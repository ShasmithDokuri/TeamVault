import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'checking', user: null });
  useEffect(() => {
    let active = true;
    const expireSession = () => setState({ status: 'anonymous', user: null });
    window.addEventListener('teamvault:session-expired', expireSession);
    api.auth.me().then(({ user }) => { if (active) setState({ status: 'authenticated', user }); })
      .catch((error) => { if (active) setState(error.status === 401 ? { status: 'anonymous', user: null } : { status: 'error', user: null, error: error.message }); });
    return () => { active = false; window.removeEventListener('teamvault:session-expired', expireSession); };
  }, []);
  const value = useMemo(() => ({
    ...state,
    async login(credentials) { const result = await api.auth.login(credentials); setState({ status: 'authenticated', user: result.user }); },
    async register(credentials) { const result = await api.auth.register(credentials); setState({ status: 'authenticated', user: result.user }); },
    async logout() { try { await api.auth.logout(); } finally { setState({ status: 'anonymous', user: null }); } },
  }), [state]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider.');
  return context;
}
