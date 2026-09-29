const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });

export const money = (paise) => (paise === null || paise === undefined ? '—' : inr.format(paise / 100));

// Server timestamps are UTC "YYYY-MM-DD HH:MM:SS".
export function parseUtc(s) {
  if (!s) return null;
  return new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
}

export function dateTime(s) {
  const d = parseUtc(s);
  return d ? d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
}

export function dateOnly(s) {
  const d = parseUtc(s);
  return d ? d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
}

export function ago(s) {
  const d = parseUtc(s);
  if (!d) return 'never';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

// "123.5" -> 12350 paise; null if not a valid amount.
export function rupeesToPaise(text) {
  const t = String(text).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

export const localDate = (d = new Date()) => d.toLocaleDateString('en-CA');

export const PAYMENT_LABELS = { cash: 'Cash', upi: 'UPI', card: 'Card', cheque: 'Cheque', free: 'Free (no payment)' };
