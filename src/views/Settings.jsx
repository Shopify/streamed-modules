import React, {useState} from 'react';
import {z} from 'zod';
import {Card, Toolbar, Badge} from '../components/ui.jsx';
import {compute_screen_005, summarize_screen_005} from '../generated/index.js';

const SettingsSchema = z.object({
  storeName: z.string().min(3, 'at least 3 characters'),
  contactEmail: z.string().email('must be an email'),
  currency: z.enum(['USD', 'EUR', 'GBP', 'JPY']),
  weightUnit: z.enum(['kg', 'lb']),
  timezone: z.string().min(1),
  orderPrefix: z.string().regex(/^#?[A-Z0-9]{1,6}$/, 'up to 6 A-Z / 0-9'),
  autoArchive: z.boolean(),
  retentionDays: z.coerce.number().int().min(1).max(3650),
});

const INITIAL = {
  storeName: 'Streaming Modules Co',
  contactEmail: 'ops@example.com',
  currency: 'USD',
  weightUnit: 'kg',
  timezone: 'Europe/Berlin',
  orderPrefix: '#SM',
  autoArchive: true,
  retentionDays: 365,
};

export default function Settings() {
  const [values, setValues] = useState(INITIAL);
  const result = SettingsSchema.safeParse(values);
  const errors = result.success
    ? {}
    : Object.fromEntries(
        result.error.issues.map((i) => [i.path.join('.'), i.message]),
      );

  const set = (key) => (e) =>
    setValues((v) => ({
      ...v,
      [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value,
    }));

  return (
    <>
      <Toolbar>
        {result.success ? (
          <Badge tone="success">valid</Badge>
        ) : (
          <Badge tone="critical">{result.error.issues.length} problems</Badge>
        )}
        <span className="muted">screen_005 = {compute_screen_005()}</span>
      </Toolbar>

      <Card title="Store settings" subtitle="Validated with zod on every keystroke">
        <div className="form">
          {[
            ['storeName', 'Store name', 'text'],
            ['contactEmail', 'Contact email', 'text'],
            ['timezone', 'Timezone', 'text'],
            ['orderPrefix', 'Order prefix', 'text'],
            ['retentionDays', 'Retention (days)', 'number'],
          ].map(([key, label, type]) => (
            <label key={key} className="field">
              <span>{label}</span>
              <input type={type} value={values[key]} onChange={set(key)} />
              {errors[key] ? <em className="field__err">{errors[key]}</em> : null}
            </label>
          ))}

          <label className="field">
            <span>Currency</span>
            <select value={values.currency} onChange={set('currency')}>
              {['USD', 'EUR', 'GBP', 'JPY'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Weight unit</span>
            <select value={values.weightUnit} onChange={set('weightUnit')}>
              {['kg', 'lb'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>

          <label className="field field--inline">
            <input
              type="checkbox"
              checked={values.autoArchive}
              onChange={set('autoArchive')}
            />
            <span>Auto-archive fulfilled orders</span>
          </label>
        </div>
      </Card>

      <Card title="Parsed payload">
        <pre className="pre">
          {JSON.stringify(result.success ? result.data : errors, null, 2)}
        </pre>
      </Card>

      <Card title="screen_005 summary">
        <pre className="pre">{JSON.stringify(summarize_screen_005(), null, 2)}</pre>
      </Card>
    </>
  );
}
