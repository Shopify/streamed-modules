// Derived datasets for the views. Built at module evaluation time on purpose:
// this is the "expensive module init" that streaming execution is meant to
// overlap with the rest of the download.

import {groupBy, orderBy, sumBy, uniqBy} from 'lodash-es';
import {addDays, differenceInCalendarDays, format, startOfDay, subDays} from 'date-fns';
import {SCREEN_MODULES} from '../generated/index.js';
import {spin, mixHash} from './runtime.js';

const REGIONS = ['na-east', 'na-west', 'eu-central', 'eu-west', 'ap-south',
  'ap-northeast', 'sa-east', 'af-south'];
const STATUSES = ['paid', 'pending', 'refunded', 'partially_refunded', 'failed'];
const CHANNELS = ['online', 'pos', 'draft', 'api', 'marketplace'];

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

const rand = prng(0xc0ffee);
const today = startOfDay(new Date('2026-06-01T00:00:00Z'));

export const ORDERS = Array.from({length: 4200}, (_, i) => {
  const r = rand();
  return {
    id: `#${100000 + i}`,
    customer: `Customer ${Math.floor(rand() * 9000) + 1000}`,
    region: REGIONS[Math.floor(r * REGIONS.length)],
    status: STATUSES[Math.floor(rand() * STATUSES.length)],
    channel: CHANNELS[Math.floor(rand() * CHANNELS.length)],
    total: Math.round(rand() * 480000) / 100,
    items: 1 + Math.floor(rand() * 9),
    placedAt: subDays(today, Math.floor(rand() * 90)),
    risk: Math.round(rand() * 100),
  };
});

export const PRODUCTS = Array.from({length: 1400}, (_, i) => ({
  id: `p-${i}`,
  title: `Product ${i} ${['Tee', 'Mug', 'Hoodie', 'Cap', 'Poster', 'Bottle'][i % 6]}`,
  vendor: `Vendor ${i % 40}`,
  inventory: Math.floor(rand() * 900),
  price: Math.round(rand() * 24000) / 100,
  variants: 1 + Math.floor(rand() * 6),
  hash: mixHash(`p-${i}`),
}));

export const ORDERS_BY_REGION = groupBy(ORDERS, 'region');
export const ORDERS_BY_STATUS = groupBy(ORDERS, 'status');
export const TOP_ORDERS = orderBy(ORDERS, ['total'], ['desc']).slice(0, 50);
export const VENDORS = uniqBy(PRODUCTS, 'vendor').map((p) => p.vendor);

// One pass over the orders, bucketed by day. (An earlier version filtered the
// 4,200 orders once per day with two date-fns format() calls per comparison -
// 756k format() calls - which made this one module 84% of the app's entire
// evaluation cost, sitting 92% of the way into the bundle. That dominated every
// measurement and said nothing about the loader.)
const seriesStart = subDays(today, 89);
const dayBuckets = Array.from({length: 90}, () => ({revenue: 0, orders: 0}));
for (const order of ORDERS) {
  const day = differenceInCalendarDays(order.placedAt, seriesStart);
  if (day >= 0 && day < 90) {
    dayBuckets[day].revenue += order.total;
    dayBuckets[day].orders += 1;
  }
}
export const REVENUE_SERIES = dayBuckets.map((bucket, i) => ({
  date: format(addDays(seriesStart, i), 'MMM d'),
  revenue: Math.round(bucket.revenue),
  orders: bucket.orders,
}));

export const REGION_TOTALS = REGIONS.map((region) => ({
  name: region,
  value: Math.round(sumBy(ORDERS_BY_REGION[region] || [], 'total')),
}));

export const KPIS = [
  {label: 'Gross revenue', value: Math.round(sumBy(ORDERS, 'total')), unit: '$'},
  {label: 'Orders', value: ORDERS.length, unit: ''},
  {label: 'Products', value: PRODUCTS.length, unit: ''},
  {label: 'Screen modules', value: SCREEN_MODULES.length, unit: ''},
];

// A deliberate chunk of init cost in the data layer itself.
spin(18);
