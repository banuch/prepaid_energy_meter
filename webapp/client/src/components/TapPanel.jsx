import { useState } from 'react';
import { useReader } from '../context.jsx';
import { money } from '../format.js';
import { Notice } from './ui.jsx';

// The "tap a card" area shared by Register, Recharge and Inquiry. Shows the
// reader state until a card is read, then renders `children(tap)`.
export default function TapPanel({ prompt, children }) {
  const { status, tap, socketUp, reread } = useReader();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const doReread = async () => {
    setBusy(true);
    setError(null);
    try {
      await reread();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!socketUp || !status) {
    return <div className="tap-zone tap-offline">Connecting to the recharge station…</div>;
  }
  if (!status.connected) {
    return (
      <div className="tap-zone tap-offline">
        <div className="tap-icon">⚠</div>
        <strong>NFC reader not connected</strong>
        <span className="muted">{status.error || 'Waiting for the PN532…'}</span>
        <span className="muted small">Retrying automatically every few seconds.</span>
      </div>
    );
  }
  if (!tap) {
    return (
      <div className="tap-zone tap-waiting">
        <div className="tap-rings" aria-hidden="true">
          <span />
          <span />
          <div className="tap-card-icon">
            <svg viewBox="0 0 48 32" width="48" height="32">
              <rect x="1" y="1" width="46" height="30" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M30 10c3 3 3 9 0 12M35 7c5 5 5 13 0 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <rect x="7" y="9" width="10" height="8" rx="1.5" fill="currentColor" />
            </svg>
          </div>
        </div>
        <strong className="tap-prompt">{prompt}</strong>
        <span className="muted small">Hold the card flat on the reader until the details appear.</span>
      </div>
    );
  }
  if (tap.error || !tap.card) {
    return (
      <div className="tap-zone tap-error">
        <Notice
          kind="error"
          title={`Couldn't read card ${tap.uid || ''}`}
          action={
            <button className="btn" onClick={doReread} disabled={busy}>
              {busy ? 'Reading…' : 'Read again'}
            </button>
          }
        >
          {tap.error} — hold the card steady on the reader, or lift it and tap again.
        </Notice>
        {error && <Notice kind="error">{error}</Notice>}
      </div>
    );
  }
  return (
    <div className="tap-result">
      {children(tap, { reread: doReread, rereading: busy })}
      {error && <Notice kind="error">{error}</Notice>}
    </div>
  );
}

// What's physically on the card, stated honestly: last recharge + counter,
// never a balance.
export function CardFacts({ card }) {
  return (
    <div className="card-facts">
      <div className="fact">
        <span className="fact-label">Card UID</span>
        <span className="fact-value mono">{card.uid}</span>
      </div>
      <div className="fact">
        <span className="fact-label">Last recharge on card</span>
        <span className="fact-value">{card.counter ? money(card.amountPaise) : '—'}</span>
      </div>
      <div className="fact">
        <span className="fact-label">Recharge #</span>
        <span className="fact-value">{card.counter || '—'}</span>
      </div>
      <div className="fact">
        <span className="fact-label">Meter on card</span>
        <span className="fact-value mono">{card.serviceNumber || '—'}</span>
      </div>
    </div>
  );
}

export function BalanceNote() {
  return (
    <p className="balance-note">
      <strong>Balance is not on the card.</strong> The meter keeps the running balance itself and never writes it back. Check the meter display for the
      current balance.
    </p>
  );
}

export function Warnings({ warnings }) {
  if (!warnings?.length) return null;
  return (
    <div className="stack-sm">
      {warnings.map((w) => (
        <Notice key={w} kind="warn">
          {w}
        </Notice>
      ))}
    </div>
  );
}
