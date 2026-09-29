import { useEffect } from 'react';

export function Field({ label, error, hint, children, wide }) {
  return (
    <label className={`field${wide ? ' field-wide' : ''}${error ? ' field-error' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-msg">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Notice({ kind = 'info', title, children, action }) {
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div className="notice-body">
        {title && <strong className="notice-title">{title}</strong>}
        {children && <div>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function Segmented({ options, value, onChange, size }) {
  return (
    <div className={`segmented${size === 'lg' ? ' segmented-lg' : ''}`} role="radiogroup">
      {options.map((o) => (
        <button
          type="button"
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          className={value === o.value ? 'active' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, footer }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function StatusPill({ status }) {
  return <span className={`pill pill-${status}`}>{status}</span>;
}

export function PageHeader({ title, subtitle, children }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}

export function KeyValues({ items }) {
  return (
    <dl className="kv">
      {items.filter(Boolean).map(([k, v, note]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>
            {v}
            {note && <span className="kv-note">{note}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
