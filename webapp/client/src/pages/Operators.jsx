import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../context.jsx';
import DataTable from '../components/DataTable.jsx';
import { Field, Modal, Notice, PageHeader, Segmented } from '../components/ui.jsx';

export default function Operators() {
  const { operator: me } = useAuth();
  const [ops, setOps] = useState([]);
  const [editing, setEditing] = useState(null); // operator or 'new'
  const load = useCallback(() => api.get('/operators').then((r) => setOps(r.operators)), []);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <PageHeader title="Operators" subtitle="Operators can register, recharge and inquire. Admins can also manage consumers, cards, reports, operators and settings.">
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          + Add operator
        </button>
      </PageHeader>
      <DataTable
        columns={[
          { key: 'name', label: 'Name', render: (r) => `${r.name}${r.id === me.id ? ' (you)' : ''}` },
          { key: 'username', label: 'Username', mono: true },
          { key: 'role', label: 'Role' },
          { key: 'active', label: 'Status', render: (r) => <span className={`pill pill-${r.active ? 'active' : 'lost'}`}>{r.active ? 'active' : 'disabled'}</span> },
        ]}
        rows={ops}
        onRowClick={setEditing}
      />
      {editing && (
        <OperatorForm
          op={editing === 'new' ? null : editing}
          isSelf={editing !== 'new' && editing.id === me.id}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function OperatorForm({ op, isSelf, onClose, onSaved }) {
  const [form, setForm] = useState({ name: op?.name || '', username: op?.username || '', role: op?.role || 'operator', active: op ? op.active : true, password: '' });
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    try {
      if (op) await api.put(`/operators/${op.id}`, { name: form.name, role: form.role, active: form.active, password: form.password || undefined });
      else await api.post('/operators', form);
      onSaved();
    } catch (e2) {
      setErr(e2);
    }
  };
  return (
    <Modal title={op ? `Edit ${op.name}` : 'Add operator'} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <Field label="Full name" error={err?.fields?.name}>
          <input value={form.name} onChange={set('name')} autoFocus />
        </Field>
        <Field label="Username" error={err?.fields?.username}>
          <input value={form.username} onChange={set('username')} disabled={!!op} autoCapitalize="none" />
        </Field>
        <Field label="Role">
          <Segmented
            value={form.role}
            onChange={(role) => setForm({ ...form, role })}
            options={[
              { value: 'operator', label: 'Operator' },
              { value: 'admin', label: 'Admin' },
            ]}
          />
        </Field>
        <Field label={op ? 'Reset password' : 'Password'} error={err?.fields?.password} hint={op ? 'Leave empty to keep the current password' : 'At least 8 characters'}>
          <input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" />
        </Field>
        {op && !isSelf && (
          <label className="check">
            <input type="checkbox" checked={!form.active} onChange={(e) => setForm({ ...form, active: !e.target.checked })} />
            <span>Disable this account (can't log in; history is kept)</span>
          </label>
        )}
        {err && !Object.keys(err.fields || {}).length && <Notice kind="error">{err.message}</Notice>}
        <button className="btn btn-primary">{op ? 'Save' : 'Add operator'}</button>
      </form>
    </Modal>
  );
}
