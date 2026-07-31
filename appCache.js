/**
 * Commander PRO — client cache (bigger + more efficient)
 *
 * L1: in-memory Map with LRU eviction (instant tab switches)
 * L2: AsyncStorage with debounced multiSet (survives restarts)
 *
 * Stale-while-revalidate: paint cache immediately, refresh in background.
 * Soft TTL → show as "stale" but still paint.
 * Hard TTL → too old to paint (still kept until overwritten / logout).
 *
 * Users: full station directory (no 3500 cap). Large lists use chunked disk
 * storage so AsyncStorage quotas don't drop the whole payload.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { isCacheKindSafe } from './apiSecurity';

/** Bump when entry shape changes (old keys cleaned on clear / overwrite). */
const PREFIX = '@cp_cache_v2:';
const LEGACY_PREFIXES = ['@cp_cache_v1:'];

/** Never persist these substrings (defense in depth — tokens stay in SecureStore only).
 *  Keep patterns tight: loose /password/i would block usernames like "password1".
 */
const FORBIDDEN_CACHE_PATTERNS = [
  /"password"\s*:/i,
  /"password_hash"\s*:/i,
  /"token"\s*:\s*"[0-9a-fA-F]{32,}/i,
  /"salt"\s*:\s*"[0-9a-fA-F]{8,}/i,
  /Bearer\s+[0-9a-fA-F]{16,}/i,
];

/** key -> { ts, data, meta, lastAccess } */
const mem = new Map();

/**
 * Soft TTLs (ms) — how long data is considered fresh.
 * Users/stats: 5 minutes (was ~2–3 min). Status/notify: longer paint windows
 * so returning to the main page never looks "offline empty" after a short blip.
 */
export const CACHE_TTL = {
  status: 120_000, // 2 min soft — process list paints on resume
  stats: 300_000, // 5 min
  users: 300_000, // 5 min — full radio directory
  playlist: 120_000,
  notify: 180_000, // 3 min — alerts feed survives tab switches / resume
  app_users: 180_000,
  security: 90_000,
  streams: 20_000, // Icecast title/listeners
};

/** Hard expiry = soft × HARD_MULT (still paint while soft < age < hard) */
const HARD_MULT = 36; // users soft 5m → hard ~3h offline paint

/** Max entries in L1 (LRU by lastAccess) — raised for multi-radio owners */
const MEM_MAX_KEYS = 120;

/**
 * No artificial user cap — radios can hold 10k–20k+ names.
 * Disk uses chunked storage so a single multiSet never blows AsyncStorage.
 */
const MAX_USERS_CACHE = 100_000;
const USERS_CHUNK_SIZE = 2_500;
const MAX_NOTIFY_CACHE = 400;
const MAX_PLAYLIST_SONGS = 800;
const MAX_STATUS_ROWS = 200;

/** Debounce disk writes so rapid polls don't thrash AsyncStorage */
const DISK_FLUSH_MS = 500;
const pendingDisk = new Map(); // key -> JSON string | special users job
let flushTimer = null;
let legacyCleaned = false;

function fullKey(kind, id = '') {
  return `${PREFIX}${kind}${id ? `:${id}` : ''}`;
}

function softTtl(kind) {
  return CACHE_TTL[kind] || 60_000;
}

function hardTtl(kind) {
  return softTtl(kind) * HARD_MULT;
}

function touchAccess(entry) {
  if (entry) entry.lastAccess = Date.now();
}

/** Evict least-recently-used memory entries when over cap (O(n), no sort alloc when tiny). */
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

/**
 * Compact user rows for disk — drop bulky / unused fields so we can store thousands.
 */
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

/**
 * Shrink large payloads for disk efficiency.
 * Memory may still hold a larger slice when set from network.
 * Users are NOT truncated to 3500 — full catalog is kept (capped only at absolute max).
 */
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

function scheduleDiskFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushDiskPending().catch(() => {});
  }, DISK_FLUSH_MS);
}

/**
 * Write large user arrays as chunked keys so one failed multiSet never drops
 * the entire directory. Format:
 *   main key: { ts, meta, chunked: true, chunks: N, total: T }
 *   chunk keys: `${main}:c0` … `${main}:cN-1` → JSON array
 */
