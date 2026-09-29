// Reports — built ONLY from what the desk itself recorded (registrations,
// card issues, recharges it wrote). Nothing here is, or claims to be, live
// meter data: the meter never reports consumption or balance back.
//
// Every report returns { title, note, columns, rows, totals }.
// Column types: text | number | money (paise) | date | datetime | status.
// Date filters are local calendar dates (YYYY-MM-DD).

'use strict';

const { badRequest } = require('../errors');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateRange(params, column) {
  const where = [];
  const args = [];
  if (params.from) {
    if (!DATE_RE.test(params.from)) throw badRequest('from must be YYYY-MM-DD');
    where.push(`date(${column}, 'localtime') >= ?`);
    args.push(params.from);
  }
  if (params.to) {
    if (!DATE_RE.test(params.to)) throw badRequest('to must be YYYY-MM-DD');
    where.push(`date(${column}, 'localtime') <= ?`);
    args.push(params.to);
  }
  return { where, args };
}

function consumerFilter(params, where, args, alias = 'c') {
  if (params.consumer) {
    const term = String(params.consumer).trim();
    if (/^\d+$/.test(term) && term.length < 6) {
      where.push(`${alias}.id = ?`);
      args.push(Number(term));
    } else {
      where.push(`(${alias}.name LIKE ? OR ${alias}.mobile LIKE ?)`);
      args.push(`%${term}%`, `%${term}%`);
    }
  }
  if (params.meter) {
    where.push(`${alias}.meter_number LIKE ?`);
    args.push(`%${String(params.meter).trim()}%`);
  }
}

const clause = (where) => (where.length ? `WHERE ${where.join(' AND ')}` : '');

const sum = (rows, key) => rows.reduce((s, r) => s + (r[key] || 0), 0);

