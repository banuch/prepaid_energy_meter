import { dateTime, money, PAYMENT_LABELS } from '../format.js';

export default function Receipt({ txn, consumer }) {
  return (
    <div className="receipt printable">
      <div className="receipt-head">
        <strong>EM&amp;W Section — Prepaid Energy Meter</strong>
        <span>{txn.type === 'issue' ? 'Card Issue Receipt' : 'Recharge Receipt'}</span>
      </div>
      <dl className="receipt-lines">
        <dt>Receipt no.</dt>
        <dd className="mono">{txn.receipt_no}</dd>
        <dt>Date</dt>
        <dd>{dateTime(txn.timestamp)}</dd>
        <dt>Consumer</dt>
        <dd>{consumer?.name || txn.consumer_name}</dd>
        <dt>Mobile</dt>
        <dd>{consumer?.mobile || txn.mobile}</dd>
        <dt>Meter no.</dt>
        <dd className="mono">{txn.meter_number}</dd>
        <dt>Card</dt>
        <dd className="mono">{txn.card_uid}</dd>
        <dt>Recharge #</dt>
        <dd>{txn.counter_after}</dd>
        <dt>Paid by</dt>
        <dd>
          {PAYMENT_LABELS[txn.payment_mode]}
          {txn.payment_ref ? ` (${txn.payment_ref})` : ''}
        </dd>
        <dt>Operator</dt>
        <dd>{txn.operator_name || '—'}</dd>
      </dl>
      <div className="receipt-amount">
        <span>Amount</span>
        <strong>{money(txn.amount)}</strong>
      </div>
      <p className="receipt-foot">Tap this card on your meter to add the amount to your balance. Recharge is credited once per card write.</p>
    </div>
  );
}
