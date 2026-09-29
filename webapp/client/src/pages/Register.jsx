import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api.js';
import { useReader } from '../context.jsx';
import { money, PAYMENT_LABELS } from '../format.js';
import TapPanel, { CardFacts, Warnings } from '../components/TapPanel.jsx';
import Receipt from '../components/Receipt.jsx';
import { Field, Notice, PageHeader, Segmented } from '../components/ui.jsx';

const EMPTY = { name: '', mobile: '', address: '', meterNumber: '' };

export default function Register() {
  const { settings, tap } = useReader();
  const [mode, setMode] = useState('new');
  const [form, setForm] = useState(EMPTY);
  const [consumer, setConsumer] = useState(null); // existing consumer (replacement card)
  const [paymentMode, setPaymentMode] = useState('cash');
  const [meterLastCounter, setMeterLastCounter] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [replaceActive, setReplaceActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  // A different card on the reader invalidates per-card confirmations.
  const tapUid = tap?.uid;
  useEffect(() => {
    setConfirmOverwrite(false);
    setError(null);
  }, [tapUid]);

  const reset = () => {
    setForm(EMPTY);
    setConsumer(null);
    setMeterLastCounter('');
    setReplaceActive(false);
    setConfirmOverwrite(false);
    setError(null);
    setResult(null);
  };

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const fieldErr = (k) => error?.fields?.[k];

  const activate = async (tapNow) => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        uid: tapNow.uid,
        expectedCounter: tapNow.card.counter,
        paymentMode,
        confirmOverwrite,
        meterLastCounter: meterLastCounter === '' ? undefined : Number(meterLastCounter),
        ...(mode === 'new' ? { consumer: form } : { consumerId: consumer.id, replaceActiveCards: replaceActive }),
      };
      setResult(await api.post('/cards/issue', body));
    } catch (err) {
      setError(err);
      if (err.code === 'HAS_ACTIVE_CARD') setReplaceActive(false);
    } finally {
      setBusy(false);
    }
  };

  if (result) return <IssueResult result={result} onAgain={reset} />;

  const initial = settings?.initialCreditPaise;
  const ready = mode === 'new' ? form.name && form.mobile && form.meterNumber : !!consumer;
  const needsReplaceConfirm = mode === 'existing' && consumer?.active_cards > 0;

  return (
    <div>
      <PageHeader title="Register & issue card" subtitle={`Every new card is written with ${initial !== undefined ? money(initial) : 'the initial'} credit, the meter number and the current tariff.`} />

      <div className="grid-2">
        <section className="panel">
          <Segmented
            size="lg"
            value={mode}
            onChange={(m) => {
              setMode(m);
              setError(null);
            }}
            options={[
              { value: 'new', label: 'New consumer' },
              { value: 'existing', label: 'Replacement card' },
            ]}
          />

          {mode === 'new' ? (
            <div className="form-grid">
              <Field label="Consumer name" error={fieldErr('name')} wide>
                <input value={form.name} onChange={set('name')} autoComplete="off" />
              </Field>
              <Field label="Mobile number" error={fieldErr('mobile')}>
                <input value={form.mobile} onChange={set('mobile')} inputMode="tel" placeholder="98xxxxxxxx" autoComplete="off" />
              </Field>
              <Field label="Meter number" error={fieldErr('meterNumber')} hint="Written to the card; max 16 characters">
                <input value={form.meterNumber} onChange={set('meterNumber')} maxLength={16} className="mono upper" autoComplete="off" />
              </Field>
              <Field label="Address" error={fieldErr('address')} wide>
                <textarea value={form.address} onChange={set('address')} rows={2} />
              </Field>
            </div>
          ) : (
            <ConsumerPicker selected={consumer} onSelect={(c) => { setConsumer(c); setReplaceActive(false); setError(null); }} />
          )}

          <Field label={`Payment for the initial ${initial !== undefined ? money(initial) : ''} credit`}>
            <Segmented
              value={paymentMode}
              onChange={setPaymentMode}
              options={['cash', 'upi', 'card', 'free'].map((v) => ({ value: v, label: v === 'free' ? 'Free' : PAYMENT_LABELS[v] }))}
            />
          </Field>

          <button type="button" className="link-btn" onClick={() => setShowAdvanced(!showAdvanced)}>
            {showAdvanced ? '▾' : '▸'} Meter was recharged before by other means?
          </button>
          {showAdvanced && (
            <Field
              label="Meter's last applied recharge counter"
              hint="From the meter's web dashboard (lastAppliedRechargeCounter). The meter ignores a card whose counter isn't higher, so the new card starts above this. Leave empty for a new meter."
            >
              <input value={meterLastCounter} onChange={(e) => setMeterLastCounter(e.target.value.replace(/\D/g, ''))} inputMode="numeric" style={{ maxWidth: 180 }} />
            </Field>
          )}
        </section>

        <section className="panel">
          <h2 className="panel-title">Card</h2>
          <TapPanel prompt="Tap the new card on the reader">
            {(t) => {
              const rec = t.record;
              if (rec?.known) {
                return (
                  <>
                    <CardFacts card={t.card} />
                    <Notice
                      kind="warn"
                      title="This card is already registered"
                      action={
                        <Link to="/recharge" className="btn">
                          Recharge it
                        </Link>
                      }
                    >
                      It belongs to {rec.consumer.name} (meter {rec.consumer.meter_number}). Use a new card, or recharge this one.
                    </Notice>
                  </>
                );
              }
              return (
                <>
                  <CardFacts card={t.card} />
                  {t.card.blank ? (
                    <Notice kind="success">Blank card — ready to issue.</Notice>
                  ) : (
                    <>
                      <Warnings warnings={rec?.warnings} />
                      {rec?.meterConsumer && mode === 'new' && (
                        <button
                          className="btn"
                          onClick={() => {
                            api.get(`/consumers${qs({ q: t.card.serviceNumber })}`).then((r) => {
                              const c = r.consumers.find((x) => x.id === rec.meterConsumer.id);
                              if (c) {
                                setMode('existing');
                                setConsumer(c);
                              }
                            });
                          }}
                        >
                          Issue as replacement card for {rec.meterConsumer.name}
                        </button>
                      )}
                      <label className="check">
                        <input type="checkbox" checked={confirmOverwrite} onChange={(e) => setConfirmOverwrite(e.target.checked)} />
                        <span>Overwrite the data on this card</span>
                      </label>
                    </>
                  )}

                  {needsReplaceConfirm && (
                    <label className="check check-warn">
                      <input type="checkbox" checked={replaceActive} onChange={(e) => setReplaceActive(e.target.checked)} />
                      <span>
                        Mark {consumer.name}'s current card ({consumer.active_card_uids}) as <strong>lost</strong>. Any recharge still unused on the old card becomes
                        void once this new card is tapped on the meter.
                      </span>
                    </label>
                  )}

                  {error && (
                    <Notice kind="error" title={error.code === 'WRITE_FAILED' ? 'Card write failed' : undefined}>
                      {error.message}
                    </Notice>
                  )}

                  <button
                    className="btn btn-primary btn-lg btn-block"
                    disabled={busy || !ready || (!t.card.blank && !confirmOverwrite) || (needsReplaceConfirm && !replaceActive)}
                    onClick={() => activate(t)}
                  >
                    {busy ? 'Writing card — keep it on the reader…' : `Activate card${initial !== undefined ? ` · write ${money(initial)}` : ''}`}
                  </button>
                  {!ready && <p className="muted small center">{mode === 'new' ? 'Fill in name, mobile and meter number first.' : 'Choose the consumer first.'}</p>}
                </>
              );
            }}
          </TapPanel>
        </section>
      </div>
    </div>
  );
}