const REPORTS = {
  'card-issue': {
    title: 'Card Issue Report',
    run(db, p) {
      const { where, args } = dateRange(p, 'k.activated_at');
      consumerFilter(p, where, args);
      if (p.status) {
        where.push('k.status = ?');
        args.push(p.status);
      }
      const rows = db
        .prepare(
          `SELECT k.activated_at, k.card_uid, c.name AS consumer, c.mobile, c.meter_number, k.status,
                  k.status_note, o.name AS issued_by,
                  (SELECT t.amount FROM recharge_transactions t WHERE t.card_uid = k.card_uid AND t.type = 'issue' ORDER BY t.id LIMIT 1) AS initial_credit
           FROM cards k JOIN consumers c ON c.id = k.consumer_id LEFT JOIN operators o ON o.id = k.activated_by
           ${clause(where)} ORDER BY k.activated_at DESC`,
        )
        .all(...args);
      return {
        columns: [
          { key: 'activated_at', label: 'Issued', type: 'datetime' },
          { key: 'card_uid', label: 'Card UID', type: 'text' },
          { key: 'consumer', label: 'Consumer', type: 'text' },
          { key: 'mobile', label: 'Mobile', type: 'text' },
          { key: 'meter_number', label: 'Meter', type: 'text' },
          { key: 'initial_credit', label: 'Initial credit', type: 'money' },
          { key: 'status', label: 'Status', type: 'status' },
          { key: 'status_note', label: 'Note', type: 'text' },
          { key: 'issued_by', label: 'Issued by', type: 'text' },
        ],
        rows,
        totals: { card_uid: `${rows.length} cards`, initial_credit: sum(rows, 'initial_credit') },
      };
    },
  },

  'recharge-history': {
    title: 'Recharge History',
    note: 'Every card write the desk made, including failed and unconfirmed attempts (see Status). Only "completed" rows count as collections.',
    run(db, p) {
      const { where, args } = dateRange(p, 't.timestamp');
      consumerFilter(p, where, args);
      if (p.status) {
        where.push('t.status = ?');
        args.push(p.status);
      }
      if (p.type) {
        where.push('t.type = ?');
        args.push(p.type);
      }
      if (p.paymentMode) {
        where.push('t.payment_mode = ?');
        args.push(p.paymentMode);
      }
      const rows = db
        .prepare(
          `SELECT t.timestamp, t.receipt_no, t.type, c.name AS consumer, t.meter_number, t.card_uid, t.amount,
                  t.payment_mode, t.payment_ref, t.counter_after, t.status, t.error, o.name AS operator
           FROM recharge_transactions t JOIN consumers c ON c.id = t.consumer_id LEFT JOIN operators o ON o.id = t.operator_id
           ${clause(where)} ORDER BY t.id DESC`,
        )
        .all(...args);
      const completed = rows.filter((r) => r.status === 'completed');
      return {
        columns: [
          { key: 'timestamp', label: 'Date / time', type: 'datetime' },
          { key: 'receipt_no', label: 'Receipt', type: 'text' },
          { key: 'type', label: 'Type', type: 'text' },
          { key: 'consumer', label: 'Consumer', type: 'text' },
          { key: 'meter_number', label: 'Meter', type: 'text' },
          { key: 'card_uid', label: 'Card', type: 'text' },
          { key: 'amount', label: 'Amount', type: 'money' },
          { key: 'payment_mode', label: 'Paid by', type: 'text' },
          { key: 'payment_ref', label: 'Ref', type: 'text' },
          { key: 'counter_after', label: 'Recharge #', type: 'number' },
          { key: 'status', label: 'Status', type: 'status' },
          { key: 'operator', label: 'Operator', type: 'text' },
        ],
        rows,
        totals: { receipt_no: `${completed.length} completed`, amount: sum(completed, 'amount') },
        totalsNote: 'Total counts completed transactions only.',
      };
    },
  },

  'payment-collection': {
    title: 'Payment Collection Report',
    note: 'Money collected at the desk: completed card writes only, excluding free credit. Grouped by payment mode and operator.',
    run(db, p) {
      const { where, args } = dateRange(p, 't.timestamp');
      where.push("t.status = 'completed'", "t.payment_mode <> 'free'");
      const rows = db
        .prepare(
          `SELECT t.payment_mode, COALESCE(o.name, '—') AS operator,
                  SUM(CASE WHEN t.type = 'recharge' THEN 1 ELSE 0 END) AS recharges,
                  SUM(CASE WHEN t.type = 'issue' THEN 1 ELSE 0 END) AS card_issues,
                  COUNT(*) AS transactions, SUM(t.amount) AS amount
           FROM recharge_transactions t LEFT JOIN operators o ON o.id = t.operator_id
           ${clause(where)} GROUP BY t.payment_mode, o.id ORDER BY t.payment_mode, operator`,
        )
        .all(...args);
      return {
        columns: [
          { key: 'payment_mode', label: 'Payment mode', type: 'text' },
          { key: 'operator', label: 'Operator', type: 'text' },
          { key: 'recharges', label: 'Recharges', type: 'number' },
          { key: 'card_issues', label: 'Card issues', type: 'number' },
          { key: 'transactions', label: 'Transactions', type: 'number' },
          { key: 'amount', label: 'Collected', type: 'money' },
        ],
        rows,
        totals: { recharges: sum(rows, 'recharges'), card_issues: sum(rows, 'card_issues'), transactions: sum(rows, 'transactions'), amount: sum(rows, 'amount') },
      };
    },
  },

  'collection-summary': {
    title: 'Collection Summary',
    note: 'Completed transactions excluding free credit, by local day or month.',
    run(db, p) {
      const monthly = p.period === 'monthly';
      const bucket = monthly ? "strftime('%Y-%m', t.timestamp, 'localtime')" : "date(t.timestamp, 'localtime')";
      const { where, args } = dateRange(p, 't.timestamp');
      where.push("t.status = 'completed'", "t.payment_mode <> 'free'");
      const rows = db
        .prepare(
          `SELECT ${bucket} AS period,
                  COUNT(*) AS transactions,
                  COUNT(DISTINCT t.consumer_id) AS consumers,
                  SUM(CASE WHEN t.payment_mode = 'cash' THEN t.amount ELSE 0 END) AS cash,
                  SUM(CASE WHEN t.payment_mode = 'upi' THEN t.amount ELSE 0 END) AS upi,
                  SUM(CASE WHEN t.payment_mode IN ('card', 'cheque') THEN t.amount ELSE 0 END) AS other,
                  SUM(t.amount) AS amount
           FROM recharge_transactions t ${clause(where)} GROUP BY period ORDER BY period DESC`,
        )
        .all(...args);
      return {
        title: monthly ? 'Monthly Collection Summary' : 'Daily Collection Summary',
        columns: [
          { key: 'period', label: monthly ? 'Month' : 'Date', type: 'text' },
          { key: 'transactions', label: 'Transactions', type: 'number' },
          { key: 'consumers', label: 'Consumers', type: 'number' },
          { key: 'cash', label: 'Cash', type: 'money' },
          { key: 'upi', label: 'UPI', type: 'money' },
          { key: 'other', label: 'Card / cheque', type: 'money' },
          { key: 'amount', label: 'Total', type: 'money' },
        ],
        rows,
        totals: { transactions: sum(rows, 'transactions'), cash: sum(rows, 'cash'), upi: sum(rows, 'upi'), other: sum(rows, 'other'), amount: sum(rows, 'amount') },
      };
    },
  },

  'consumer-registration': {
    title: 'Consumer Registration Report',
    run(db, p) {
      const { where, args } = dateRange(p, 'c.created_at');
      consumerFilter(p, where, args);
      const rows = db
        .prepare(
          `SELECT c.created_at, c.id, c.name, c.mobile, c.address, c.meter_number, o.name AS registered_by,
                  (SELECT COUNT(*) FROM cards k WHERE k.consumer_id = c.id) AS cards,
                  (SELECT COUNT(*) FROM cards k WHERE k.consumer_id = c.id AND k.status = 'active') AS active_cards
           FROM consumers c LEFT JOIN operators o ON o.id = c.created_by
           ${clause(where)} ORDER BY c.created_at DESC`,
        )
        .all(...args);
      return {
        columns: [
          { key: 'created_at', label: 'Registered', type: 'datetime' },
          { key: 'id', label: 'ID', type: 'number' },
          { key: 'name', label: 'Name', type: 'text' },
          { key: 'mobile', label: 'Mobile', type: 'text' },
          { key: 'address', label: 'Address', type: 'text' },
          { key: 'meter_number', label: 'Meter', type: 'text' },
          { key: 'cards', label: 'Cards issued', type: 'number' },
          { key: 'active_cards', label: 'Active cards', type: 'number' },
          { key: 'registered_by', label: 'Registered by', type: 'text' },
        ],
        rows,
        totals: { name: `${rows.length} consumers`, cards: sum(rows, 'cards') },
      };
    },
  },

  'meter-wise': {
    title: 'Meter-wise Recharge Report',
    note: 'Totals of completed desk recharges per meter in the period. This is money credited via the desk — not energy consumed, which the desk never sees.',
    run(db, p) {
      const { where, args } = dateRange(p, 't.timestamp');
      where.push("t.status = 'completed'");
      consumerFilter(p, where, args);
      const rows = db
        .prepare(
          `SELECT t.meter_number, c.name AS consumer, c.mobile,
                  SUM(CASE WHEN t.type = 'recharge' THEN 1 ELSE 0 END) AS recharges,
                  SUM(t.amount) AS amount,
                  MAX(t.timestamp) AS last_recharge,
                  MAX(t.counter_after) AS last_counter
           FROM recharge_transactions t JOIN consumers c ON c.id = t.consumer_id
           ${clause(where)} GROUP BY t.meter_number, c.id ORDER BY amount DESC`,
        )
        .all(...args);
      return {
        columns: [
          { key: 'meter_number', label: 'Meter', type: 'text' },
          { key: 'consumer', label: 'Consumer', type: 'text' },
          { key: 'mobile', label: 'Mobile', type: 'text' },
          { key: 'recharges', label: 'Recharges', type: 'number' },
          { key: 'amount', label: 'Credited (incl. issue)', type: 'money' },
          { key: 'last_recharge', label: 'Last desk recharge', type: 'datetime' },
          { key: 'last_counter', label: 'Last recharge #', type: 'number' },
        ],
        rows,
        totals: { meter_number: `${rows.length} meters`, recharges: sum(rows, 'recharges'), amount: sum(rows, 'amount') },
      };
    },
  },

  'cards-not-seen': {
    title: 'Cards Not Seen at the Desk',
    note: 'Based ONLY on the last time each active card was tapped at this desk. It says nothing about whether the meter is in use or what its balance is — the meter never reports back.',
    run(db, p) {
      const days = p.days === undefined || p.days === '' ? 30 : Number(p.days);
      if (!Number.isInteger(days) || days < 0 || days > 3650) throw badRequest('days must be 0-3650');
      const where = ["k.status = 'active'", `(k.last_seen_at IS NULL OR k.last_seen_at < datetime('now', ?))`];
      const args = [`-${days} days`];
      consumerFilter(p, where, args);
      const rows = db
        .prepare(
          `SELECT k.card_uid, c.name AS consumer, c.mobile, c.meter_number, k.last_seen_at,
                  CAST(julianday('now') - julianday(k.last_seen_at) AS INTEGER) AS days_since,
                  k.last_seen_amount, k.last_seen_counter
           FROM cards k JOIN consumers c ON c.id = k.consumer_id
           ${clause(where)} ORDER BY k.last_seen_at IS NOT NULL, k.last_seen_at`,
        )
        .all(...args);
      return {
        title: `Cards Not Seen at the Desk for ${days}+ Days`,
        columns: [
          { key: 'card_uid', label: 'Card', type: 'text' },
          { key: 'consumer', label: 'Consumer', type: 'text' },
          { key: 'mobile', label: 'Mobile', type: 'text' },
          { key: 'meter_number', label: 'Meter', type: 'text' },
          { key: 'last_seen_at', label: 'Last desk visit', type: 'datetime' },
          { key: 'days_since', label: 'Days since', type: 'number' },
          { key: 'last_seen_amount', label: 'Last recharge on card (as of last desk visit)', type: 'money' },
          { key: 'last_seen_counter', label: 'Recharge # (as of last desk visit)', type: 'number' },
        ],
        rows,
        totals: { card_uid: `${rows.length} cards` },
      };
    },
  },
};

function listReports() {
  return Object.entries(REPORTS).map(([id, r]) => ({ id, title: r.title, note: r.note || null }));
}

function runReport(db, id, params) {
  const report = REPORTS[id];
  if (!report) throw badRequest(`Unknown report "${id}"`);
  const result = report.run(db, params);
  return { id, title: report.title, note: report.note || null, ...result, generatedAt: new Date().toISOString() };
}

module.exports = { listReports, runReport };
