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
      <div className="relative hidden flex-col justify-between overflow-hidden bg-night-900 p-12 text-night-200 lg:flex">
        <div className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full bg-amber-400/20 blur-3xl" />
        <Logo light />
        <div className="relative">
          {/* A key rack: the oldest dashboard a hotel has */}
          <div className="mb-10 grid w-72 grid-cols-6 gap-2" aria-hidden="true">
            {[1, 1, 0, 1, 2, 1, 0, 1, 1, 1, 0, 3, 1, 0, 1, 1, 1, 0].map((s, i) => (
              <span key={i} className={`h-9 rounded-lg ${s === 1 ? 'bg-amber-400' : s === 2 ? 'bg-amber-400/40' : s === 3 ? 'bg-red-400/80' : 'ring-1 ring-inset ring-white/25'}`} />
            ))}
          </div>
          <p className="font-display text-[2.6rem] font-bold leading-[1.05] tracking-tight text-white">Every room, every bill, every order. One screen.</p>
          <p className="mt-5 max-w-md text-night-200">For independent hotels up to 50 rooms. Front desk, restaurant, housekeeping and billing work from the same live picture.</p>
        </div>
        <p className="text-xs text-night-300">Wayne E Solutions</p>
      </div>
      <div className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm space-y-4">
          <div className="lg:hidden"><Logo /></div>
          <div>
            <h1 className="text-3xl">Sign in</h1>
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
