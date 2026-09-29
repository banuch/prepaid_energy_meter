import { dateTime, money } from '../format.js';
import { StatusPill } from './ui.jsx';

function cell(col, value) {
  if (value === null || value === undefined || value === '') return <span className="muted">—</span>;
  switch (col.type) {
    case 'money':
      return money(value);
    case 'datetime':
      return dateTime(value);
    case 'status':
      return <StatusPill status={value} />;
    default:
      return String(value);
  }
}

function csvValue(col, value) {
  if (value === null || value === undefined) return '';
  let v = col.type === 'money' ? (value / 100).toFixed(2) : col.type === 'datetime' ? dateTime(value) : String(value);
  if (/[",\n]/.test(v)) v = `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function toCsv(columns, rows, totals) {
  const lines = [columns.map((c) => csvValue({}, c.label)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvValue(c, r[c.key])).join(','));
  if (totals) lines.push(columns.map((c, i) => (totals[c.key] !== undefined ? csvValue(typeof totals[c.key] === 'number' ? c : {}, totals[c.key]) : i === 0 ? 'Total' : '')).join(','));
  return lines.join('\r\n');
}

export function downloadCsv(filename, csv) {
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function DataTable({ columns, rows, totals, onRowClick, empty = 'Nothing to show.' }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.type === 'money' || c.type === 'number' ? 'num' : ''}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="empty">
                {empty}
              </td>
            </tr>
          )}
          {rows.map((r, i) => (
            <tr key={r.id ?? r.card_uid ?? i} onClick={onRowClick ? () => onRowClick(r) : undefined} className={onRowClick ? 'clickable' : ''}>
              {columns.map((c) => (
                <td key={c.key} className={`${c.type === 'money' || c.type === 'number' ? 'num' : ''}${c.mono ? ' mono' : ''}`}>
                  {c.render ? c.render(r) : cell(c, r[c.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {totals && rows.length > 0 && (
          <tfoot>
            <tr>
              {columns.map((c, i) => (
                <td key={c.key} className={c.type === 'money' || c.type === 'number' ? 'num' : ''}>
                  {totals[c.key] !== undefined ? (typeof totals[c.key] === 'number' ? cell(c, totals[c.key]) : totals[c.key]) : i === 0 ? 'Total' : ''}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