async function writeUsersChunked(mainKey, ts, payload, metaOut) {
  const chunks = [];
  for (let i = 0; i < payload.length; i += USERS_CHUNK_SIZE) {
    chunks.push(payload.slice(i, i + USERS_CHUNK_SIZE));
  }
  const header = JSON.stringify({
    ts,
    data: null,
    meta: metaOut,
    chunked: true,
    chunks: chunks.length,
    total: payload.length,
  });
  const pairs = [[mainKey, header]];
  for (let i = 0; i < chunks.length; i += 1) {
    pairs.push([`${mainKey}:c${i}`, JSON.stringify(chunks[i])]);
  }
  // Drop stale chunks if list shrank
  try {
    const all = await AsyncStorage.getAllKeys();
    const prefix = `${mainKey}:c`;
    const stale = (all || []).filter(
      (k) => k.startsWith(prefix) && !pairs.some(([pk]) => pk === k)
    );
    if (stale.length) await AsyncStorage.multiRemove(stale);
  } catch {
    /* ignore */
  }
  await AsyncStorage.multiSet(pairs);
}

async function readUsersChunked(mainKey, parsed) {
  const n = Math.max(0, parseInt(parsed.chunks, 10) || 0);
  if (!n) return Array.isArray(parsed.data) ? parsed.data : [];
  const keys = [];
  for (let i = 0; i < n; i += 1) keys.push(`${mainKey}:c${i}`);
  const pairs = await AsyncStorage.multiGet(keys);
  const out = [];
  for (let i = 0; i < pairs.length; i += 1) {
    const raw = pairs[i]?.[1];
    if (!raw) continue;
    try {
      const part = JSON.parse(raw);
      if (Array.isArray(part)) {
        for (let j = 0; j < part.length; j += 1) out.push(part[j]);
      }
    } catch {
      /* skip bad chunk */
    }
  }
  return out;
}

async function flushDiskPending() {
  if (!pendingDisk.size) return;
  const jobs = [];
  pendingDisk.forEach((value, key) => {
    jobs.push([key, value]);
  });
  pendingDisk.clear();

  const simplePairs = [];
  const usersJobs = [];

  for (const [k, v] of jobs) {
    if (v && typeof v === 'object' && v.__usersChunks) {
      usersJobs.push([k, v]);
    } else {
      simplePairs.push([k, v]);
    }
  }

  try {
    if (simplePairs.length) await AsyncStorage.multiSet(simplePairs);
  } catch {
    // Quota / disk errors — retry one-by-one, never skip status/notify
    for (const [k, v] of simplePairs) {
      try {
        await AsyncStorage.setItem(k, v);
      } catch {
        /* ignore single key */
      }
    }
  }

  for (const [k, job] of usersJobs) {
    try {
      await writeUsersChunked(k, job.ts, job.payload, job.metaOut);
    } catch {
      // Fallback: try smaller single blob (may fail on huge lists)
      try {
        const raw = JSON.stringify({
          ts: job.ts,
          data: job.payload.slice(0, 4000),
          meta: { ...(job.metaOut || {}), truncated: true, fallback: true },
        });
        await AsyncStorage.setItem(k, raw);
      } catch {
        /* L1 memory still serves the UI */
      }
    }
  }
}

/** One-time: drop legacy v1 keys so storage doesn't fill with duplicates */
async function cleanLegacyOnce() {
  if (legacyCleaned) return;
  legacyCleaned = true;
  try {
    const keys = await AsyncStorage.getAllKeys();
    const dead = (keys || []).filter((k) =>
      LEGACY_PREFIXES.some((p) => k.startsWith(p))
    );
    if (dead.length) await AsyncStorage.multiRemove(dead);
  } catch {
    /* ignore */
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
  cleanLegacyOnce().catch(() => {});
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
    const raw = await AsyncStorage.getItem(k);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    let data = parsed.data;
    // Reassemble chunked users directory
    if (kind === 'users' && parsed.chunked) {
      data = await readUsersChunked(k, parsed);
    }

    if (data === undefined || data === null) return null;

    const entry = {
      ts: parsed.ts || 0,
      data,
      meta: parsed.meta,
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
      source: 'disk',
    };
  } catch {
    return null;
  }
}

