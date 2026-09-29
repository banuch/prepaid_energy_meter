import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useReader } from '../context.jsx';
import { money, rupeesToPaise } from '../format.js';
import { Field, Notice, PageHeader } from '../components/ui.jsx';

const toRupees = (p) => (p / 100).toFixed(2).replace(/\.00$/, '');

export default function Settings() {
  const { refreshSettings } = useReader();
  const [s, setS] = useState(null);
  const [form, setForm] = useState(null);
  const [slabs, setSlabs] = useState([]);
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(false);

  const apply = (settings) => {
    setS(settings);
    setForm({ initial: toRupees(settings.initialCreditPaise), min: toRupees(settings.minRechargePaise), max: toRupees(settings.maxRechargePaise) });
    setSlabs(settings.tariff.slabs.map((x) => ({ limit: x.upperLimitUnits === null ? '' : String(x.upperLimitUnits), rate: toRupees(x.ratePaisePerUnit) })));
  };

  useEffect(() => {
    api.get('/settings').then((r) => apply(r.settings));
  }, []);

  if (!form) return <p className="muted">Loading…</p>;

  const save = async (e) => {
    e.preventDefault();
    setErr(null);
    setSaved(false);
    const body = {
      initialCreditPaise: rupeesToPaise(form.initial),
      minRechargePaise: rupeesToPaise(form.min),
      maxRechargePaise: rupeesToPaise(form.max),
      tariff: {
        slabs: slabs.map((x, i) => ({
          upperLimitUnits: i === slabs.length - 1 && x.limit === '' ? null : Number(x.limit),
          ratePaisePerUnit: rupeesToPaise(x.rate),
        })),
      },
    };
    if ([body.initialCreditPaise, body.minRechargePaise, body.maxRechargePaise].some((v) => v === null)) {
      return setErr({ message: 'Amounts must be in rupees, e.g. 100 or 99.50' });
    }
    try {
      const r = await api.put('/settings', body);
      apply(r.settings);
      refreshSettings();
      setSaved(true);
    } catch (e2) {
      setErr(e2);
    }
  };

  const setSlab = (i, k) => (e) => setSlabs(slabs.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)));

  return (
    <form className="stack" onSubmit={save}>
      <PageHeader title="Settings & tariff">
        <button className="btn btn-primary">Save settings</button>
      </PageHeader>
      {saved && <Notice kind="success">Saved.</Notice>}
      {err && <Notice kind="error">{err.message}</Notice>}

      <div className="grid-2">
        <section className="panel stack">
          <h2 className="panel-title">Amounts</h2>
          <Field label="Initial credit on a new card (₹)" error={err?.fields?.initialCreditPaise} hint={`Currently ${money(s.initialCreditPaise)}`}>
            <input value={form.initial} onChange={(e) => setForm({ ...form, initial: e.target.value })} inputMode="decimal" />
          </Field>
          <Field label="Minimum recharge (₹)" error={err?.fields?.minRechargePaise}>
            <input value={form.min} onChange={(e) => setForm({ ...form, min: e.target.value })} inputMode="decimal" />
          </Field>
          <Field label="Maximum recharge (₹)" error={err?.fields?.maxRechargePaise}>
            <input value={form.max} onChange={(e) => setForm({ ...form, max: e.target.value })} inputMode="decimal" />
          </Field>
        </section>

        <section className="panel stack">
          <h2 className="panel-title">Tariff (version {s.tariff.version})</h2>
          <p className="muted small">
            Written to every card at issue and recharge (blocks 8–10). The meter copies it from the card on each tap. Changing the slabs bumps the version. Up to 8 slabs;
            leave the last slab's limit empty for "and above".
          </p>
          <table className="slab-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Up to units (monthly)</th>
                <th>Rate ₹/unit</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {slabs.map((x, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>
                    <input value={x.limit} onChange={setSlab(i, 'limit')} inputMode="numeric" placeholder={i === slabs.length - 1 ? 'and above' : ''} />
                  </td>
                  <td>
                    <input value={x.rate} onChange={setSlab(i, 'rate')} inputMode="decimal" />
                  </td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSlabs(slabs.filter((_, j) => j !== i))} disabled={slabs.length === 1} aria-label="Remove slab">
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {slabs.length < 8 && (
            <button type="button" className="btn btn-sm self-start" onClick={() => setSlabs([...slabs, { limit: '', rate: '' }])}>
              + Add slab
            </button>
          )}
          {err?.fields?.tariff && <Notice kind="error">{err.fields.tariff}</Notice>}
        </section>
      </div>
    </form>
  );
}
