import { useState } from 'react';
import { useAuth } from '../context.jsx';
import { Field, Notice } from '../components/ui.jsx';

export default function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="brand-mark brand-mark-lg">⚡</span>
          <div>
            <h1>Recharge Station</h1>
            <p className="muted">Prepaid energy meter — EM&amp;W desk</p>
          </div>
        </div>
        <Field label="Username">
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" autoCapitalize="none" />
        </Field>
        <Field label="Password">
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </Field>
        {error && <Notice kind="error">{error}</Notice>}
        <button className="btn btn-primary btn-lg btn-block" disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
