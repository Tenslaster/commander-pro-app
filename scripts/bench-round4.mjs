#!/usr/bin/env node
/**
 * Round 4 FE bench — frozen old helpers vs live perfUtils.
 * Run: node scripts/bench-round4.mjs
 */
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatRoomMinutes,
  applyUsersListFilter,
  cheapCacheFp,
  interpolate,
  tokenDedupeId,
} from '../perfUtils.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function beforeFormatRoomMinutes(mins) {
  const m = Math.max(0, Math.floor(Number(mins) || 0));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h < 24) return r ? `${h}h ${r}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

function beforeFilter(list, filter) {
  const mode = String(filter || 'all').toLowerCase();
  if (!Array.isArray(list) || !list.length || mode === 'all') return list;
  const nameCmp = (a, b) => String(a.username || '').localeCompare(String(b.username || ''));
  if (mode === 'ranks') return list.filter((u) => (u.rank || 'guest') !== 'guest');
  if (mode === 'banned') return list.filter((u) => !!u.banned);
  if (mode === 'gold') {
    return list
      .filter((u) => Number(u.gold_tipped || 0) > 0)
      .slice()
      .sort(
        (a, b) =>
          Number(b.gold_tipped || 0) - Number(a.gold_tipped || 0) ||
          Number(b.bank || 0) - Number(a.bank || 0) ||
          nameCmp(a, b)
      );
  }
  return list;
}

function beforeCompact(u) {
  return {
    id: u.id,
    username: u.username,
    rank: u.rank || 'guest',
    rank_level: u.rank_level,
    banned: !!u.banned,
    bank: u.bank ?? 0,
    gold_tipped: u.gold_tipped ?? 0,
    songs_played: u.songs_played ?? 0,
    room_minutes: u.room_minutes ?? 0,
    room_time: u.room_time || '0m',
    station: u.station,
    gold_transferred_out: u.gold_transferred_out ?? 0,
    gold_transferred_in: u.gold_transferred_in ?? 0,
  };
}

function afterCompact(u) {
  const row = {
    id: u.id,
    username: u.username,
    rank: u.rank || 'guest',
    rank_level: u.rank_level,
    banned: !!u.banned,
    bank: u.bank ?? 0,
    gold_tipped: u.gold_tipped ?? 0,
    songs_played: u.songs_played ?? 0,
    room_minutes: u.room_minutes ?? 0,
    room_time: u.room_time || '0m',
    station: u.station,
  };
  const xOut = u.gold_transferred_out | 0;
  const xIn = u.gold_transferred_in | 0;
  if (xOut) row.gold_transferred_out = xOut;
  if (xIn) row.gold_transferred_in = xIn;
  return row;
}

function timeit(fn, n) {
  const t0 = performance.now();
  for (let i = 0; i < n; i += 1) fn();
  return (performance.now() - t0) / n;
}

function pct(b, a) {
  if (!b) return 0;
  return Math.round(((b - a) / b) * 1000) / 10;
}

const users = Array.from({ length: 800 }, (_, i) => ({
  id: `RADIO1:u${i}`,
  username: `user_${i}`,
  rank: i % 40 === 0 ? 'vip' : i % 200 === 0 ? 'mod' : 'guest',
  rank_level: 0,
  banned: i % 70 === 0,
  bank: (i * 17) % 5000,
  gold_tipped: i % 3 === 0 ? (i * 3) % 900 : 0,
  songs_played: i % 5,
  room_minutes: (i * 13) % 4000,
  room_time: '',
  station: 'RADIO1',
  gold_transferred_out: 0,
  gold_transferred_in: 0,
}));

const mins = users.map((u) => u.room_minutes);
const token = `a${'f'.repeat(63)}`;

// warmup
for (let i = 0; i < 200; i += 1) {
  formatRoomMinutes(mins[i % mins.length]);
  applyUsersListFilter(users, 'gold');
}

const tFmtB = timeit(() => {
  for (let i = 0; i < mins.length; i += 1) beforeFormatRoomMinutes(mins[i]);
}, 200);
const tFmtA = timeit(() => {
  for (let i = 0; i < mins.length; i += 1) formatRoomMinutes(mins[i]);
}, 200);

const tFilB = timeit(() => beforeFilter(users, 'gold'), 200);
const tFilA = timeit(() => applyUsersListFilter(users, 'gold'), 200);

const tFpB = timeit(() => JSON.stringify(users), 40);
const tFpA = timeit(() => cheapCacheFp('users', users, { total: 6711 }), 400);

const tCmpB = timeit(() => users.map(beforeCompact), 80);
const tCmpA = timeit(() => users.map(afterCompact), 80);
const bytesB = JSON.stringify(users.map(beforeCompact)).length;
const bytesA = JSON.stringify(users.map(afterCompact)).length;

const tIntB = timeit(() => 'Hello {name}, {n} results'.replace('{name}', 'cedri').replace('{n}', '12'), 50_000);
const tIntA = timeit(() => interpolate('Hello {name}, {n} results', { name: 'cedri', n: 12 }), 50_000);

const tTokB = timeit(() => token, 80_000);
const tTokA = timeit(() => tokenDedupeId(token), 80_000);

const benches = [
  { name: 'formatRoomMinutes_800', before_ms: +tFmtB.toFixed(4), after_ms: +tFmtA.toFixed(4), faster_pct: pct(tFmtB, tFmtA) },
  { name: 'applyUsersListFilter_gold_800', before_ms: +tFilB.toFixed(4), after_ms: +tFilA.toFixed(4), faster_pct: pct(tFilB, tFilA) },
  { name: 'cheapCacheFp_vs_JSON.stringify_800', before_ms: +tFpB.toFixed(4), after_ms: +tFpA.toFixed(4), faster_pct: pct(tFpB, tFpA) },
  { name: 'compactUserRow_omit_zero_xfer', before_ms: +tCmpB.toFixed(4), after_ms: +tCmpA.toFixed(4), faster_pct: pct(tCmpB, tCmpA), before_bytes: bytesB, after_bytes: bytesA, smaller_pct: pct(bytesB, bytesA) },
  { name: 'interpolate_vs_replace', before_ms: +tIntB.toFixed(4), after_ms: +tIntA.toFixed(4), faster_pct: pct(tIntB, tIntA), note: 'correctness helper; 2-replace of tiny strings can win' },
  { name: 'tokenDedupeId', before_ms: +tTokB.toFixed(4), after_ms: +tTokA.toFixed(4), faster_pct: pct(tTokB, tTokA), note: 'shorter inflight key, not a speed play' },
];

const dest = join(ROOT, 'scripts', 'bench-round4-results.json');
writeFileSync(dest, `${JSON.stringify({ round: 4, benches }, null, 2)}\n`);
console.log('\n=== Round 4 FE bench ===\n');
for (const b of benches) {
  const extra = b.before_bytes != null ? `  bytes ${b.before_bytes}→${b.after_bytes} (${b.smaller_pct}% smaller)` : '';
  console.log(`  ${b.name}: ${b.before_ms} → ${b.after_ms} ms  (${b.faster_pct}% faster)${extra}`);
}
console.log(`\nresults: ${dest}`);
