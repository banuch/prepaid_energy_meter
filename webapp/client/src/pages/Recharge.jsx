import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useReader } from '../context.jsx';
import { dateTime, money, PAYMENT_LABELS, rupeesToPaise } from '../format.js';
import TapPanel, { BalanceNote, CardFacts, Warnings } from '../components/TapPanel.jsx';
import Receipt from '../components/Receipt.jsx';
import { Field, Notice, PageHeader, Segmented, StatusPill } from '../components/ui.jsx';

const QUICK = [100, 200, 500, 1000, 2000];

export default function Recharge() {
  const { tap, settings } = useReader();
  const [amountText, setAmountText] = useState('');
  const [paymentMode, setPaymentMode] = useState('cash');
  const [paymentRef, setPaymentRef] = useState('');
  const [confirmTapped, setConfirmTapped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  // New card on the reader = new recharge. (Keep a finished receipt on screen
  // until the operator moves on, even after the card is lifted.)
  const tapUid = tap?.uid;
  useEffect(() => {
    setConfirmTapped(false);
    setError(null);
    setResult((r) => (r && r.card?.uid === tapUid ? r : tapUid ? null : r));
  }, [tapUid]);

  const reset = () => {
    setAmountText('');
    setPaymentRef('');
    setConfirmTapped(false);
    setError(null);
    setResult(null);
  };

  const amountPaise = rupeesToPaise(amountText);
  const min = settings?.minRechargePaise ?? 100;
  const max = settings?.maxRechargePaise ?? Infinity;
  const amountError = amountText && (amountPaise === null ? 'Enter an amount in rupees' : amountPaise < min ? `Minimum ${money(min)}` : amountPaise > max ? `Maximum ${money(max)}` : null);

  const submit = async (t) => {
    setBusy(true);
    setError(null);
    try {
      setResult(
        await api.post('/cards/recharge', {
          uid: t.uid,
          expectedCounter: t.card.counter,
          amountPaise,
          paymentMode,
          paymentRef: paymentRef.trim() || undefined,
          confirmMeterTapped: confirmTapped,
        }),
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (result) return <RechargeResult result={result} onAgain={reset} />;

  return (
    <div>
      <PageHeader title="Recharge" subtitle="The card is read fresh from the reader before anything is written." />
      <TapPanel prompt="Tap the consumer's card on the reader">
        {(t, { reread, rereading }) => {
          const rec = t.record;
          if (!rec?.known) {
            return (
              <div className="panel stack">
                <CardFacts card={t.card} />
                <Notice
                  kind="warn"
                  title="This card is not registered at this desk"
                  action={
                    <Link to="/register" className="btn btn-primary">
                      Register this card
                    </Link>
                  }
                >
                  It can't be recharged until it is issued to a consumer.
                </Notice>
                <Warnings warnings={rec?.warnings} />
              </div>
            );
          }
          const { consumer, cardRecord, lastTransaction } = rec;
          const canSubmit = rec.canRecharge && amountPaise && !amountError && (!rec.needsMeterTapConfirmation || confirmTapped) && !busy;
          return (
            <div className="grid-2">
              <section className="panel stack">
                <div className="consumer-head">
                  <div>
                    <h2>{consumer.name}</h2>
                    <div className="muted">
                      Meter <span className="mono">{consumer.meter_number}</span> · {consumer.mobile}
                    </div>
                  </div>
                  <StatusPill status={cardRecord.status} />
                </div>
                <CardFacts card={t.card} />
                <p className="muted small">
                  Last desk recharge: {lastTransaction ? `${money(lastTransaction.amount)} on ${dateTime(lastTransaction.timestamp)}${lastTransaction.operator_name ? ` by ${lastTransaction.operator_name}` : ''}` : 'none'}
                </p>
                <BalanceNote />
                <Warnings warnings={rec.warnings} />
                <button className="btn btn-sm self-start" onClick={reread} disabled={rereading}>
                  {rereading ? 'Reading…' : '↻ Read card again'}
                </button>
              </section>

              <section className="panel stack">
                {!rec.canRecharge ? (
                  <Notice kind="error" title={`Card is ${cardRecord.status}`}>
                    It can't be recharged. An admin can change its status on the consumer's page.
                  </Notice>
                ) : (
                  <>
                    <Field label="Recharge amount (₹)" error={amountError}>
                      <input className="amount-input" value={amountText} onChange={(e) => setAmountText(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" placeholder="0" autoFocus />
                    </Field>
                    <div className="quick-amounts">
                      {QUICK.filter((r) => r * 100 >= min && r * 100 <= max).map((r) => (
                        <button key={r} type="button" className={`btn btn-lg${amountPaise === r * 100 ? ' btn-selected' : ''}`} onClick={() => setAmountText(String(r))}>
                          ₹{r}
                        </button>
                      ))}
                    </div>
                    <Field label="Payment">
                      <Segmented size="lg" value={paymentMode} onChange={setPaymentMode} options={['cash', 'upi', 'card', 'cheque'].map((v) => ({ value: v, label: PAYMENT_LABELS[v] }))} />
                    </Field>
                    {paymentMode !== 'cash' && (
                      <Field label={paymentMode === 'upi' ? 'UPI transaction ID' : paymentMode === 'cheque' ? 'Cheque number' : 'Card slip / reference'} hint="Optional">
                        <input value={paymentRef} onChange={(e) => setPaymentRef(e.target.value)} maxLength={60} />
                      </Field>
                    )}
                    {rec.needsMeterTapConfirmation && (
                      <label className="check check-warn">
                        <input type="checkbox" checked={confirmTapped} onChange={(e) => setConfirmTapped(e.target.checked)} />
                        <span>
                          The consumer has <strong>tapped this card on their meter</strong> since the last recharge ({money(t.card.amountPaise)}, #{t.card.counter}).
                          <span className="muted small block">If not, send them to tap it first — this recharge replaces that amount on the card and the meter would never credit it.</span>
                        </span>
                      </label>
                    )}
                    {error && (
                      <Notice kind="error" title={error.code === 'WRITE_FAILED' ? 'Card write failed — do not collect money for this attempt' : undefined}>
                        {error.message}
                      </Notice>
                    )}
                    <button className="btn btn-primary btn-xl btn-block" disabled={!canSubmit} onClick={() => submit(t)}>
                      {busy ? 'Writing card — keep it on the reader…' : amountPaise && !amountError ? `Recharge ${money(amountPaise)}` : 'Recharge'}
                    </button>
                  </>
                )}
              </section>
            </div>
          );
        }}
      </TapPanel>
    </div>
  );
}

function RechargeResult({ result, onAgain }) {
  const { transaction: txn, consumer, committed, error, card } = result;
  return (
    <div className="result-page">
      {committed === 'yes' ? (
        <Notice kind="success" title={`Recharged ${money(txn.amount)}`}>
          Written and verified on the card (recharge #{txn.counter_after}). The consumer must tap the card on their meter to add it to the balance.
        </Notice>
      ) : (
        <Notice kind="warn" title="Card written, but not confirmed">
          {error} The transaction is saved as <strong>uncertain</strong> and is confirmed automatically the next time this card is read here — put it back on the reader now.
        </Notice>
      )}
      {card?.warnings?.length > 0 && <Warnings warnings={card.warnings} />}
      <Receipt txn={txn} consumer={consumer} />
      <div className="row gap no-print">
        <button className="btn btn-lg" onClick={() => window.print()}>
          Print receipt
        </button>
        <button className="btn btn-primary btn-lg" onClick={onAgain}>
          Next recharge
        </button>
      </div>
    </div>
  );
}
