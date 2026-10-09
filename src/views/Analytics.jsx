import React, {useMemo} from 'react';
import {Card} from '../components/ui.jsx';
import {Chart} from '../components/Chart.jsx';
import {REVENUE_SERIES, ORDERS_BY_REGION} from '../lib/data.js';
import {SCREEN_MODULES} from '../generated/index.js';
import {telemetry} from '../lib/runtime.js';

export default function Analytics() {
  const ordersOption = useMemo(
    () => ({
      tooltip: {trigger: 'axis'},
      legend: {top: 0},
      grid: {left: 48, right: 16, top: 36, bottom: 32},
      xAxis: {type: 'category', data: REVENUE_SERIES.map((d) => d.date)},
      yAxis: [{type: 'value'}, {type: 'value'}],
      series: [
        {name: 'Orders', type: 'bar', data: REVENUE_SERIES.map((d) => d.orders)},
        {
          name: 'Revenue',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          showSymbol: false,
          data: REVENUE_SERIES.map((d) => d.revenue),
        },
      ],
    }),
    [],
  );

  const execOption = useMemo(() => {
    const execs = telemetry.modExec;
    if (!execs.length) return null;
    const t0 = execs[0].t;
    return {
      tooltip: {trigger: 'axis'},
      grid: {left: 56, right: 16, top: 24, bottom: 36},
      xAxis: {
        type: 'value',
        name: 'ms since first module',
        nameLocation: 'middle',
        nameGap: 24,
      },
      yAxis: {type: 'value', name: 'modules evaluated'},
      series: [
        {
          type: 'line',
          step: 'end',
          showSymbol: false,
          data: execs.map((e, i) => [+(e.t - t0).toFixed(1), i + 1]),
        },
      ],
    };
  }, []);

  return (
    <>
      <div className="grid grid--2">
        <Card title="Orders and revenue" subtitle="Last 90 days">
          <Chart option={ordersOption} height={300} />
        </Card>
        <Card
          title="Module evaluation over time"
          subtitle="Recorded by the build-injected epilogue"
        >
          {execOption ? (
            <Chart option={execOption} height={300} />
          ) : (
            <p className="muted">
              No per-module data. This build was not instrumented (baseline
              bundles report a single module).
            </p>
          )}
        </Card>
      </div>

      <Card title="Regions" wide>
        <div className="kpis">
          {Object.entries(ORDERS_BY_REGION).map(([region, orders]) => (
            <div className="kpi" key={region}>
              <span className="kpi__label">{region}</span>
              <strong className="kpi__value">{orders.length}</strong>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Screen modules">
        <p className="muted">{SCREEN_MODULES.join(', ')}</p>
      </Card>
    </>
  );
}
