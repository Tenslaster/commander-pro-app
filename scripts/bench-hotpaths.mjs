#!/usr/bin/env node
/**
 * Commander PRO — hot-path before/after benchmark
 *
 * BEFORE = frozen copies of the 1.5.6 algorithms (exact source at this work).
 * AFTER  = live modules (smartPoll, appConfig) + optimized twins of LRU / loop / merge.
 *
 * Run: node scripts/bench-hotpaths.mjs
 */
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ITER = {
  lru: 80,
  lruKeys: 800,
  fp: 40_000,
  merge: 20_000,
  budget: 200_000,
  loop: 1_200,
  nonce: 50_000,
  rewrite: 80_000,
  dedupe: 30_000,
  races: 2_000,
};

// ─────────────────────────────────────────────
// BEFORE (frozen 1.5.6)
// ─────────────────────────────────────────────

function beforeMemEvict(mem, max = 120) {
  if (mem.size <= max) return;
  const drop = mem.size - max + 8;
  for (let d = 0; d < drop; d += 1) {
    let oldestKey = null;
    let oldestTs = Infinity;
    for (const [k, v] of mem) {
      const ts = v.lastAccess || v.ts || 0;
      if (ts < oldestTs) {
        oldestTs = ts;
        oldestKey = k;
      }
    }
    if (oldestKey == null) break;
    mem.delete(oldestKey);
  }
}

function afterMemEvict(mem, max = 120) {
  if (mem.size <= max) return;
  const drop = mem.size - max + 8;
  const entries = new Array(mem.size);
  let i = 0;
  for (const [k, v] of mem) {
    entries[i] = [k, v.lastAccess || v.ts || 0];
    i += 1;
  }
  entries.sort((a, b) => a[1] - b[1]);
  const n = Math.min(drop, entries.length);
  for (let j = 0; j < n; j += 1) mem.delete(entries[j][0]);
}

function beforeFingerprintProcesses(list) {
  if (!Array.isArray(list) || !list.length) return '0';
  let s = String(list.length);
  for (let i = 0; i < list.length; i += 1) {
    const p = list[i];
    s += `|${p.id}:${p.status}:${p.pid || 0}:${p.auto_restart ? 1 : 0}`;
  }
  return s;
}

function afterFingerprintProcesses(list) {
  // V8 string += beat Array.join on this size — keep the faster form.
  return beforeFingerprintProcesses(list);
}

function beforeFingerprintStreams(map, stationId) {
  if (!map || typeof map !== 'object') return '';
  if (stationId && map[stationId]) {
    const a = map[stationId];
    return `${stationId}|${a.title || ''}|${a.listeners ?? 'x'}|${a.online ? 1 : 0}|${a.stream_url || ''}`;
  }
  const keys = Object.keys(map).sort();
  let s = String(keys.length);
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    const a = map[k] || {};
    s += `|${k}:${a.title || ''}:${a.listeners ?? 'x'}:${a.online ? 1 : 0}`;
  }
  return s;
}

function afterFingerprintStreams(map, stationId) {
  return beforeFingerprintStreams(map, stationId);
}

const processRowEqual = (a, b) =>
  a === b ||
  (!!a &&
    !!b &&
    a.id === b.id &&
    a.status === b.status &&
    a.pid === b.pid &&
    a.name === b.name &&
    a.auto_restart === b.auto_restart &&
    a.is_bot === b.is_bot &&
    a.room_id === b.room_id &&
    a.api_key_masked === b.api_key_masked &&
    a.api_key_tail === b.api_key_tail);

function beforeMergeProcessList(prev, next) {
  if (Array.isArray(next) && next.length === 0 && prev?.length) return prev;
  if (!prev?.length) return next;
  if (prev === next) return prev;
  if (prev.length !== next.length) {
    const prevById = new Map(prev.map((p) => [p.id, p]));
    return next.map((row) => {
      const old = prevById.get(row.id);
      return old && processRowEqual(old, row) ? old : row;
    });
  }
  let same = true;
  for (let i = 0; i < prev.length; i += 1) {
    if (!processRowEqual(prev[i], next[i])) {
      same = false;
      break;
    }
  }
  if (same) return prev;
  const prevById = new Map(prev.map((p) => [p.id, p]));
  return next.map((row) => {
    const old = prevById.get(row.id);
    return old && processRowEqual(old, row) ? old : row;
  });
}

