import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { ago, dateTime, money } from '../format.js';
import DataTable from '../components/DataTable.jsx';
import Receipt from '../components/Receipt.jsx';
import { Field, KeyValues, Modal, Notice, PageHeader, StatusPill } from '../components/ui.jsx';

export default function ConsumerDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [statusFor, setStatusFor] = useState(null);
  const [receipt, setReceipt] = useState(null);

  const load = useCallback(() => api.get(`/consumers/${id}`).then(setData).catch((e) => setError(e.message)), [id]);
  useEffect(() => {
    load();
  }, [load]);

  if (error) return <Notice kind="error">{error}</Notice>;
  if (!data) return <p className="muted">Loading…</p>;
  const { consumer, cards, transactions } = data;
  const completed = transactions.filter((t) => t.status === 'completed');

  return (
    <div className="stack">
      <PageHeader title={consumer.name} subtitle={`Consumer #${consumer.id} · registered ${dateTime(consumer.created_at)}`}>
        <Link to="/consumers" className="btn">
          ← All consumers
        </Link>
        <button className="btn btn-primary" onClick={() => setEditing(true)}>
          Edit details
        </button>
      </PageHeader>

      <div className="grid-2">
        <section className="panel">
          <KeyValues
            items={[
              ['Meter number', <span className="mono">{consumer.meter_number}</span>],
              ['Mobile', consumer.mobile],
              ['Address', consumer.address || '—'],
              ['Credited at desk', `${money(completed.reduce((s, t) => s + t.amount, 0))} in ${completed.length} completed write${completed.length === 1 ? '' : 's'}`, 'card issue + recharges'],
              ['Last recharge # written', consumer.recharge_counter, 'the meter only credits cards above its last applied number'],
            ]}
          />
        </section>
        <section className="panel stack-sm">
          <h2 className="panel-title">Cards</h2>
          {cards.length === 0 && <p className="muted">No cards.</p>}
          {cards.map((c) => (
            <div key={c.card_uid} className="card-row">
              <div>
                <div className="row gap-sm">
                  <span className="mono">{c.card_uid}</span>
                  <StatusPill status={c.status} />
                </div>
                <div className="muted small">
                  Issued {dateTime(c.activated_at)} · last seen at desk {ago(c.last_seen_at)}
                  {c.last_seen_counter !== null && ` (recharge #${c.last_seen_counter}, ${money(c.last_seen_amount)} on card as of that visit)`}
                </div>
                {c.status_note && <div className="small">{c.status_note}</div>}
              </div>
              <button className="btn btn-sm" onClick={() => setStatusFor(c)}>
                Change status
              </button>
            </div>
          ))}
          <Link to="/register" className="btn btn-sm self-start">
            + Issue replacement card
          </Link>
        </section>
      </div>

      <section className="panel">
        <h2 className="panel-title">Recharge history</h2>
        <DataTable
          columns={[
            { key: 'timestamp', label: 'Date', type: 'datetime' },
            { key: 'receipt_no', label: 'Receipt', mono: true },
            { key: 'type', label: 'Type' },
            { key: 'card_uid', label: 'Card', mono: true },
            { key: 'amount', label: 'Amount', type: 'money' },
            { key: 'payment_mode', label: 'Paid by' },
            { key: 'counter_after', label: 'Recharge #', type: 'number' },
            { key: 'status', label: 'Status', type: 'status' },
            { key: 'operator_name', label: 'Operator' },
          ]}
          rows={transactions}
          onRowClick={(t) => setReceipt(t)}
          empty="No recharges yet."
        />
      </section>

      {editing && (
        <EditConsumer
          consumer={consumer}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            load();
          }}
        />
      )}
      {statusFor && (
        <CardStatus
          card={statusFor}
          onClose={() => setStatusFor(null)}
          onSaved={() => {
            setStatusFor(null);
            load();
          }}
        />
      )}
      {receipt && (
        <Modal title={`Transaction ${receipt.receipt_no}`} onClose={() => setReceipt(null)} footer={<button className="btn" onClick={() => window.print()}>Print</button>}>
          {receipt.status !== 'completed' && (
            <Notice kind={receipt.status === 'failed' ? 'error' : 'warn'} title={`Status: ${receipt.status}`}>
              {receipt.error}
            </Notice>
          )}
          <Receipt txn={receipt} consumer={consumer} />
        </Modal>
      )}
    </div>
  );
}

function EditConsumer({ consumer, onClose, onSaved }) {
  const [form, setForm] = useState({ name: consumer.name, mobile: consumer.mobile, address: consumer.address || '', meterNumber: consumer.meter_number });
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    try {
      await api.put(`/consumers/${consumer.id}`, form);
      onSaved();
    } catch (e2) {
      setErr(e2);
    }
  };
  const meterChanged = form.meterNumber.trim().toUpperCase() !== consumer.meter_number;
  return (
    <Modal title="Edit consumer" onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <Field label="Name" error={err?.fields?.name}>
          <input value={form.name} onChange={set('name')} />
        </Field>
        <Field label="Mobile" error={err?.fields?.mobile}>
          <input value={form.mobile} onChange={set('mobile')} inputMode="tel" />
        </Field>
        <Field label="Address" error={err?.fields?.address}>
          <textarea value={form.address} onChange={set('address')} rows={2} />
        </Field>
        <Field label="Meter number" error={err?.fields?.meterNumber}>
          <input value={form.meterNumber} onChange={set('meterNumber')} className="mono upper" maxLength={16} />
        </Field>
        {meterChanged && (
          <Notice kind="warn">
            The card still says the old meter number until its next recharge rewrites it. If the physical meter was replaced, the new meter starts counting recharges from zero — that's fine, the desk keeps counting up.
          </Notice>
        )}
        {err && !Object.keys(err.fields || {}).length && <Notice kind="error">{err.message}</Notice>}
        <button className="btn btn-primary">Save</button>
      </form>
    </Modal>
  );
}

function CardStatus({ card, onClose, onSaved }) {
  const [status, setStatus] = useState(card.status);
  const [note, setNote] = useState('');
  const [err, setErr] = useState(null);
  const save = async () => {
    try {
      await api.post(`/cards/${card.card_uid}/status`, { status, note: note.trim() || undefined });
      onSaved();
    } catch (e) {
      setErr(e.message);
    }
  };
  return (
    <Modal title={`Card ${card.card_uid}`} onClose={onClose} footer={<button className="btn btn-primary" onClick={save} disabled={status === card.status && !note}>Save</button>}>
      <div className="stack">
        <div className="choice-list">
          {[
            ['active', 'Active', 'Can be recharged at the desk.'],
            ['blocked', 'Blocked', 'Desk refuses to recharge it (e.g. dispute, suspected tampering).'],
            ['lost', 'Lost', 'Reported lost or replaced. Desk refuses to recharge it.'],
          ].map(([v, label, text]) => (
            <label key={v} className={`choice${status === v ? ' active' : ''}`}>
              <input type="radio" name="status" checked={status === v} onChange={() => setStatus(v)} />
              <span>
                <strong>{label}</strong>
                <span className="muted small block">{text}</span>
              </span>
            </label>
          ))}
        </div>
        <Field label="Note" hint="Optional — shown on the card record">
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
        </Field>
        <Notice kind="info">
          Blocking only stops <em>desk</em> recharges. The meter works offline and can't be told about it — an amount already on the card can still be credited once.
        </Notice>
        {err && <Notice kind="error">{err}</Notice>}
      </div>
    </Modal>
  );
}
