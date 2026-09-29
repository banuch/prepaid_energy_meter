import { Link } from 'react-router-dom';
import { useAuth, useReader } from '../context.jsx';

const TILES = [
  { to: '/recharge', title: 'Recharge', text: 'Tap a card and add credit', icon: '₹', accent: 'primary' },
  { to: '/register', title: 'Register & issue card', text: 'New consumer or replacement card', icon: '+' },
  { to: '/inquiry', title: 'Card inquiry', text: 'Read a card without changing it', icon: 'i' },
  { to: '/consumers', title: 'Consumers', text: 'Search, edit, block or mark cards lost', icon: '☰', admin: true },
  { to: '/reports', title: 'Reports', text: 'Collections, recharges, registrations', icon: '▤', admin: true },
];

export default function Home() {
  const { operator, isAdmin } = useAuth();
  const { tap } = useReader();
  return (
    <div className="home">
      <h1 className="home-greeting">Hello, {operator.name.split(' ')[0]}</h1>
      {tap?.card && (
        <p className="muted">
          Card <span className="mono">{tap.uid}</span> is on the reader
          {tap.record?.consumer ? ` — ${tap.record.consumer.name}` : ' — not registered'}.
        </p>
      )}
      <div className="tiles">
        {TILES.filter((t) => !t.admin || isAdmin).map((t) => (
          <Link key={t.to} to={t.to} className={`tile${t.accent ? ` tile-${t.accent}` : ''}`}>
            <span className="tile-icon" aria-hidden="true">
              {t.icon}
            </span>
            <span className="tile-title">{t.title}</span>
            <span className="tile-text">{t.text}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
