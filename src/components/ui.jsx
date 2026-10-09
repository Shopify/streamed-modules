import React from 'react';

export function Card({title, subtitle, children, wide}) {
  return (
    <section className={wide ? 'card card--wide' : 'card'}>
      {title ? (
        <header className="card__head">
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </header>
      ) : null}
      <div className="card__body">{children}</div>
    </section>
  );
}

export function Kpi({label, value, unit}) {
  const formatted =
    unit === '$'
      ? `$${value.toLocaleString('en-US')}`
      : value.toLocaleString('en-US');
  return (
    <div className="kpi">
      <span className="kpi__label">{label}</span>
      <strong className="kpi__value">{formatted}</strong>
    </div>
  );
}

export function Badge({tone, children}) {
  return <span className={`badge badge--${tone || 'default'}`}>{children}</span>;
}

export function DataTable({columns, rows, getKey}) {
  return (
    <div className="table__scroll">
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.numeric ? 'num' : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={getKey(row)}>
              {columns.map((c) => (
                <td key={c.key} className={c.numeric ? 'num' : undefined}>
                  {c.render ? c.render(row) : String(row[c.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Toolbar({children}) {
  return <div className="toolbar">{children}</div>;
}

export function Spinner({label}) {
  return (
    <div className="spinner">
      <div className="spinner__dot" />
      <span>{label || 'Loading'}</span>
    </div>
  );
}
