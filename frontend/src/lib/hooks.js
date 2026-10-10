import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

/** Load data from a GET endpoint; optional polling interval in ms. */
export function useApi(path, { interval = 0, scope = 'staff', skip = false } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(!skip);
  const alive = useRef(true);
  const load = useCallback(async () => {
    if (skip || !path) return;
    try {
      const d = await api.get(path, { scope });
      if (alive.current) { setData(d); setError(null); }
    } catch (e) {
      if (alive.current) setError(e);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [path, scope, skip]);
  useEffect(() => {
    alive.current = true;
    setLoading(!skip);
    load();
    let t;
    if (interval) t = setInterval(load, interval);
    return () => { alive.current = false; clearInterval(t); };
  }, [load, interval, skip]);
  return { data, error, loading, reload: load, setData };
}
