import React, {useMemo} from 'react';
import {Card, Kpi, DataTable, Badge} from '../components/ui.jsx';
import {Chart} from '../components/Chart.jsx';
import {KPIS, REVENUE_SERIES, REGION_TOTALS, TOP_ORDERS} from '../lib/data.js';
import {
  compute_screen_000,
  summarize_screen_000,
  compute_screen_001,
  summarize_screen_001,
} from '../generated/index.js';

const STATUS_TONE = {
  paid: 'success',
  pending: 'warning',
  refunded: 'critical',
  partially_refunded: 'warning',
  failed: 'critical',
};

export default function Dashboard() {
  const revenueOption = useMemo(
    () => ({
      tooltip: {trigger: 'axis'},
      grid: {left: 48, right: 16, top: 24, bottom: 32},
      xAxis: {type: 'category', data: REVENUE_SERIES.map((d) => d.date)},
      yAxis: {type: 'value'},
      series: [
        {
          name: 'Revenue',
          type: 'line',
          smooth: true,
          areaStyle: {opacity: 0.16},
          showSymbol: false,
          data: REVENUE_SERIES.map((d) => d.revenue),
        },
      ],
    }),
    [],
  );

  const regionOption = useMemo(
    () => ({
      tooltip: {trigger: 'item'},
      legend: {bottom: 0, type: 'scroll'},
      series: [
        {
          type: 'pie',
          radius: ['42%', '68%'],
          itemStyle: {borderRadius: 4, borderWidth: 2, borderColor: '#fff'},
          data: REGION_TOTALS,
        },
      ],
    }),
    [],
  );

  const screens = [summarize_screen_000(), summarize_screen_001()];
  const checksum = compute_screen_000() + compute_screen_001();

  return (
    <>
      <div className="kpis">
        {KPIS.map((k) => (
          <Kpi key={k.label} {...k} />
        ))}
      </div>

      <div className="grid grid--2">
        <Card title="Revenue" subtitle="Last 90 days">
          <Chart option={revenueOption} height={300} />
        </Card>
        <Card title="Revenue by region">
          <Chart option={regionOption} height={300} />
        </Card>
      </div>

      <Card title="Largest orders" subtitle="Top 12 by total" wide>
        <DataTable
          getKey={(o) => o.id}
          rows={TOP_ORDERS.slice(0, 12)}
          columns={[
            {key: 'id', label: 'Order'},
            {key: 'customer', label: 'Customer'},
            {key: 'region', label: 'Region'},
            {
              key: 'status',
              label: 'Status',
              render: (o) => (
                <Badge tone={STATUS_TONE[o.status]}>{o.status}</Badge>
              ),
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

      <Card title="Feature module sanity check">
        <p className="muted">
          checksum <code>{checksum}</code> from{' '}
          {screens.map((s) => s.name).join(', ')} covering{' '}
          {screens.reduce((n, s) => n + s.depRows, 0)} dependency rows.
        </p>
      </Card>
    </>
  );
}
