import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, qs } from '../api.js';
import DataTable from '../components/DataTable.jsx';
import { PageHeader } from '../components/ui.jsx';

const PAGE = 50;

export default function Consumers() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState({ consumers: [], total: 0 });
  const [error, setError] = useState(null);

  useEffect(() => {
    const t = setTimeout(
      () =>
        api
          .get(`/consumers${qs({ q, limit: PAGE, offset })}`)
          .then(setData)
          .catch((e) => setError(e.message)),
      150,
    );
    return () => clearTimeout(t);
  }, [q, offset]);

  return (
    <div>
      <PageHeader title="Consumers" subtitle={`${data.total} consumer${data.total === 1 ? '' : 's'}`} />
      <input
        className="search"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOffset(0);
        }}
        placeholder="Search name, mobile, meter number or ID"
        autoFocus
      />
      {error && <p className="error-text">{error}</p>}
      <DataTable
        columns={[
          { key: 'id', label: 'ID', type: 'number' },
          { key: 'name', label: 'Name' },
          { key: 'mobile', label: 'Mobile' },
          { key: 'meter_number', label: 'Meter', mono: true },
          { key: 'active_card_uids', label: 'Active card', mono: true, render: (r) => r.active_card_uids || <span className="pill pill-lost">none</span> },
          { key: 'last_recharge_at', label: 'Last recharge', type: 'datetime' },
        ]}
        rows={data.consumers}
        onRowClick={(r) => navigate(`/consumers/${r.id}`)}
        empty={q ? 'No consumer matches.' : 'No consumers registered yet.'}
      />
      {data.total > PAGE && (
        <div className="row gap-sm pager">
          <button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            ← Previous
          </button>
          <span className="muted">
            {offset + 1}–{Math.min(offset + PAGE, data.total)} of {data.total}
          </span>
          <button className="btn" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
