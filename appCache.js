/**
 * Commander PRO — client cache (SQLite)
 *
 * L1: in-memory Map with LRU eviction (instant tab switches)
 * L2: expo-sqlite (survives restarts; AsyncStorage fallback if native missing)
 *
 * Stale-while-revalidate:
 *  - Soft TTL → data is "stale": still paint, but network refresh ASAP
 *  - Hard TTL → up to 7 days: still paint so resume/offline never looks empty
 *  - Every successful API fetch overwrites cache (keeps it updated)
 *
 * Tokens/passwords never stored here (SecureStore only).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { isCacheKindSafe } from './apiSecurity';

/**
 * Dynamic require — a static `import 'expo-sqlite'` CRASHES the whole JS bundle
 * (black screen) when the native module is missing (local JS-repack of older APK/IPA).
 */
let SQLite = null;
try {
  // eslint-disable-next-line global-require, import/no-extraneous-dependencies
  SQLite = require('expo-sqlite');
} catch {
  SQLite = null;
}

/** Logical cache key prefix (legacy AsyncStorage used same) */
const PREFIX = '@cp_cache_v2:';
const LEGACY_PREFIXES = ['@cp_cache_v1:', '@cp_cache_v2:'];

const FORBIDDEN_CACHE_PATTERNS = [
  /"password"\s*:/i,
  /"password_hash"\s*:/i,
  /"token"\s*:\s*"[0-9a-fA-F]{32,}/i,
  /"salt"\s*:\s*"[0-9a-fA-F]{8,}/i,
  /Bearer\s+[0-9a-fA-F]{16,}/i,
];

/** key -> { ts, data, meta, lastAccess } */
const mem = new Map();

/** 7 days — keep painting cached radios/users/alerts for a full week */
export const CACHE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Soft TTLs (ms) — after this, still show cache but treat as stale and revalidate.
 * Live-ish data (status/streams) revalidates often; heavy data less often.
 */
export const CACHE_TTL = {
  status: 45_000, // process list — poll keeps it fresh; soft flag after 45s
  streams: 20_000, // now-playing / listeners
  notify: 90_000, // alerts feed
  stats: 10 * 60_000, // 10 min
  users: 15 * 60_000, // 15 min soft (full week hard paint)
  playlist: 5 * 60_000,
  app_users: 15 * 60_000,
  security: 5 * 60_000,
};

/**
 * Hard TTLs (ms) — refuse to paint only after this.
 * Default: 1 week for every kind so cold launch / offline still has data.
 */
export const CACHE_HARD_TTL = Object.fromEntries(
  Object.keys(CACHE_TTL).map((k) => [k, CACHE_WEEK_MS])
);

const MEM_MAX_KEYS = 120;
const MAX_USERS_CACHE = 100_000;
const MAX_NOTIFY_CACHE = 400;
const MAX_PLAYLIST_SONGS = 800;
const MAX_STATUS_ROWS = 200;

const DISK_FLUSH_MS = 400;
const pendingDisk = new Map(); // key -> { ts, data, meta, kind }
let flushTimer = null;

let _db = null;
let _dbPromise = null;
let _migratedAsync = false;
/** When native expo-sqlite is missing (old APK/IPA JS-repack), fall back to AsyncStorage L2 */
let _sqliteFailed = false;

function fullKey(kind, id = '') {
  return `${PREFIX}${kind}${id ? `:${id}` : ''}`;
}

function softTtl(kind) {
  return CACHE_TTL[kind] || 5 * 60_000;
}

function hardTtl(kind) {
  return CACHE_HARD_TTL[kind] || CACHE_WEEK_MS;
}

function touchAccess(entry) {
  if (entry) entry.lastAccess = Date.now();
}