/**
 * Store data in L1 immediately; L2 disk is debounced (batched multiSet).
 * Skips disk rewrite when fingerprint matches (same length + ts-independent hash).
 * Security: refuse unknown kinds + strip accidental secrets from disk payloads.
 */
export async function cacheSet(kind, id, data, meta = null) {
  if (!isCacheKindSafe(kind)) {
    // Never cache auth blobs / unknown kinds
    return;
  }
  const k = fullKey(kind, id || '');
  const { payload, metaOut } = preparePayload(kind, data, meta);
  // L1 keeps the full users array for instant tab paint; L2 disk stays compact.
  const memData =
    kind === 'users' && Array.isArray(data) ? data : payload;

  // Defense-in-depth: refuse to persist anything that looks like a secret
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

  // Skip disk/work if payload looks unchanged (rapid polls)
  const prev = mem.get(k);
  if (prev && prev.data !== undefined) {
    try {
      let same = false;
      const compareArr = Array.isArray(memData) ? memData : payload;
      if (Array.isArray(compareArr) && Array.isArray(prev.data)) {
        const a = prev.data;
        const b = compareArr;
        if (a.length === b.length) {
          if (a.length === 0) {
            same = true;
          } else if (kind === 'status' && a.length <= MAX_STATUS_ROWS) {
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
            // Cheap multi-edge fingerprint for large user catalogs
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
        const sa = JSON.stringify(prev.data);
        const sb = JSON.stringify(payload);
        same =
          sa === sb &&
          JSON.stringify(prev.meta || null) === JSON.stringify(metaOut || null);
      }
      if (same) {
        prev.ts = now;
        touchAccess(prev);
        return;
      }
    } catch {
      /* fall through to write */
    }
  }

  mem.set(k, entry);
  memEvictIfNeeded();

  try {
    if (kind === 'users' && Array.isArray(payload)) {
      // Always chunk users — never a single giant JSON blob
      pendingDisk.set(k, {
        __usersChunks: true,
        ts: entry.ts,
        payload,
        metaOut,
      });
    } else {
      const raw = JSON.stringify({
        ts: entry.ts,
        data: payload,
        meta: metaOut,
      });
      pendingDisk.set(k, raw);
    }
    scheduleDiskFlush();
  } catch {
    /* serialize failed — memory still holds data */
  }
}

export async function cacheRemove(kind, id = '') {
  const k = fullKey(kind, id);
  mem.delete(k);
  pendingDisk.delete(k);
  try {
    const keys = await AsyncStorage.getAllKeys();
    const ours = (keys || []).filter(
      (x) => x === k || x.startsWith(`${k}:c`)
    );
    if (ours.length) await AsyncStorage.multiRemove(ours);
    else await AsyncStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

/** Clear all Commander PRO cache keys (logout). */
export async function cacheClearAll() {
  mem.clear();
  pendingDisk.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    const keys = await AsyncStorage.getAllKeys();
    const ours = (keys || []).filter(
      (k) =>
        k.startsWith(PREFIX) ||
        LEGACY_PREFIXES.some((p) => k.startsWith(p))
    );
    if (ours.length) await AsyncStorage.multiRemove(ours);
  } catch {
    /* ignore */
  }
}

/**
 * Helper: return cached data immediately if usable, else null.
 * expired=true means too old to paint (still can try network).
 */
export function cacheUsable(peek) {
  if (!peek || peek.data == null) return false;
  return !peek.expired;
}

/** Force flush pending disk writes (optional — call before backgrounding). */
export async function cacheFlush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushDiskPending();
}

/** Debug / settings: rough memory cache stats */
export function cacheStats() {
  return {
    memKeys: mem.size,
    pendingDisk: pendingDisk.size,
    prefix: PREFIX,
    ttls: { ...CACHE_TTL },
    hardMult: HARD_MULT,
    maxUsers: MAX_USERS_CACHE,
    usersChunk: USERS_CHUNK_SIZE,
  };
}
