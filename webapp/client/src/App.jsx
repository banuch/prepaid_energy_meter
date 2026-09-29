import { useState } from 'react';
import { Link, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { api } from './api.js';
import { ReaderProvider, useAuth, useReader } from './context.jsx';
import { Field, Modal, Notice } from './components/ui.jsx';
import MockReader from './components/MockReader.jsx';
import Login from './pages/Login.jsx';
import Home from './pages/Home.jsx';
import Register from './pages/Register.jsx';
import Recharge from './pages/Recharge.jsx';
import Inquiry from './pages/Inquiry.jsx';
import Consumers from './pages/Consumers.jsx';
import ConsumerDetail from './pages/ConsumerDetail.jsx';
import Reports from './pages/Reports.jsx';
import Operators from './pages/Operators.jsx';
import Settings from './pages/Settings.jsx';

export default function App() {
  const { operator } = useAuth();
  if (operator === undefined) return <div className="boot">Loading…</div>;
  if (!operator) return <Login />;
  return (
    <ReaderProvider>
      <Shell />
    </ReaderProvider>
  );
}

function AdminOnly({ children }) {
  const { isAdmin } = useAuth();
  return isAdmin ? children : <Navigate to="/" replace />;
}

function Shell() {
  return (
    <div className="shell">
      <TopBar />
      <main className="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/register" element={<Register />} />
          <Route path="/recharge" element={<Recharge />} />
          <Route path="/inquiry" element={<Inquiry />} />
          <Route path="/consumers" element={<AdminOnly><Consumers /></AdminOnly>} />
          <Route path="/consumers/:id" element={<AdminOnly><ConsumerDetail /></AdminOnly>} />
          <Route path="/reports" element={<AdminOnly><Reports /></AdminOnly>} />
          <Route path="/operators" element={<AdminOnly><Operators /></AdminOnly>} />
          <Route path="/settings" element={<AdminOnly><Settings /></AdminOnly>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <MockReader />
    </div>
  );
}

function ReaderBadge() {
  const { status, socketUp, tap } = useReader();
  let cls = 'off';
  let text = 'Server offline';
  if (socketUp && status) {
    if (!status.connected) text = 'Reader not connected';
    else {
      cls = tap ? 'card' : 'on';
      text = tap ? `Card ${tap.uid} on reader` : `Reader ready${status.mode === 'mock' ? ' (mock)' : ''}`;
    }
  }
  return (
    <span className={`reader-badge reader-${cls}`} title={status?.error || status?.firmware || ''}>
      <span className="dot" />
      {text}
    </span>
  );
}

function TopBar() {
  const { operator, isAdmin, logout } = useAuth();
  const [menu, setMenu] = useState(false);
  const [pw, setPw] = useState(false);
  const links = [
    ['/register', 'Register'],
    ['/recharge', 'Recharge'],
    ['/inquiry', 'Inquiry'],
    ...(isAdmin
      ? [
          ['/consumers', 'Consumers'],
          ['/reports', 'Reports'],
        ]
      : []),
  ];
  return (
    <header className="topbar">
      <Link to="/" className="brand">
        <span className="brand-mark">⚡</span>
        <span>Recharge Station</span>
      </Link>
      <nav className="nav">
        {links.map(([to, label]) => (
          <NavLink key={to} to={to}>
            {label}
          </NavLink>
        ))}
      </nav>
      <ReaderBadge />
      <div className="user">
        <button className="btn btn-ghost" onClick={() => setMenu(!menu)} aria-expanded={menu}>
          {operator.name} <span className="muted small">({operator.role})</span> ▾
        </button>
        {menu && (
          <div className="menu" onMouseLeave={() => setMenu(false)}>
            {isAdmin && (
              <>
                <Link to="/operators" onClick={() => setMenu(false)}>
                  Operators
                </Link>
                <Link to="/settings" onClick={() => setMenu(false)}>
                  Settings &amp; tariff
                </Link>
              </>
            )}
            <button
              onClick={() => {
                setMenu(false);
                setPw(true);
              }}
            >
              Change password
            </button>
            <button onClick={logout}>Log out</button>
          </div>
        )}
      </div>
      {pw && <ChangePassword onClose={() => setPw(false)} />}
    </header>
  );
}

function ChangePassword({ onClose }) {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (form.next !== form.confirm) return setErr({ fields: { confirm: "Passwords don't match" } });
    try {
      await api.post('/auth/password', { current: form.current, next: form.next });
      setDone(true);
    } catch (e2) {
      setErr(e2);
    }
  };
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <Modal title="Change password" onClose={onClose}>
      {done ? (
        <Notice kind="success" title="Password changed." action={<button className="btn" onClick={onClose}>Close</button>} />
      ) : (
        <form onSubmit={submit} className="stack">
          <Field label="Current password" error={err?.fields?.current}>
            <input type="password" value={form.current} onChange={set('current')} autoFocus autoComplete="current-password" />
          </Field>
          <Field label="New password" error={err?.fields?.next} hint="At least 8 characters">
            <input type="password" value={form.next} onChange={set('next')} autoComplete="new-password" />
          </Field>
          <Field label="Repeat new password" error={err?.fields?.confirm}>
            <input type="password" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" />
          </Field>
          {err?.message && !Object.keys(err.fields || {}).length && <Notice kind="error">{err.message}</Notice>}
          <button className="btn btn-primary">Change password</button>
        </form>
      )}
    </Modal>
  );
}
