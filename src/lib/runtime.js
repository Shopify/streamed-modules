// Shared runtime used by every generated module and by the app shell.
//
// Also owns the telemetry object. The HTML normally creates `__SMP__` inline
// before anything else runs, but this file defends against being first so the
// module graph works standalone (e.g. in `vite dev`).

const g = globalThis;

g.__SMP__ ||= {
  t0: performance.now(),
  marks: Object.create(null),
  modExec: [],
  registered: [],
  mark(name, value) {
    this.marks[name] = value === undefined ? performance.now() : value;
  },
  firstLast(name) {
    const a = this.modExec;
    return a.length ? {first: a[0].t, last: a[a.length - 1].t, count: a.length} : null;
  },
};

export const telemetry = g.__SMP__;

/** Called by the build-injected epilogue at the end of every bundled module. */
g.__modExec ||= function (id, specifier) {
  g.__SMP__.modExec.push({id, s: specifier, t: performance.now()});
};

/**
 * Burn `ms` milliseconds of real CPU. Stands in for the module-level init work
 * a large app does at evaluation time (building indexes, compiling schemas,
 * registering things). Identical in both baseline and streamed builds, so it
 * never biases the comparison.
 */
export function spin(ms) {
  const end = performance.now() + ms;
  let acc = 0;
  // Enough arithmetic that the loop is not optimised away.
  while (performance.now() < end) {
    for (let i = 0; i < 2000; i++) {
      acc += Math.sqrt(i) * Math.sin(i) + (acc % 7);
    }
  }
  g.__spinSink = acc;
  return acc;
}

export function mixHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h;
}

export function registerModule(name, info) {
  const entry = {name, ...info, t: performance.now()};
  g.__SMP__.registered.push(entry);
  return entry;
}

export function moduleCount() {
  return g.__SMP__.registered.length;
}