function afterMergeProcessList(prev, next) {
  if (Array.isArray(next) && next.length === 0 && prev?.length) return prev;
  if (!prev?.length) return next;
  const n = next.length;
  if (prev.length === n) {
    let same = true;
    for (let i = 0; i < n; i += 1) {
      if (!processRowEqual(prev[i], next[i])) {
        same = false;
        break;
      }
    }
    if (same) return prev;
  }
  const prevById = new Map();
  for (let i = 0; i < prev.length; i += 1) prevById.set(prev[i].id, prev[i]);
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const row = next[i];
    const old = prevById.get(row.id);
    out[i] = old && processRowEqual(old, row) ? old : row;
  }
  return out;
}

function beforeCreateAdaptiveBudget({
  minMs,
  maxMs,
  stepUp = 1.45,
  stepDown = 0.5,
  quietBeforeSlow = 2,
  bgFloorMs = 14000,
  inactiveFloorMs = 6000,
} = {}) {
  let current = Math.max(1000, minMs | 0);
  const lo = Math.max(1000, minMs | 0);
  const hi = Math.max(lo, maxMs | 0);
  let quietHits = 0;
  const bgFloor = Math.max(hi, bgFloorMs | 0);
  const inactiveFloor = Math.max(lo, inactiveFloorMs | 0);
  return {
    next(changed) {
      if (changed) {
        quietHits = 0;
        current = lo;
        return current;
      }
      quietHits += 1;
      if (quietHits >= quietBeforeSlow) {
        current = Math.min(hi, Math.round(current * stepUp));
      }
      if (quietHits >= quietBeforeSlow + 4) {
        current = Math.min(hi, Math.round(current * 1.15));
      }
      return current;
    },
    boost() {
      quietHits = 0;
      current = lo;
      return current;
    },
    peek() {
      return current;
    },
    bgDelay() {
      return Math.max(bgFloor, current, 12000);
    },
    inactiveDelay() {
      return Math.max(inactiveFloor, Math.min(hi, Math.round(current * 1.6)));
    },
    reset() {
      quietHits = 0;
      current = lo;
    },
  };
}

/** BEFORE startSmartLoop: inactive/background skip the tick entirely. */
function beforeStartSmartLoop(tick, opts) {
  const budget = opts.budget;
  const enabled = typeof opts.enabled === 'function' ? opts.enabled : () => true;
  const pauseBg = opts.pauseWhenBackground !== false;
  let timer = null;
  let stopped = false;
  let inflight = false;
  const signal = { aborted: false };
  let consecutiveErrors = 0;
  let ticks = 0;
  let overlaps = 0;

  const schedule = (ms) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, Math.max(0, ms | 0));
  };

  const run = async () => {
    timer = null;
    if (stopped) return;
    if (!enabled()) {
      schedule(Math.max(budget.peek(), 4));
      return;
    }
    if (pauseBg && typeof opts.getAppState === 'function') {
      const phase = String(opts.getAppState() || 'active');
      if (phase === 'background') {
        schedule(typeof budget.bgDelay === 'function' ? budget.bgDelay() : 14);
        return;
      }
      if (phase === 'inactive') {
        schedule(typeof budget.inactiveDelay === 'function' ? budget.inactiveDelay() : 6);
        return;
      }
    }
    if (inflight) {
      overlaps += 1;
      schedule(2);
      return;
    }
    inflight = true;
    ticks += 1;
    let changed = false;
    try {
      const r = await tick({ signal });
      changed = r === true;
      consecutiveErrors = 0;
    } catch {
      consecutiveErrors += 1;
    } finally {
      inflight = false;
    }
    if (stopped) return;
    let delay = budget.next(changed);
    schedule(Math.min(4, delay));
  };

  schedule(0);
  return {
    stop() {
      stopped = true;
      signal.aborted = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    stats: () => ({ ticks, overlaps }),
  };
}

