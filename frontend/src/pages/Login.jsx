import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { Logo } from '../components/Layout.jsx';

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { await login(email, password); nav('/'); } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="hidden flex-col justify-between bg-brand-900 p-10 text-brand-100 lg:flex">
        <Logo light />
        <div>
          <p className="text-3xl font-bold leading-tight text-white">Rooms, restaurant, housekeeping and billing — one screen for your whole hotel.</p>
          <p className="mt-4 max-w-md text-brand-200">Built for independent hotels up to 50 rooms by Wayne E Solutions.</p>
        </div>
        <p className="text-xs text-brand-300">© Wayne E Solutions</p>
      </div>
      <div className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm space-y-4">
          <div className="lg:hidden"><Logo /></div>
          <div>
            <h1 className="text-2xl">Sign in</h1>
            <p className="text-sm text-ink-500">Use the account your hotel admin created for you.</p>
          </div>
          <label className="block"><span className="label">Email</span>
            <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label className="block"><span className="label">Password</span>
            <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
          <button className="btn-primary w-full py-2.5" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </div>
    </div>
  );
}
