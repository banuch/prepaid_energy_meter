import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useReader } from '../context.jsx';

// Only shown when the server runs with NFC_MOCK=1: stands in for putting
// physical cards on the PN532.
export default function MockReader() {
  const { status, tap } = useReader();
  const [open, setOpen] = useState(false);
  const [cards, setCards] = useState([]);
  const [faultBlock, setFaultBlock] = useState('5');
  const [msg, setMsg] = useState('');

  const load = useCallback(() => api.get('/dev/mock-cards').then((r) => setCards(r.cards)), []);
  useEffect(() => {
    if (open) load();
  }, [open, load, tap]);

  if (status?.mode !== 'mock') return null;

  const act = async (fn) => {
    setMsg('');
    try {
      const r = await fn();
      if (r?.cards) setCards(r.cards);
    } catch (e) {
      setMsg(e.message);
    }
  };

  return (
    <div className={`mock ${open ? 'mock-open' : ''}`}>
      <button className="mock-toggle" onClick={() => setOpen(!open)}>
        🧪 Mock reader {open ? '▾' : '▴'}
      </button>
      {open && (
        <div className="mock-body">
          <p className="small muted">Emulated PN532 — no hardware. Click a card to put it on the reader.</p>
          <ul className="mock-cards">
            {cards.map((c) => (
              <li key={c.uid} className={c.inField ? 'in-field' : ''}>
                <button className="btn btn-sm" onClick={() => act(() => (c.inField ? api.post('/dev/mock-cards-remove') : api.post(`/dev/mock-cards/${c.uid}/tap`)))}>
                  {c.inField ? 'Lift' : 'Tap'}
                </button>
                <span className="mono">{c.uid}</span>
                {c.inField && <span className="pill pill-active">on reader</span>}
              </li>
            ))}
          </ul>
          <div className="row gap-sm">
            <button className="btn btn-sm" onClick={() => act(() => api.post('/dev/mock-cards'))}>
              + New blank card
            </button>
          </div>
          <div className="row gap-sm mock-fault">
            <span className="small">Fail next write to block</span>
            <select value={faultBlock} onChange={(e) => setFaultBlock(e.target.value)}>
              {[4, 5, 6, 8, 9, 10].map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
            <button className="btn btn-sm" onClick={() => act(() => api.post('/dev/mock-fault', { block: Number(faultBlock) }).then(() => setMsg(`Next write to block ${faultBlock} will fail.`)))}>
              Arm
            </button>
          </div>
          {msg && <p className="small">{msg}</p>}
        </div>
      )}
    </div>
  );
}