/** AFTER: generation token, inactive still ticks, no skip-work. */
function afterStartSmartLoop(tick, opts) {
  const budget = opts.budget;
  const enabled = typeof opts.enabled === 'function' ? opts.enabled : () => true;
  const pauseBg = opts.pauseWhenBackground !== false;
  let timer = null;
  let stopped = false;
  let inflight = false;
  let gen = 0;
  const signal = { aborted: false };
  let consecutiveErrors = 0;
  let ticks = 0;
  let overlaps = 0;
  let queued = false;

  const schedule = (ms) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, Math.max(0, ms | 0));
  };

  const run = async () => {
    timer = null;
    const myGen = gen;
    if (stopped || myGen !== gen) return;
    if (!enabled()) {
      schedule(Math.max(budget.peek(), 4));
      return;
    }
    let phase = 'active';
    if (typeof opts.getAppState === 'function') {
      phase = String(opts.getAppState() || 'active');
      if (phase !== 'active' && phase !== 'inactive') phase = 'background';
    }
    if (pauseBg && phase === 'background') {
      schedule(typeof budget.bgDelay === 'function' ? budget.bgDelay() : 14);
      return;
    }
    if (inflight) {
      overlaps += 1;
      queued = true;
      return;
    }
    inflight = true;
    ticks += 1;
    let changed = false;
    try {
      const r = await tick({ signal });
      changed = r === true;
      consecutiveErrors = 0;
    } catch {
      consecutiveErrors += 1;
    } finally {
      inflight = false;
    }
    if (stopped || myGen !== gen) return;
    let delay = budget.next(changed);
    if (phase === 'inactive' && typeof budget.inactiveDelay === 'function') {
      delay = budget.inactiveDelay();
    }
    if (queued) {
      queued = false;
      delay = Math.min(delay, 1);
    }
    schedule(Math.min(4, delay));
  };

  schedule(0);
  return {
    stop() {
      stopped = true;
      gen += 1;
      signal.aborted = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    stats: () => ({ ticks, overlaps }),
  };
}

