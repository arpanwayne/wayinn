const BASE = import.meta.env.VITE_API_URL || '/api';

export class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || `Request failed (${status})`);
    this.status = status;
    this.data = data;
  }
}

function tokenFor(scope) {
  if (scope === 'none') return null;
  try { return localStorage.getItem(scope === 'platform' ? 'wayinn.platform' : scope === 'guest' ? 'wayinn.guest' : 'wayinn.token'); } catch { return null; }
}

export async function request(method, path, body, { scope = 'staff', raw = false, file = null } = {}) {
  const token = tokenFor(scope);
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(file ? { 'content-type': file.type } : body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: file || (body ? JSON.stringify(body) : undefined),
  });
  if (raw) {
    if (!res.ok) throw new ApiError(res.status, { error: await res.text() });
    return res;
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    if (res.status === 401 && scope === 'staff' && token) {
      try { localStorage.removeItem('wayinn.token'); } catch { /* ignore */ }
      if (!location.pathname.startsWith('/login')) location.href = '/login';
    }
    throw new ApiError(res.status, data);
  }
  return data;
}

export const api = {
  get: (p, o) => request('GET', p, null, o),
  post: (p, b, o) => request('POST', p, b || {}, o),
  put: (p, b, o) => request('PUT', p, b, o),
  patch: (p, b, o) => request('PATCH', p, b, o),
  del: (p, b, o) => request('DELETE', p, b || null, o),
};

export async function downloadCsv(path, filename) {
  const res = await request('GET', path, null, { raw: true });
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Upload one file as the raw request body (used for guest documents). */
export const uploadFile = (path, file) => request('POST', path, null, { file });

/** Fetch a protected file (needs the login header, so it cannot be a plain <img src>) as a blob URL. */
export async function blobUrl(path) {
  return URL.createObjectURL(await (await request('GET', path, null, { raw: true })).blob());
}
