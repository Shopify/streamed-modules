import React, {useMemo, useState} from 'react';
import {orderBy, sumBy} from 'lodash-es';
import {Card, DataTable, Toolbar, Badge} from '../components/ui.jsx';
import {Chart} from '../components/Chart.jsx';
import {PRODUCTS, VENDORS} from '../lib/data.js';
import {
  compute_screen_006,
  compute_screen_007,
  summarize_screen_006,
} from '../generated/index.js';

export default function Inventory() {
  const [vendor, setVendor] = useState('all');

  const rows = useMemo(() => {
    const base =
      vendor === 'all' ? PRODUCTS : PRODUCTS.filter((p) => p.vendor === vendor);
    return orderBy(base, ['inventory'], ['asc']).slice(0, 40);
  }, [vendor]);

  const option = useMemo(() => {
    const buckets = [0, 50, 100, 250, 500, 1000];
    const counts = buckets.slice(0, -1).map((lo, i) => ({
      label: `${lo}-${buckets[i + 1]}`,
      value: PRODUCTS.filter(
        (p) => p.inventory >= lo && p.inventory < buckets[i + 1],
      ).length,
    }));
    return {
      tooltip: {},
      grid: {left: 44, right: 16, top: 24, bottom: 32},
      xAxis: {type: 'category', data: counts.map((c) => c.label)},
      yAxis: {type: 'value'},
      series: [{type: 'bar', data: counts.map((c) => c.value)}],
    };
  }, []);

  const lowStock = PRODUCTS.filter((p) => p.inventory < 25).length;

  return (
    <>
      <Toolbar>
        <label>
          Vendor{' '}
          <select value={vendor} onChange={(e) => setVendor(e.target.value)}>
            <option value="all">all ({VENDORS.length} vendors)</option>
            {VENDORS.slice(0, 20).map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <Badge tone={lowStock > 50 ? 'critical' : 'warning'}>
          {lowStock} low stock
        </Badge>
        <span className="muted">
          total units {sumBy(PRODUCTS, 'inventory').toLocaleString('en-US')} /
          screens {compute_screen_006()}+{compute_screen_007()}
        </span>
      </Toolbar>

      <div className="grid grid--2">
        <Card title="Inventory distribution">
          <Chart option={option} />
        </Card>
        <Card title="screen_006">
          <pre className="pre">{JSON.stringify(summarize_screen_006(), null, 2)}</pre>
        </Card>
      </div>

      <Card title="Lowest stock" wide>
        <DataTable
          getKey={(p) => p.id}
          rows={rows}
          columns={[
            {key: 'title', label: 'Product'},
            {key: 'vendor', label: 'Vendor'},
            {key: 'variants', label: 'Variants', numeric: true},
            {key: 'inventory', label: 'On hand', numeric: true},
            {
              key: 'price',
              label: 'Price',
              numeric: true,
              render: (p) => `$${p.price.toFixed(2)}`,
            },
          ]}
        />
      </Card>
    </>
  );
}