function beforeRewriteUrl(url) {
  let out = String(url || '').trim();
  if (/^http:\/\//i.test(out) && /crew\.kingdom\.forum/i.test(out)) {
    out = out.replace(/^http:\/\//i, 'https://').replace(/:8000(?=\/|$)/, '');
  }
  return out.replace(/\s+/g, '').replace(/\/+$/, '') || out;
}

function afterRewriteUrl(url) {
  let out = String(url || '').trim();
  if (!out) return out;
  out = out.replace(/\s+/g, '');
  out = out.replace(/^http:\/\//i, 'https://');
  out = out.replace(/:8000(?=\/|$)/, '');
  if (/crew\.kingdom\.forum/i.test(out)) {
    out = out.replace(/https:\/\/(?:www\.)?crew\.kingdom\.forum/i, 'https://kingdom.lifestyle');
  }
  return out.replace(/\/+$/, '') || out;
}

function beforeBytesToHex(arr) {
  let out = '';
  for (let i = 0; i < arr.length; i += 1) out += arr[i].toString(16).padStart(2, '0');
  return out;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
function afterBytesToHex(arr) {
  let out = '';
  for (let i = 0; i < arr.length; i += 1) out += HEX[arr[i]];
  return out;
}

function beforeInflightDedupe(map, key, factory) {
  if (map.has(key)) return map.get(key);
  const run = factory();
  map.set(key, run);
  run.finally(() => {
    if (map.get(key) === run) map.delete(key);
  }).catch(() => {});
  return run;
}

function afterInflightDedupe(map, key, factory) {
  const hit = map.get(key);
  if (hit) return hit;
  const run = factory();
  map.set(key, run);
  const clear = () => {
    if (map.get(key) === run) map.delete(key);
  };
  if (typeof run.finally === 'function') run.finally(clear);
  else Promise.resolve(run).then(clear, clear);
  return run;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowNs() {
  return performance.now();
}

function bench(fn, loops) {
  const t0 = nowNs();
  for (let i = 0; i < loops; i += 1) fn(i);
  return nowNs() - t0;
}

async function benchAsync(fn) {
  const t0 = nowNs();
  await fn();
  return nowNs() - t0;
}

function makeProcs(n, mutateEvery = 0) {
  const list = new Array(n);
  for (let i = 0; i < n; i += 1) {
    list[i] = {
      id: `RADIO${(i % 10) + 1}_${i % 2 ? 'BOT' : 'MAIN'}`,
      name: `Station ${i}`,
      status: i % 7 === 0 ? 'STOPPED' : 'RUNNING',
      pid: 1000 + i,
      auto_restart: i % 3 === 0,
      is_bot: i % 2 === 1,
      room_id: i % 2 ? `room_${i}` : '',
      api_key_masked: '',
      api_key_tail: '',
    };
  }
  if (mutateEvery) {
    for (let i = 0; i < n; i += mutateEvery) list[i] = { ...list[i], pid: list[i].pid + 1 };
  }
  return list;
}

function makeStreams() {
  const map = {};
  for (let i = 1; i <= 10; i += 1) {
    map[`RADIO${i}`] = {
      title: `Track ${i} — Live mix featuring a long title`,
      listeners: 10 + i,
      online: true,
      stream_url: `https://crew.kingdom.forum/stream${i === 1 ? '' : i}`,
    };
  }
  return map;
}

function pct(before, after) {
  if (!before) return after === 0 ? 0 : -100;
  return ((before - after) / before) * 100;
}

function fmt(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(1)}µs`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(3)}s`;
}

async function main() {
  const results = {
    capturedAt: new Date().toISOString(),
    appVersionAfter: '1.5.7',
    domainAfter: 'https://kingdom.lifestyle',
    domainBefore: 'https://crew.kingdom.forum (CI + some fallbacks)',
    cases: {},
  };

  // LRU
  {
    const seed = () => {
      const m = new Map();
      for (let i = 0; i < ITER.lruKeys; i += 1) {
        m.set(`k${i}`, { ts: i, lastAccess: i, data: i });
      }
      return m;
    };
    const b = bench(() => beforeMemEvict(seed(), 120), ITER.lru);
    const a = bench(() => afterMemEvict(seed(), 120), ITER.lru);
    const mb = seed();
    beforeMemEvict(mb, 120);
    const ma = seed();
    afterMemEvict(ma, 120);
    results.cases.lruEvict = {
      beforeMs: b,
      afterMs: a,
      fasterPct: pct(b, a),
      beforeSize: mb.size,
      afterSize: ma.size,
      note: 'O(n²) scan-per-drop → single sort + slice',
    };
  }

  // Fingerprints
  {
    const procs = makeProcs(48);
    const streams = makeStreams();
    const b1 = bench(() => beforeFingerprintProcesses(procs), ITER.fp);
    const a1 = bench(() => afterFingerprintProcesses(procs), ITER.fp);
    const b2 = bench(() => beforeFingerprintStreams(streams), ITER.fp);
    const a2 = bench(() => afterFingerprintStreams(streams), ITER.fp);
    const same =
      beforeFingerprintProcesses(procs) === afterFingerprintProcesses(procs) &&
      beforeFingerprintStreams(streams) === afterFingerprintStreams(streams);
    results.cases.fingerprintProcesses = {
      beforeMs: b1,
      afterMs: a1,
      fasterPct: pct(b1, a1),
      identical: beforeFingerprintProcesses(procs) === afterFingerprintProcesses(procs),
    };
    results.cases.fingerprintStreams = {
      beforeMs: b2,
      afterMs: a2,
      fasterPct: pct(b2, a2),
      identical: beforeFingerprintStreams(streams) === afterFingerprintStreams(streams),
      bothIdentical: same,
    };
  }

  // Merge
  {
    const prev = makeProcs(40);
    const nextSame = prev.map((p) => ({ ...p }));
    const nextDiff = makeProcs(40, 7);
    const b = bench((i) => {
      beforeMergeProcessList(prev, i % 2 ? nextSame : nextDiff);
    }, ITER.merge);
    const a = bench((i) => {
      afterMergeProcessList(prev, i % 2 ? nextSame : nextDiff);
    }, ITER.merge);
    const m1 = beforeMergeProcessList(prev, nextSame);
    const m2 = afterMergeProcessList(prev, nextSame);
    results.cases.mergeProcessList = {
      beforeMs: b,
      afterMs: a,
      fasterPct: pct(b, a),
      identityReuseSame: m1 === prev && m2 === prev,
    };
  }

  // Budget
  {
    const bb = beforeCreateAdaptiveBudget({ minMs: 3000, maxMs: 32000 });
    const aa = beforeCreateAdaptiveBudget({ minMs: 3000, maxMs: 32000 });
    const b = bench((i) => bb.next(i % 17 === 0), ITER.budget);
    const a = bench((i) => aa.next(i % 17 === 0), ITER.budget);
    results.cases.adaptiveBudget = {
      beforeMs: b,
      afterMs: a,
      fasterPct: pct(b, a),
      note: 'Same math — control (should be ~0%)',
    };
  }

  // Smart loop races
  {
    let phase = 'inactive';
    const mkTick = () => {
      let live = 0;
      let maxLive = 0;
      return {
        tick: async () => {
          live += 1;
          if (live > maxLive) maxLive = live;
          await sleep(2);
          live -= 1;
          return false;
        },
        maxLive: () => maxLive,
      };
    };
    const tb = mkTick();
    const ta = mkTick();
    const budgetB = beforeCreateAdaptiveBudget({ minMs: 1000, maxMs: 4000 });
    const budgetA = beforeCreateAdaptiveBudget({ minMs: 1000, maxMs: 4000 });
    const lb = beforeStartSmartLoop(tb.tick, {
      budget: budgetB,
      getAppState: () => phase,
    });
    const la = afterStartSmartLoop(ta.tick, {
      budget: budgetA,
      getAppState: () => phase,
    });
    const loopMs = await benchAsync(async () => {
      await sleep(80);
      phase = 'active';
      await sleep(80);
      lb.stop();
      la.stop();
    });
    const sb = lb.stats();
    const sa = la.stats();
    results.cases.smartLoopInactiveTicks = {
      beforeTicks: sb.ticks,
      afterTicks: sa.ticks,
      beforeOverlaps: sb.overlaps,
      afterOverlaps: sa.overlaps,
      beforeMaxLive: tb.maxLive(),
      afterMaxLive: ta.maxLive(),
      wallMs: loopMs,
      note: 'BEFORE skips ticks while inactive; AFTER still works at idle delay. Overlaps must stay 0 live.',
    };
  }

  // Overlap storm
  {
    const mk = (start) => {
      let live = 0;
      let maxLive = 0;
      const tick = async () => {
        live += 1;
        if (live > maxLive) maxLive = live;
        await sleep(3);
        live -= 1;
        return false;
      };
      const budget = beforeCreateAdaptiveBudget({ minMs: 1000, maxMs: 2000 });
      const loop = start(tick, { budget, getAppState: () => 'active' });
      return { loop, maxLive: () => maxLive };
    };
    const b = mk(beforeStartSmartLoop);
    const a = mk(afterStartSmartLoop);
    await sleep(60);
    b.loop.stop();
    a.loop.stop();
    results.cases.smartLoopNoOverlap = {
      beforeMaxLive: b.maxLive(),
      afterMaxLive: a.maxLive(),
      pass: b.maxLive() <= 1 && a.maxLive() <= 1,
    };
  }

  // URL rewrite
  {
    const samples = [
      'http://crew.kingdom.forum:8000/stream',
      'https://crew.kingdom.forum/stream2',
      'https://kingdom.lifestyle/stream3',
      'http://kingdom.lifestyle:8000/stream4',
    ];
    const b = bench((i) => beforeRewriteUrl(samples[i % samples.length]), ITER.rewrite);
    const a = bench((i) => afterRewriteUrl(samples[i % samples.length]), ITER.rewrite);
    results.cases.urlRewrite = {
      beforeMs: b,
      afterMs: a,
      fasterPct: pct(b, a),
      beforeOut: samples.map(beforeRewriteUrl),
      afterOut: samples.map(afterRewriteUrl),
      oldHostLeftBefore: samples.map(beforeRewriteUrl).some((u) => /crew\.kingdom\.forum/i.test(u)),
      oldHostLeftAfter: samples.map(afterRewriteUrl).some((u) => /crew\.kingdom\.forum/i.test(u)),
    };
  }

  // Hex nonce
  {
    const buf = new Uint8Array(12);
    for (let i = 0; i < 12; i += 1) buf[i] = (i * 37) & 0xff;
    const b = bench(() => beforeBytesToHex(buf), ITER.nonce);
    const a = bench(() => afterBytesToHex(buf), ITER.nonce);
    results.cases.nonceHex = {
      beforeMs: b,
      afterMs: a,
      fasterPct: pct(b, a),
      identical: beforeBytesToHex(buf) === afterBytesToHex(buf),
    };
  }

  // In-flight GET dedupe
  {
    let createdB = 0;
    let createdA = 0;
    const mapB = new Map();
    const mapA = new Map();
    const b = await benchAsync(async () => {
      for (let i = 0; i < ITER.dedupe; i += 1) {
        const key = `k${i % 8}`;
        beforeInflightDedupe(mapB, key, () => {
          createdB += 1;
          return Promise.resolve(1);
        });
      }
      await sleep(0);
    });
    const a = await benchAsync(async () => {
      for (let i = 0; i < ITER.dedupe; i += 1) {
        const key = `k${i % 8}`;
        afterInflightDedupe(mapA, key, () => {
          createdA += 1;
          return Promise.resolve(1);
        });
      }
      await sleep(0);
    });
    results.cases.inflightDedupe = {
      beforeMs: b,
      afterMs: a,
      fasterPct: pct(b, a),
      createdBefore: createdB,
      createdAfter: createdA,
    };
  }

  // Race: getDb-style singleflight
  {
    function beforeGetDbFactory() {
      let db = null;
      let promise = null;
      let failed = false;
      let opens = 0;
      return {
        opens: () => opens,
        async get() {
          if (failed) return null;
          if (db) return db;
          if (promise) return promise;
          promise = (async () => {
            opens += 1;
            await sleep(2);
            throw new Error('native missing');
          })();
          try {
            return await promise;
          } catch {
            promise = null;
            failed = true;
            return null;
          }
        },
      };
    }
    function afterGetDbFactory() {
      let db = null;
      let promise = null;
      let failed = false;
      let opens = 0;
      return {
        opens: () => opens,
        async get() {
          if (failed) return null;
          if (db) return db;
          if (!promise) {
            promise = (async () => {
              try {
                opens += 1;
                await sleep(2);
                throw new Error('native missing');
              } catch {
                failed = true;
                return null;
              }
            })();
          }
          return promise;
        },
      };
    }
    const bf = beforeGetDbFactory();
    const af = afterGetDbFactory();
    const bRejections = { n: 0 };
    const aNulls = { n: 0 };
    const bMs = await benchAsync(async () => {
      const jobs = [];
      for (let i = 0; i < 40; i += 1) {
        jobs.push(
          bf.get().catch(() => {
            bRejections.n += 1;
            return null;
          })
        );
      }
      await Promise.all(jobs);
    });
    const aMs = await benchAsync(async () => {
      const jobs = [];
      for (let i = 0; i < 40; i += 1) {
        jobs.push(
          af.get().then((v) => {
            if (v == null) aNulls.n += 1;
            return v;
          })
        );
      }
      await Promise.all(jobs);
    });
    results.cases.sqliteOpenSingleflight = {
      beforeMs: bMs,
      afterMs: aMs,
      fasterPct: pct(bMs, aMs),
      beforeOpens: bf.opens(),
      afterOpens: af.opens(),
      beforeThrownToCallers: bRejections.n,
      afterNulls: aNulls.n,
      note: 'AFTER never rejects waiters; one open attempt; null on failure',
    };
  }

  // Domain correctness
  {
    results.cases.domainCutover = {
      beforeDefault: 'https://crew.kingdom.forum/api (committed CI + previous App.js)',
      afterDefault: 'https://kingdom.lifestyle/api',
      oldHostStillRewritten: afterRewriteUrl('http://crew.kingdom.forum:8000/stream'),
      newHostUntouched: afterRewriteUrl('https://kingdom.lifestyle/stream2'),
    };
  }

  // Summary
  const rows = Object.entries(results.cases).map(([name, c]) => {
    const row = { name, ...c };
    return row;
  });
  const timed = rows.filter((r) => typeof r.beforeMs === 'number' && typeof r.afterMs === 'number');
  const avgPct =
    timed.reduce((s, r) => s + (Number.isFinite(r.fasterPct) ? r.fasterPct : 0), 0) /
    Math.max(1, timed.length);

  results.summary = {
    timedCases: timed.length,
    avgFasterPct: Number(avgPct.toFixed(2)),
    inactiveTickFix: results.cases.smartLoopInactiveTicks.afterTicks > results.cases.smartLoopInactiveTicks.beforeTicks,
    noOverlap: results.cases.smartLoopNoOverlap.pass,
    oldHostGone: results.cases.urlRewrite.oldHostLeftAfter === false,
    sqliteWaitersSafe: results.cases.sqliteOpenSingleflight.beforeThrownToCallers > 0 &&
      results.cases.sqliteOpenSingleflight.afterOpens === 1,
  };

  const outPath = join(ROOT, 'scripts', 'bench-hotpaths-results.json');
  writeFileSync(outPath, JSON.stringify(results, null, 2));

  console.log('\n=== Commander PRO hot-path bench (before 1.5.6 → after 1.5.7) ===\n');
  for (const r of timed) {
    const fp = Number.isFinite(r.fasterPct) ? r.fasterPct : 0;
    const sign = fp >= 0 ? '+' : '';
    console.log(
      `${r.name.padEnd(28)}  before ${fmt(r.beforeMs).padStart(10)}  after ${fmt(r.afterMs).padStart(10)}  ${sign}${fp.toFixed(1)}%`
    );
  }
  console.log('\n--- races / correctness ---');
  console.log(
    `inactive ticks: before=${results.cases.smartLoopInactiveTicks.beforeTicks} after=${results.cases.smartLoopInactiveTicks.afterTicks} (AFTER must work while Control Center is up)`
  );
  console.log(
    `loop max live:  before=${results.cases.smartLoopNoOverlap.beforeMaxLive} after=${results.cases.smartLoopNoOverlap.afterMaxLive}`
  );
  console.log(
    `old host left:  before=${results.cases.urlRewrite.oldHostLeftBefore} after=${results.cases.urlRewrite.oldHostLeftAfter}`
  );
  console.log(
    `sqlite opens:   before=${results.cases.sqliteOpenSingleflight.beforeOpens} after=${results.cases.sqliteOpenSingleflight.afterOpens}  thrownToWaiters(before)=${results.cases.sqliteOpenSingleflight.beforeThrownToCallers}`
  );
  console.log(`\nAvg timed speedup: ${results.summary.avgFasterPct}%`);
  console.log(`Wrote ${outPath}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