function memEvictIfNeeded() {
  if (mem.size <= MEM_MAX_KEYS) return;
  const drop = mem.size - MEM_MAX_KEYS + 8;
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

function compactUserRow(u) {
  if (!u || typeof u !== 'object') return u;
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

function compactStatusRow(p) {
  if (!p || typeof p !== 'object') return p;
  return {
    id: p.id,
    name: p.name,
    status: p.status,
    pid: p.pid ?? null,
    auto_restart: !!p.auto_restart,
    is_bot: !!p.is_bot,
    room_id: p.room_id || '',
    api_key_masked: p.api_key_masked || '',
    api_key_tail: p.api_key_tail || '',
  };
}

function preparePayload(kind, data, meta) {
  let payload = data;
  let metaOut = meta ? { ...meta } : null;

  if (kind === 'users' && Array.isArray(data)) {
    const total = data.length;
    const sliced =
      total > MAX_USERS_CACHE ? data.slice(0, MAX_USERS_CACHE) : data;
    payload = sliced.map(compactUserRow);
    metaOut = {
      ...(metaOut || {}),
      total,
      cached: payload.length,
      truncated: total > MAX_USERS_CACHE,
    };
  } else if (kind === 'notify' && Array.isArray(data)) {
    payload =
      data.length > MAX_NOTIFY_CACHE ? data.slice(0, MAX_NOTIFY_CACHE) : data;
  } else if (kind === 'status' && Array.isArray(data)) {
    const sliced =
      data.length > MAX_STATUS_ROWS ? data.slice(0, MAX_STATUS_ROWS) : data;
    payload = sliced.map(compactStatusRow);
  } else if (kind === 'playlist' && data && typeof data === 'object') {
    const songs = Array.isArray(data.songs) ? data.songs : [];
    if (songs.length > MAX_PLAYLIST_SONGS) {
      payload = {
        ...data,
        songs: songs.slice(0, MAX_PLAYLIST_SONGS),
      };
      metaOut = {
        ...(metaOut || {}),
        truncated: true,
        totalSongs: songs.length,
      };
    }
  }

  return { payload, metaOut };
}

// ---------- SQLite ----------

function withTimeout(promise, ms, label = 'timeout') {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(label));
    }, ms);
    Promise.resolve(promise)
      .then((v) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(v);
      })
      .catch((e) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        reject(e);
      });
  });
}

