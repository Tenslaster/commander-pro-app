#!/usr/bin/env node
/**
 * Round-2 bench — frozen 1.5.7 hot paths vs this pass.
 * Run: node scripts/bench-round2.mjs
 */
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cheapCacheFp,
  fingerprintStats,
  interpolate,
  payloadLooksSensitive,
  tokenDedupeId,
} from '../perfUtils.js';
import { rewritePublicUrl } from '../appConfig.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ───────── BEFORE (frozen 1.5.7) ─────────

function beforeMemEvict(mem, max = 120) {
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

function afterMemEvict(mem, max = 120) {
  while (mem.size > max) {
    const oldest = mem.keys().next().value;
    if (oldest == null) break;
    mem.delete(oldest);
  }
}

function beforeRewrite(url) {
  let out = String(url || '').trim();
  if (!out) return out;
  out = out.replace(/\s+/g, '');
  out = out.replace(/^http:\/\//i, 'https://');
  out = out.replace(/:8000(?=\/|$)/, '');
  if (/crew\.kingdom\.forum/i.test(out)) {
    out = out.replace(
      new RegExp('https?://(?:www\\.)?crew\\.kingdom\\.forum', 'i'),
      'https://kingdom.lifestyle'
    );
  }
  return out.replace(/\/+$/, '') || out;
}

function beforeInterpolate(template, vars) {
  let s = String(template ?? '');
  if (vars && typeof vars === 'object') {
    Object.keys(vars).forEach((k) => {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(vars[k]));
    });
  }
  return s;
}

function beforeSensitive(kind, data) {
  try {
    const probe = JSON.stringify(
      kind === 'users' && Array.isArray(data) ? data.slice(0, 20) : data
    );
    return (
      /"password"\s*:/i.test(probe) ||
      /"token"\s*:\s*"[0-9a-fA-F]{32,}/i.test(probe)
    );
  } catch {
    return false;
  }
}

function beforeCacheSame(kind, prev, next) {
  if (Array.isArray(prev) && Array.isArray(next)) {
    return JSON.stringify(prev) === JSON.stringify(next);
  }
  return JSON.stringify(prev) === JSON.stringify(next);
}

function afterCacheSame(kind, prev, next) {
  return cheapCacheFp(kind, prev) === cheapCacheFp(kind, next);
}

function beforeStatsFp(payload) {
  return JSON.stringify(payload?.stats || payload || null);
}

function beforeRedact(text) {
  let s = String(text || '');
  s = s.replace(/[0-9a-fA-F]{32,128}/g, '[token]');
  s = s.replace(/Bearer\s+\S+/gi, 'Bearer [token]');
  s = s.replace(/password["']?\s*[:=]\s*["']?[^"'\s,}]+/gi, 'password:[redacted]');
  return s.slice(0, 400);
}

const RE_HEX = /[0-9a-fA-F]{32,128}/g;
const RE_BEAR = /Bearer\s+\S+/gi;
const RE_PW = /password["']?\s*[:=]\s*["']?[^"'\s,}]+/gi;
function afterRedact(text) {
  let s = String(text || '');
  s = s.replace(RE_HEX, '[token]');
  s = s.replace(RE_BEAR, 'Bearer [token]');
  s = s.replace(RE_PW, 'password:[redacted]');
  return s.slice(0, 400);
}

function beforeDedupeKey(path, token) {
  return `${path}\0${token || ''}`;
}
function afterDedupeKey(path, token) {
  return `${path}\0${tokenDedupeId(token)}`;
}

function nowMs() {
  return performance.now();
}
function bench(fn, n) {
  const t0 = nowMs();
  for (let i = 0; i < n; i += 1) fn(i);
  return nowMs() - t0;
}
function pct(b, a) {
  if (!b) return a === 0 ? 0 : -100;
  return ((b - a) / b) * 100;
}
function fmt(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(1)}µs`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(3)}s`;
}

function makeUsers(n) {
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = {
      id: `u${i}`,
      username: `user_${i}`,
      rank: i % 20 === 0 ? 'vip' : 'guest',
      bank: i * 3,
      gold_tipped: i % 50,
      songs_played: i % 17,
      room_minutes: 1000 + i,
      room_time: '2h',
    };
  }
  return out;
}

