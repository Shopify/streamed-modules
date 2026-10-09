import React from 'react';
import {Card, DataTable} from '../components/ui.jsx';
import {telemetry} from '../lib/runtime.js';

function ms(v) {
  return v == null ? '—' : `${v.toFixed(1)} ms`;
}

export default function Timeline() {
  const m = telemetry.marks;
  const execs = telemetry.modExec;
  const rows = [
    ['navigationStart → html parsed', m.htmlParsed],
    ['loader started fetch', m.streamStart],
    ['first byte of bundle', m.firstByte],
    ['first module evaluated', m.firstModule],
    ['last module evaluated', m.lastModule],
    ['bundle fully downloaded', m.downloadDone],
    ['React mounted', m.mounted],
    ['first paint after mount', m.rendered],
  ]
    .filter(([, v]) => v != null)
    .map(([label, v]) => ({label, v}));

  const slowest = [...execs]
    .map((e, i) => ({
      ...e,
      dur: i === 0 ? 0 : e.t - execs[i - 1].t,
    }))
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 15);

  return (
    <>
      <Card title="Load timeline" subtitle="All times relative to navigation start" wide>
        <DataTable
          getKey={(r) => r.label}
          rows={rows}
          columns={[
            {key: 'label', label: 'Milestone'},
            {key: 'v', label: 'When', numeric: true, render: (r) => ms(r.v)},
          ]}
        />
      </Card>

      <Card title="Module evaluation" subtitle={`${execs.length} modules reported`}>
        {execs.length > 1 ? (
          <p className="muted">
            Spread over{' '}
            <strong>{ms(execs[execs.length - 1].t - execs[0].t)}</strong> of
            wall clock, i.e. evaluation was interleaved with the download rather
            than happening after it.
          </p>
        ) : (
          <p className="muted">
            Single module reported: this is the baseline build, where nothing can
            run until the whole bundle has arrived.
          </p>
        )}
      </Card>

      {slowest.length > 1 ? (
        <Card title="Costliest module gaps" subtitle="Time between consecutive evaluations" wide>
          <DataTable
            getKey={(r) => r.id}
            rows={slowest}
            columns={[
              {key: 's', label: 'Specifier'},
              {key: 't', label: 'At', numeric: true, render: (r) => ms(r.t)},
              {key: 'dur', label: 'Gap', numeric: true, render: (r) => ms(r.dur)},
            ]}
          />
        </Card>
      ) : null}
    </>
  );
}