async function getDb() {
  if (_sqliteFailed) return null;
  if (_db) return _db;
  if (_dbPromise) return _dbPromise;
  _dbPromise = (async () => {
    if (!SQLite || typeof SQLite.openDatabaseAsync !== 'function') {
      throw new Error('expo-sqlite unavailable');
    }
    // Hard cap so a broken native module never hangs boot (black screen)
    const db = await withTimeout(
      SQLite.openDatabaseAsync('commander_pro_cache.db'),
      1500,
      'sqlite_open_timeout'
    );
    await withTimeout(
      db.execAsync(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS cache_kv (
        key TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        id TEXT NOT NULL DEFAULT '',
        ts INTEGER NOT NULL,
        last_access INTEGER NOT NULL,
        meta TEXT,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cache_kind ON cache_kv(kind);
      CREATE INDEX IF NOT EXISTS idx_cache_access ON cache_kv(last_access);

      CREATE TABLE IF NOT EXISTS cache_users (
        station TEXT NOT NULL,
        username TEXT NOT NULL,
        id TEXT,
        rank TEXT,
        rank_level INTEGER,
        banned INTEGER NOT NULL DEFAULT 0,
        bank INTEGER NOT NULL DEFAULT 0,
        gold_tipped INTEGER NOT NULL DEFAULT 0,
        songs_played INTEGER NOT NULL DEFAULT 0,
        room_minutes INTEGER NOT NULL DEFAULT 0,
        room_time TEXT,
        gold_transferred_out INTEGER NOT NULL DEFAULT 0,
        gold_transferred_in INTEGER NOT NULL DEFAULT 0,
        ts INTEGER NOT NULL,
        PRIMARY KEY (station, username)
      );
      CREATE INDEX IF NOT EXISTS idx_cusers_station_room
        ON cache_users(station, room_minutes DESC);
      CREATE INDEX IF NOT EXISTS idx_cusers_station_bank
        ON cache_users(station, bank DESC);
    `),
      2000,
      'sqlite_schema_timeout'
    );
    _db = db;
    // One-time AsyncStorage → SQLite migration (legacy) — never block callers
    migrateFromAsyncStorage(db).catch(() => {});
    return db;
  })();
  try {
    return await _dbPromise;
  } catch (e) {
    _dbPromise = null;
    _sqliteFailed = true;
    // Local JS-repack of older APK/IPA may lack the native module — keep L1 + AsyncStorage L2
    return null;
  }
}

async function migrateFromAsyncStorage(db) {
  if (_migratedAsync) return;
  _migratedAsync = true;
  try {
    const keys = await AsyncStorage.getAllKeys();
    const ours = (keys || []).filter((k) =>
      LEGACY_PREFIXES.some((p) => k.startsWith(p))
    );
    if (!ours.length) return;
    const pairs = await AsyncStorage.multiGet(ours);
    const now = Date.now();
    for (const [k, raw] of pairs) {
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') continue;
        // Skip chunk fragment keys
        if (/:c\d+$/.test(k)) continue;
        let data = parsed.data;
        if (parsed.chunked && parsed.chunks) {
          // reassemble chunks from AsyncStorage
          const parts = [];
          for (let i = 0; i < parsed.chunks; i += 1) {
            const cr = await AsyncStorage.getItem(`${k}:c${i}`);
            if (!cr) continue;
            const arr = JSON.parse(cr);
            if (Array.isArray(arr)) parts.push(...arr);
          }
          data = parts;
        }
        if (data == null) continue;
        const kind = k.includes(':users:')
          ? 'users'
          : k.replace(PREFIX, '').split(':')[0] || 'misc';
        const id =
          k.includes(':') && k.split(':').length >= 3
            ? k.split(':').slice(2).join(':')
            : '';
        await db.runAsync(
          `INSERT OR REPLACE INTO cache_kv(key, kind, id, ts, last_access, meta, data)
           VALUES (?,?,?,?,?,?,?)`,
          k,
          kind,
          id || '',
          parsed.ts || now,
          now,
          parsed.meta ? JSON.stringify(parsed.meta) : null,
          JSON.stringify(data)
        );
        // Don't expand 10k users into row table during migration (jank + slow boot)
      } catch {
        /* skip bad key */
      }
    }
    // Drop legacy keys so we never dual-write AsyncStorage again
    if (ours.length) await AsyncStorage.multiRemove(ours);
  } catch {
    /* ignore migration errors */
  }
}

async function asyncGet(key) {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return { ts: parsed.ts || 0, data: parsed.data, meta: parsed.meta || null };
  } catch {
    return null;
  }
}

async function asyncSet(key, kind, id, ts, meta, data) {
  await AsyncStorage.setItem(
    key,
    JSON.stringify({ ts, data, meta })
  );
}

async function sqlGet(key) {
  const db = await getDb();
  if (!db) return asyncGet(key);
  const row = await db.getFirstAsync(
    'SELECT ts, meta, data, last_access FROM cache_kv WHERE key = ?',
    key
  );
  if (!row) return null;
  let data;
  try {
    data = JSON.parse(row.data);
  } catch {
    return null;
  }
  let meta = null;
  if (row.meta) {
    try {
      meta = JSON.parse(row.meta);
    } catch {
      meta = null;
    }
  }
  // touch last_access
  db.runAsync(
    'UPDATE cache_kv SET last_access = ? WHERE key = ?',
    Date.now(),
    key
  ).catch(() => {});
  return { ts: row.ts || 0, data, meta };
}

async function sqlSet(key, kind, id, ts, meta, data) {
  const db = await getDb();
  if (!db) {
    await asyncSet(key, kind, id, ts, meta, data);
    return;
  }
  const raw = JSON.stringify(data);
  const metaRaw = meta != null ? JSON.stringify(meta) : null;
  await db.runAsync(
    `INSERT OR REPLACE INTO cache_kv(key, kind, id, ts, last_access, meta, data)
     VALUES (?,?,?,?,?,?,?)`,
    key,
    kind,
    id || '',
    ts,
    Date.now(),
    metaRaw,
    raw
  );
  // Skip per-row cache_users writes on every poll — full catalog lives in
  // cache_kv blob. Row table is optional/lazy (was freezing UI ~5 min on 10k inserts).
}

async function sqlRemove(key) {
  const db = await getDb();
  if (!db) {
    try {
      await AsyncStorage.removeItem(key);
    } catch {
      /* ignore */
    }
    return;
  }
  // if users key, also clear station rows
  if (key.includes(':users:')) {
    const station = key.split(':').slice(2).join(':');
    if (station) {
      await db.runAsync('DELETE FROM cache_users WHERE station = ?', station);
    }
  }
  await db.runAsync('DELETE FROM cache_kv WHERE key = ?', key);
}

async function sqlClearAll() {
  const db = await getDb();
  if (!db) {
    try {
      const keys = await AsyncStorage.getAllKeys();
      const ours = (keys || []).filter((k) =>
        LEGACY_PREFIXES.some((p) => k.startsWith(p))
      );
      if (ours.length) await AsyncStorage.multiRemove(ours);
    } catch {
      /* ignore */
    }
    return;
  }
  await db.execAsync('DELETE FROM cache_kv; DELETE FROM cache_users;');
}

function scheduleDiskFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushDiskPending().catch(() => {});
  }, DISK_FLUSH_MS);
}

async function flushDiskPending() {
  if (!pendingDisk.size) return;
  const jobs = [];
  pendingDisk.forEach((v, k) => jobs.push([k, v]));
  pendingDisk.clear();
  for (const [k, job] of jobs) {
    try {
      await sqlSet(k, job.kind, job.id, job.ts, job.meta, job.data);
    } catch {
      /* L1 still holds data */
    }
  }
}

/**
 * @returns {{ data: any, ageMs: number, stale: boolean, expired: boolean } | null}
 */
export function cachePeek(kind, id = '') {
  const k = fullKey(kind, id);
  const hit = mem.get(k);
  if (!hit || hit.data === undefined) return null;
  touchAccess(hit);
  const ageMs = Date.now() - (hit.ts || 0);
  return {
    data: hit.data,
    ageMs,
    stale: ageMs > softTtl(kind),
    expired: ageMs > hardTtl(kind),
    meta: hit.meta || null,
  };
}

export async function cacheGet(kind, id = '') {
  const k = fullKey(kind, id);
  const memHit = mem.get(k);
  if (memHit && memHit.data !== undefined) {
    touchAccess(memHit);
    const ageMs = Date.now() - (memHit.ts || 0);
    return {
      data: memHit.data,
      ageMs,
      stale: ageMs > softTtl(kind),
      expired: ageMs > hardTtl(kind),
      meta: memHit.meta || null,
      source: 'memory',
    };
  }
  try {
    const row = await sqlGet(k);
    if (!row || row.data === undefined || row.data === null) return null;
    const entry = {
      ts: row.ts || 0,
      data: row.data,
      meta: row.meta,
      lastAccess: Date.now(),
    };
    mem.set(k, entry);
    memEvictIfNeeded();
    const ageMs = Date.now() - (entry.ts || 0);
    return {
      data: entry.data,
      ageMs,
      stale: ageMs > softTtl(kind),
      expired: ageMs > hardTtl(kind),
      meta: entry.meta || null,
      source: 'sqlite',
    };
  } catch {
    return null;
  }
}

/**
 * Optional: read users for a station straight from SQL table (fast path).
 * Falls back to cacheGet blob if table empty.
 */
export async function cacheGetUsers(station) {
  const st = String(station || '').toUpperCase();
  try {
    const db = await getDb();
    if (!db) return cacheGet('users', st);
    const rows = await db.getAllAsync(
      `SELECT id, username, rank, rank_level, banned, bank, gold_tipped,
              songs_played, room_minutes, room_time, gold_transferred_out,
              gold_transferred_in, ts
       FROM cache_users WHERE station = ?
       ORDER BY room_minutes DESC, username ASC`,
      st
    );
    if (rows && rows.length) {
      const data = rows.map((r) => ({
        id: r.id,
        username: r.username,
        rank: r.rank || 'guest',
        rank_level: r.rank_level ?? 0,
        banned: !!r.banned,
        bank: r.bank ?? 0,
        gold_tipped: r.gold_tipped ?? 0,
        songs_played: r.songs_played ?? 0,
        room_minutes: r.room_minutes ?? 0,
        room_time: r.room_time || '0m',
        station: st,
        gold_transferred_out: r.gold_transferred_out ?? 0,
        gold_transferred_in: r.gold_transferred_in ?? 0,
      }));
      const ts = rows[0]?.ts || Date.now();
      const ageMs = Date.now() - ts;
      return {
        data,
        ageMs,
        stale: ageMs > softTtl('users'),
        expired: ageMs > hardTtl('users'),
        meta: { total: data.length, source: 'sqlite_table' },
        source: 'sqlite_table',
      };
    }
  } catch {
    /* fall through */
  }
  return cacheGet('users', st);
}

export async function cacheSet(kind, id, data, meta = null) {
  if (!isCacheKindSafe(kind)) return;
  const k = fullKey(kind, id || '');
  const { payload, metaOut } = preparePayload(kind, data, meta);
  const memData =
    kind === 'users' && Array.isArray(data) ? data : payload;

  try {
    const probe = JSON.stringify(
      kind === 'users' && Array.isArray(payload)
        ? payload.slice(0, 20)
        : payload
    );
    if (probe && FORBIDDEN_CACHE_PATTERNS.some((re) => re.test(probe))) {
      return;
    }
  } catch {
    /* ignore */
  }

  const now = Date.now();
  const entry = {
    ts: now,
    data: memData,
    meta: metaOut,
    lastAccess: now,
  };

  // Skip disk if unchanged (cheap fingerprint)
  const prev = mem.get(k);
  if (prev && prev.data !== undefined) {
    try {
      let same = false;
      const compareArr = Array.isArray(memData) ? memData : payload;
      if (Array.isArray(compareArr) && Array.isArray(prev.data)) {
        const a = prev.data;
        const b = compareArr;
        if (a.length === b.length) {
          if (a.length === 0) same = true;
          else if (kind === 'status' && a.length <= MAX_STATUS_ROWS) {
            same = true;
            for (let i = 0; i < a.length; i += 1) {
              if (
                a[i]?.id !== b[i]?.id ||
                a[i]?.status !== b[i]?.status ||
                a[i]?.pid !== b[i]?.pid ||
                !!a[i]?.auto_restart !== !!b[i]?.auto_restart
              ) {
                same = false;
                break;
              }
            }
          } else if (kind === 'users' && a.length > 50) {
            const mid = a[Math.floor(a.length / 2)];
            const midB = b[Math.floor(b.length / 2)];
            same =
              (a[0]?.id || a[0]?.username) === (b[0]?.id || b[0]?.username) &&
              (a[a.length - 1]?.id || a[a.length - 1]?.username) ===
                (b[b.length - 1]?.id || b[b.length - 1]?.username) &&
              (mid?.id || mid?.username) === (midB?.id || midB?.username) &&
              (prev.meta?.total ?? a.length) === (metaOut?.total ?? b.length);
          } else {
            same =
              (a[0]?.id || a[0]?.username || a[0]?.text) ===
                (b[0]?.id || b[0]?.username || b[0]?.text) &&
              (a[a.length - 1]?.id ||
                a[a.length - 1]?.username ||
                a[a.length - 1]?.text) ===
                (b[b.length - 1]?.id ||
                  b[b.length - 1]?.username ||
                  b[b.length - 1]?.text) &&
              (prev.meta?.total ?? a.length) === (metaOut?.total ?? b.length);
          }
        }
      } else if (
        kind === 'streams' &&
        payload &&
        prev.data &&
        typeof payload === 'object' &&
        typeof prev.data === 'object'
      ) {
        const ps = prev.data.stations || prev.data;
        const ns = payload.stations || payload;
        const pk = Object.keys(ps || {});
        const nk = Object.keys(ns || {});
        if (pk.length === nk.length) {
          same = true;
          for (let i = 0; i < nk.length; i += 1) {
            const key = nk[i];
            const A = ps[key] || {};
            const B = ns[key] || {};
            if (
              A.title !== B.title ||
              A.listeners !== B.listeners ||
              A.online !== B.online
            ) {
              same = false;
              break;
            }
          }
        }
      } else {
        same =
          JSON.stringify(prev.data) === JSON.stringify(payload) &&
          JSON.stringify(prev.meta || null) === JSON.stringify(metaOut || null);
      }
      if (same) {
        prev.ts = now;
        touchAccess(prev);
        return;
      }
    } catch {
      /* fall through */
    }
  }

  mem.set(k, entry);
  memEvictIfNeeded();

  pendingDisk.set(k, {
    kind,
    id: id || '',
    ts: entry.ts,
    meta: metaOut,
    data: payload,
  });
  scheduleDiskFlush();
}

export async function cacheRemove(kind, id = '') {
  const k = fullKey(kind, id);
  mem.delete(k);
  pendingDisk.delete(k);
  try {
    await sqlRemove(k);
  } catch {
    /* ignore */
  }
}

export async function cacheClearAll() {
  mem.clear();
  pendingDisk.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    await sqlClearAll();
  } catch {
    /* ignore */
  }
  // Also wipe any leftover AsyncStorage cache keys
  try {
    const keys = await AsyncStorage.getAllKeys();
    const ours = (keys || []).filter((k) =>
      LEGACY_PREFIXES.some((p) => k.startsWith(p))
    );
    if (ours.length) await AsyncStorage.multiRemove(ours);
  } catch {
    /* ignore */
  }
}

/** True if we should paint this cache entry (not past hard / 7-day limit). */
export function cacheUsable(peek) {
  if (!peek || peek.data == null) return false;
  return !peek.expired;
}

/** True if soft TTL elapsed — still paint, but network should refresh now. */
export function cacheNeedsRefresh(peek) {
  if (!peek || peek.data == null) return true;
  return !!peek.stale || !!peek.expired;
}

export async function cacheFlush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushDiskPending();
}

/** Call once at app boot to open DB early — never hangs more than ~1.5s */
export async function cacheInit() {
  try {
    const db = await withTimeout(getDb(), 2000, 'cacheInit_timeout');
    return !!db;
  } catch {
    _sqliteFailed = true;
    return false;
  }
}

export function cacheStats() {
  return {
    memKeys: mem.size,
    pendingDisk: pendingDisk.size,
    backend: _sqliteFailed ? 'asyncstorage-fallback' : 'sqlite',
    db: 'commander_pro_cache.db',
    prefix: PREFIX,
    ttls: { ...CACHE_TTL },
    hardTtls: { ...CACHE_HARD_TTL },
    weekMs: CACHE_WEEK_MS,
    maxUsers: MAX_USERS_CACHE,
  };
}