function ConsumerPicker({ selected, onSelect }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  useEffect(() => {
    if (!q.trim()) return setRows([]);
    const t = setTimeout(() => api.get(`/consumers${qs({ q, limit: 8 })}`).then((r) => setRows(r.consumers)), 200);
    return () => clearTimeout(t);
  }, [q]);

  if (selected) {
    return (
      <div className="picked">
        <div>
          <strong>{selected.name}</strong>
          <div className="muted small">
            Meter <span className="mono">{selected.meter_number}</span> · {selected.mobile}
          </div>
          <div className="muted small">{selected.active_cards ? `Active card: ${selected.active_card_uids}` : 'No active card'}</div>
        </div>
        <button className="btn" onClick={() => onSelect(null)}>
          Change
        </button>
      </div>
    );
  }
  return (
    <div className="stack-sm">
      <Field label="Find consumer">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, mobile or meter number" autoFocus />
      </Field>
      <ul className="pick-list">
        {rows.map((c) => (
          <li key={c.id}>
            <button onClick={() => onSelect(c)}>
              <strong>{c.name}</strong>
              <span className="muted small">
                <span className="mono">{c.meter_number}</span> · {c.mobile}
              </span>
            </button>
          </li>
        ))}
        {q && rows.length === 0 && <li className="muted small">No match.</li>}
      </ul>
    </div>
  );
}

function IssueResult({ result, onAgain }) {
  const { transaction: txn, consumer, committed, error } = result;
  return (
    <div className="result-page">
      {committed === 'yes' ? (
        <Notice kind="success" title="Card activated">
          {consumer.name}'s card now carries {money(txn.amount)} (recharge #{txn.counter_after}). Hand the card over and ask them to tap it on their meter.
        </Notice>
      ) : (
        <Notice kind="warn" title="Card written, but not confirmed">
          {error} The registration is saved; the transaction is marked <strong>uncertain</strong> and will be confirmed automatically when this card is next read at the desk.
        </Notice>
      )}
      {result.card?.warnings?.length > 0 && <Warnings warnings={result.card.warnings} />}
      <Receipt txn={txn} consumer={consumer} />
      <div className="row gap no-print">
        <button className="btn btn-lg" onClick={() => window.print()}>
          Print receipt
        </button>
        <button className="btn btn-primary btn-lg" onClick={onAgain}>
          Register another
        </button>
      </div>
    </div>
  );
}
