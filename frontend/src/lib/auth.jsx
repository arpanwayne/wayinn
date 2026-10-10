import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api.js';

const AuthCtx = createContext(null);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } },
};

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, hotel: null, permissions: [] });

  const refresh = useCallback(async () => {
    if (!store.get('wayinn.token')) return setState({ loading: false, user: null, hotel: null, permissions: [] });
    try {
      const me = await api.get('/auth/me');
      setState({ loading: false, ...me });
    } catch {
      setState({ loading: false, user: null, hotel: null, permissions: [] });
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const login = async (email, password) => {
    const r = await api.post('/auth/login', { email, password });
    store.set('wayinn.token', r.token);
    setState({ loading: false, user: r.user, hotel: r.hotel, permissions: r.permissions });
    return r;
  };
  const loginWithToken = async (token) => { store.set('wayinn.token', token); await refresh(); };
  const logout = () => { store.set('wayinn.token', null); setState({ loading: false, user: null, hotel: null, permissions: [] }); };
  const can = (...perms) => perms.some((p) => state.permissions.includes(p));

  return <AuthCtx.Provider value={{ ...state, login, logout, can, refresh, loginWithToken }}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
export { store };
