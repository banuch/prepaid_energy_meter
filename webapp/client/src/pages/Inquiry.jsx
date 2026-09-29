import { useState } from 'react';
import { useReader } from '../context.jsx';
import { dateTime, money } from '../format.js';
import TapPanel, { BalanceNote, Warnings } from '../components/TapPanel.jsx';
import { KeyValues, Notice, PageHeader, StatusPill } from '../components/ui.jsx';

// Read-only: nothing here writes the card.
export default function Inquiry() {
  const { settings } = useReader();
  const [showRaw, setShowRaw] = useState(false);
  return (
    <div>
      <PageHeader title="Card inquiry" subtitle="Read-only — the card is not changed." />
      <TapPanel prompt="Tap a card to see its details">
        {(t, { reread, rereading }) => {
          const { card, record: rec } = t;
          const tariffDiffers = card.tariff && settings?.tariff && card.tariff.version !== settings.tariff.version;
          return (
            <div className="grid-2">
              <section className="panel stack">
                {rec?.known ? (
                  <>
                    <div className="consumer-head">
                      <div>
                        <h2>{rec.consumer.name}</h2>
                        <div className="muted">{rec.consumer.address}</div>
                      </div>
                      <StatusPill status={rec.cardRecord.status} />
                    </div>
                    <KeyValues
                      items={[
                        ['Meter number', <span className="mono">{rec.consumer.meter_number}</span>],
                        ['Mobile', rec.consumer.mobile],
                        ['Card issued', dateTime(rec.cardRecord.activated_at)],
                        ['Last desk recharge', rec.lastTransaction ? `${money(rec.lastTransaction.amount)} · ${dateTime(rec.lastTransaction.timestamp)}` : 'none'],
                      ]}
                    />
                  </>
                ) : (
                  <Notice kind="warn" title="Card not registered at this desk" />
                )}
                <BalanceNote />
                <Warnings warnings={rec?.warnings} />
              </section>

              <section className="panel stack">
                <h2 className="panel-title">On the card</h2>
                <KeyValues
                  items={[
                    ['Card UID', <span className="mono">{card.uid}</span>],
                    ['Latest recharge amount', card.counter ? money(card.amountPaise) : '—', 'credited once by the meter'],
                    ['Recharge #', card.counter || '—'],
                    ['Meter number', <span className="mono">{card.serviceNumber || '—'}</span>],
                    ['Tariff', card.tariff ? `version ${card.tariff.version}, ${card.tariff.slabs.length} slabs` : 'none', tariffDiffers ? `desk is on version ${settings.tariff.version}; the next recharge updates it` : null],
                    card.cycleYear ? ['Billing cycle on card', `${card.cycleYear}-${String(card.cycleMonth).padStart(2, '0')}`, 'written by the app, not updated by the meter'] : null,
                  ]}
                />
                <div className="row gap-sm">
                  <button className="btn btn-sm" onClick={reread} disabled={rereading}>
                    {rereading ? 'Reading…' : '↻ Read again'}
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => setShowRaw(!showRaw)}>
                    {showRaw ? 'Hide' : 'Show'} raw blocks
                  </button>
                </div>
                {showRaw && (
                  <table className="raw">
                    <tbody>
                      {Object.entries(card.raw).map(([b, hex]) => (
                        <tr key={b}>
                          <th>block {b}</th>
                          <td className="mono">{hex.toUpperCase().replace(/(..)/g, '$1 ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            </div>
          );
        }}
      </TapPanel>
    </div>
  );
}
