import { useEffect, useState } from 'react';
import { api, qs } from '../api.js';
import { localDate } from '../format.js';
import DataTable, { downloadCsv, toCsv } from '../components/DataTable.jsx';
import { Field, Notice, PageHeader } from '../components/ui.jsx';

// Which filters each report takes.
const FILTERS = {
  'card-issue': ['dates', 'consumer', 'meter', 'cardStatus'],
  'recharge-history': ['dates', 'consumer', 'meter', 'txnStatus', 'type', 'paymentMode'],
  'payment-collection': ['dates'],
  'collection-summary': ['dates', 'period'],
  'consumer-registration': ['dates', 'consumer', 'meter'],
  'meter-wise': ['dates', 'consumer', 'meter'],
  'cards-not-seen': ['days', 'consumer', 'meter'],
};

const monthStart = () => {
  const d = new Date();
  return localDate(new Date(d.getFullYear(), d.getMonth(), 1));
};

export default function Reports() {
  const [list, setList] = useState([]);
  const [id, setId] = useState('collection-summary');
  const [f, setF] = useState({ from: monthStart(), to: localDate(), period: 'daily', days: '30' });
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/reports').then((r) => setList(r.reports));
  }, []);

  const run = async (reportId = id, filters = f) => {
    setBusy(true);
    setError(null);
    const allowed = FILTERS[reportId];
    const p = {};
    if (allowed.includes('dates')) Object.assign(p, { from: filters.from, to: filters.to });
    for (const k of ['consumer', 'meter', 'period', 'days', 'type', 'paymentMode']) if (allowed.includes(k)) p[k] = filters[k];
    if (allowed.includes('txnStatus') || allowed.includes('cardStatus')) p.status = filters.status;
    try {
      setReport(await api.get(`/reports/${reportId}${qs(p)}`));
    } catch (e) {
      setError(e.message);
      setReport(null);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const has = (k) => FILTERS[id]?.includes(k);

  return (
    <div className="stack">
      <PageHeader title="Reports" subtitle="Built only from what this desk recorded. The meter never reports consumption or balance back." />
      <div className="report-tabs no-print">
        {list.map((r) => (
          <button
            key={r.id}
            className={r.id === id ? 'active' : ''}
            onClick={() => {
              setF((prev) => ({ ...prev, status: '' }));
              setId(r.id);
            }}
          >
            {r.title}
          </button>
        ))}
      </div>

      <form
        className="filters panel no-print"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        {has('dates') && (
          <>
            <Field label="From">
              <input type="date" value={f.from} onChange={set('from')} />
            </Field>
            <Field label="To">
              <input type="date" value={f.to} onChange={set('to')} />
            </Field>
          </>
        )}
        {has('days') && (
          <Field label="Not seen for at least (days)">
            <input value={f.days} onChange={(e) => setF({ ...f, days: e.target.value.replace(/\D/g, '') })} inputMode="numeric" />
          </Field>
        )}
        {has('period') && (
          <Field label="Group by">
            <select value={f.period} onChange={set('period')}>
              <option value="daily">Day</option>
              <option value="monthly">Month</option>
            </select>
          </Field>
        )}
        {has('consumer') && (
          <Field label="Consumer">
            <input value={f.consumer || ''} onChange={set('consumer')} placeholder="Name, mobile or ID" />
          </Field>
        )}
        {has('meter') && (
          <Field label="Meter">
            <input value={f.meter || ''} onChange={set('meter')} className="mono upper" />
          </Field>
        )}
        {has('txnStatus') && (
          <Field label="Status">
            <select value={f.status || ''} onChange={set('status')}>
              <option value="">All</option>
              <option value="completed">Completed</option>
              <option value="uncertain">Uncertain</option>
              <option value="failed">Failed</option>
            </select>
          </Field>
        )}
        {has('cardStatus') && (
          <Field label="Card status">
            <select value={f.status || ''} onChange={set('status')}>
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="blocked">Blocked</option>
              <option value="lost">Lost</option>
            </select>
          </Field>
        )}
        {has('type') && (
          <Field label="Type">
            <select value={f.type || ''} onChange={set('type')}>
              <option value="">All</option>
              <option value="recharge">Recharge</option>
              <option value="issue">Card issue</option>
            </select>
          </Field>
        )}
        {has('paymentMode') && (
          <Field label="Paid by">
            <select value={f.paymentMode || ''} onChange={set('paymentMode')}>
              <option value="">All</option>
              <option value="cash">Cash</option>
              <option value="upi">UPI</option>
              <option value="card">Card</option>
              <option value="cheque">Cheque</option>
              <option value="free">Free</option>
            </select>
          </Field>
        )}
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Loading…' : 'Run report'}
        </button>
      </form>

      {error && <Notice kind="error">{error}</Notice>}
      {report && (
        <section className="panel printable">
          <div className="report-head">
            <div>
              <h2>{report.title}</h2>
              <p className="muted small">
                {has('dates') && `${f.from || 'start'} to ${f.to || 'today'} · `}
                {report.rows.length} row{report.rows.length === 1 ? '' : 's'} · generated {new Date(report.generatedAt).toLocaleString('en-IN')}
              </p>
            </div>
            <div className="row gap-sm no-print">
              <button className="btn" onClick={() => downloadCsv(`${report.id}-${localDate()}.csv`, toCsv(report.columns, report.rows, report.totals))} disabled={!report.rows.length}>
                Export CSV
              </button>
              <button className="btn" onClick={() => window.print()}>
                Print
              </button>
            </div>
          </div>
          {report.note && <Notice kind="info">{report.note}</Notice>}
          <DataTable columns={report.columns} rows={report.rows} totals={report.totals} empty="No data for these filters." />
          {report.totalsNote && <p className="muted small">{report.totalsNote}</p>}
        </section>
      )}
    </div>
  );
}