function makeStats() {
  const day = {
    tips_gold: 85,
    tips_count: 9,
    songs: 29,
    visitors: 130,
    people_max: 37,
    transfers_gold: 0,
    transfers_count: 0,
  };
  const series = [];
  for (let i = 0; i < 30; i += 1) {
    series.push({
      date: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`,
      tips_gold: 200 + i,
      songs: 40 + i,
      visitors: 900 + i,
    });
  }
  const tippers = [];
  for (let i = 0; i < 10; i += 1) tippers.push({ user: `tip${i}`, value: 1600 - i * 40 });
  return {
    station: 'RADIO1',
    stats: {
      day,
      week: { ...day, tips_gold: 5960, songs: 1393, visitors: 968 },
      month: { ...day, tips_gold: 12000, songs: 4000, visitors: 1100 },
      lifetime: {
        tips_gold: 16196,
        songs: 6894,
        visitors: 13274,
        bank_total: 11372,
        skips: 72,
        room_minutes_total: 1485741,
      },
      leaderboards: { tippers },
      series: { month: series, week: series.slice(-7) },
      as_of: '2026-08-13',
      tracked_days: 18,
    },
  };
}

async function main() {
  const cases = {};
  const users = makeUsers(8000);
  const users2 = users.map((u) => ({ ...u }));
  const stats = makeStats();
  const stats2 = JSON.parse(JSON.stringify(stats));
  const token = 'a'.repeat(64);
  const leak = `Session ${token} Bearer abc.def password=hunter2 fail`;

  {
    const seed = () => {
      const m = new Map();
      for (let i = 0; i < 600; i += 1) m.set(`k${i}`, { ts: i, lastAccess: i });
      return m;
    };
    const b = bench(() => beforeMemEvict(seed(), 120), 80);
    const a = bench(() => afterMemEvict(seed(), 120), 80);
    cases.lruEvictO1 = { beforeMs: b, afterMs: a, fasterPct: pct(b, a), note: 'sort-all → Map FIFO pop' };
  }

  {
    const b = bench(() => beforeCacheSame('users', users, users2), 40);
    const a = bench(() => afterCacheSame('users', users, users2), 40);
    cases.cacheEqual8kUsers = {
      beforeMs: b,
      afterMs: a,
      fasterPct: pct(b, a),
      note: 'JSON.stringify 8k rows vs edge fingerprint',
    };
  }

  {
    const b = bench(() => beforeCacheSame('stats', stats, stats2), 800);
    const a = bench(() => afterCacheSame('stats', stats, stats2), 800);
    cases.cacheEqualStatsTree = {
      beforeMs: b,
      afterMs: a,
      fasterPct: pct(b, a),
      note: 'full stats JSON vs KPI fingerprint',
    };
  }

  {
    const b = bench(() => beforeStatsFp(stats), 4000);
    const a = bench(() => fingerprintStats(stats), 4000);
    cases.statsPollFingerprint = {
      beforeMs: b,
      afterMs: a,
      fasterPct: pct(b, a),
      note: 'every /station_stats poll used to stringify the whole tree',
    };
  }

  {
    const samples = [
      'http://crew.kingdom.forum:8000/stream',
      'https://crew.kingdom.forum/stream2',
      'https://kingdom.lifestyle/stream3',
      'http://kingdom.lifestyle:8000/stream4',
    ];
    const b = bench((i) => beforeRewrite(samples[i % 4]), 80_000);
    const a = bench((i) => rewritePublicUrl(samples[i % 4]), 80_000);
    cases.urlRewritePrecompiled = {
      beforeMs: b,
      afterMs: a,
      fasterPct: pct(b, a),
      afterOut: samples.map(rewritePublicUrl),
    };
  }

  {
    const vars = { title: 'Song', station: 'RADIO1', msg: 'ok' };
    const tpl = 'Add {title} on {station}: {msg}';
    const b = bench(() => beforeInterpolate(tpl, vars), 80_000);
    const a = bench(() => interpolate(tpl, vars), 80_000);
    cases.i18nInterpolate = {
      beforeMs: b,
      afterMs: a,
      fasterPct: pct(b, a),
      identical: interpolate(tpl, vars) === 'Add Song on RADIO1: ok',
    };
  }

  {
    const b = bench(() => beforeSensitive('users', users), 30);
    const a = bench(() => payloadLooksSensitive('users', users), 30);
    cases.cacheSecretScan = {
      beforeMs: b,
      afterMs: a,
      fasterPct: pct(b, a),
      note: 'stringify 8k users vs field probe of 12 rows',
    };
  }

  {
    const b = bench(() => beforeRedact(leak), 60_000);
    const a = bench(() => afterRedact(leak), 60_000);
    cases.redactSecrets = {
      beforeMs: b,
      afterMs: a,
      fasterPct: pct(b, a),
      identical: beforeRedact(leak) === afterRedact(leak),
    };
  }

  {
    const b = bench(() => beforeDedupeKey('/status', token), 200_000);
    const a = bench(() => afterDedupeKey('/status', token), 200_000);
    cases.inflightKeyNoToken = {
      beforeMs: b,
      afterMs: a,
      fasterPct: pct(b, a),
      note: 'map key no longer stores the raw session token',
    };
  }

  const timed = Object.entries(cases).filter(
    ([, c]) => typeof c.beforeMs === 'number' && typeof c.afterMs === 'number'
  );
  const avg =
    timed.reduce((s, [, c]) => s + c.fasterPct, 0) / Math.max(1, timed.length);
  const weighted =
    timed.reduce((s, [, c]) => s + c.beforeMs - c.afterMs, 0);
  const weightedPct =
    (weighted / timed.reduce((s, [, c]) => s + c.beforeMs, 0)) * 100;

  const results = {
    capturedAt: new Date().toISOString(),
    round: 2,
    vs: '1.5.7 post-domain pass',
    cases,
    summary: {
      timedCases: timed.length,
      unweightedAvgFasterPct: Number(avg.toFixed(2)),
      timeWeightedFasterPct: Number(weightedPct.toFixed(2)),
      biggest: timed
        .slice()
        .sort((a, b) => b[1].fasterPct - a[1].fasterPct)
        .slice(0, 3)
        .map(([n, c]) => ({ name: n, fasterPct: Number(c.fasterPct.toFixed(1)) })),
    },
  };

  const out = join(ROOT, 'scripts', 'bench-round2-results.json');
  writeFileSync(out, JSON.stringify(results, null, 2));

  console.log('\n=== Round 2 bench (1.5.7 → this pass) ===\n');
  for (const [name, c] of timed) {
    const sign = c.fasterPct >= 0 ? '+' : '';
    console.log(
      `${name.padEnd(26)}  before ${fmt(c.beforeMs).padStart(10)}  after ${fmt(c.afterMs).padStart(10)}  ${sign}${c.fasterPct.toFixed(1)}%`
    );
  }
  console.log(`\nUnweighted avg speedup:  ${results.summary.unweightedAvgFasterPct}%`);
  console.log(`Time-weighted speedup:   ${results.summary.timeWeightedFasterPct}%`);
  console.log(`Biggest: ${results.summary.biggest.map((x) => `${x.name} ${x.fasterPct}%`).join(' · ')}`);
  console.log(`Wrote ${out}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
