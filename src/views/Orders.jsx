import React, {useMemo, useState} from 'react';
import {orderBy} from 'lodash-es';
import {format} from 'date-fns';
import {Card, DataTable, Badge, Toolbar} from '../components/ui.jsx';
import {ORDERS, ORDERS_BY_STATUS} from '../lib/data.js';
import {
  compute_screen_002,
  summarize_screen_002,
  compute_screen_003,
} from '../generated/index.js';

const STATUS_TONE = {
  paid: 'success',
  pending: 'warning',
  refunded: 'critical',
  partially_refunded: 'warning',
  failed: 'critical',
};

export default function Orders() {
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState('placedAt');

  const rows = useMemo(() => {
    const base = status === 'all' ? ORDERS : ORDERS_BY_STATUS[status] || [];
    return orderBy(base, [sort], [sort === 'placedAt' ? 'desc' : 'desc']).slice(0, 60);
  }, [status, sort]);

  return (
    <>
      <Toolbar>
        <label>
          Status{' '}
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">all ({ORDERS.length})</option>
            {Object.keys(ORDERS_BY_STATUS).map((s) => (
              <option key={s} value={s}>
                {s} ({ORDERS_BY_STATUS[s].length})
              </option>
            ))}
          </select>
        </label>
        <label>
          Sort{' '}
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="placedAt">newest</option>
            <option value="total">total</option>
            <option value="risk">risk</option>
            <option value="items">items</option>
          </select>
        </label>
        <span className="muted">
          screen_002 = {compute_screen_002()} / screen_003 = {compute_screen_003()}
        </span>
      </Toolbar>

      <Card title="Orders" subtitle={`${rows.length} of ${ORDERS.length}`} wide>
        <DataTable
          getKey={(o) => o.id}
          rows={rows}
          columns={[
            {key: 'id', label: 'Order'},
            {key: 'customer', label: 'Customer'},
            {key: 'channel', label: 'Channel'},
            {key: 'region', label: 'Region'},
            {
              key: 'status',
              label: 'Status',
              render: (o) => <Badge tone={STATUS_TONE[o.status]}>{o.status}</Badge>,
            },
            {key: 'items', label: 'Items', numeric: true},
            {
              key: 'risk',
              label: 'Risk',
              numeric: true,
              render: (o) => `${o.risk}%`,
            },
            {
              key: 'placedAt',
              label: 'Placed',
              render: (o) => format(o.placedAt, 'MMM d, yyyy'),
            },
            {
              key: 'total',
              label: 'Total',
              numeric: true,
              render: (o) => `$${o.total.toFixed(2)}`,
            },
          ]}
        />
      </Card>

      <Card title="Screen summary">
        <pre className="pre">{JSON.stringify(summarize_screen_002(), null, 2)}</pre>
      </Card>
    </>
  );
}
