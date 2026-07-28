/**
 * Commander PRO — client cache (bigger + more efficient)
 *
 * L1: in-memory Map with LRU eviction (instant tab switches)
 * L2: AsyncStorage with debounced multiSet (survives restarts)
 *
 * Stale-while-revalidate: paint cache immediately, refresh in background.
 * Soft TTL → show as "stale" but still paint.
 * Hard TTL → too old to paint (still kept until overwritten / logout).
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

/** Soft TTLs (ms) — how long data is considered fresh (aligned with API caches) */
export const CACHE_TTL = {
  status: 55_000, // process list — host status cache ~1.4s; paint longer
  stats: 200_000, // ~3.3 min — room unique counts change slowly
  users: 160_000, // large payload
  playlist: 100_000,
  notify: 70_000,
  app_users: 140_000,
  security: 55_000,
  streams: 12_000, // Icecast title/listeners (server TTL ~4–14s)
};

/** Hard expiry = soft × HARD_MULT (still paint while soft < age < hard) */
const HARD_MULT = 28; // e.g. stats soft → hard ~90m offline paint

/** Max entries in L1 (LRU by lastAccess) */
const MEM_MAX_KEYS = 80;

/** Payload size caps (disk) */
const MAX_USERS_CACHE = 3500;
const MAX_NOTIFY_CACHE = 200; // match smaller server feed (800) — phone needs less
const MAX_PLAYLIST_SONGS = 600;
const MAX_STATUS_ROWS = 120;

/** Debounce disk writes so rapid polls don't thrash AsyncStorage */
const DISK_FLUSH_MS = 700;
const pendingDisk = new Map(); // key -> JSON string
let flushTimer = null;
let legacyCleaned = false;

function fullKey(kind, id = '') {
  return `${PREFIX}${kind}${id ? `:${id}` : ''}`;
}

function softTtl(kind) {
  return CACHE_TTL[kind] || 45_000;
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
  const drop = mem.size - MEM_MAX_KEYS + 6;
  // Two-pass min-find: avoid sorting whole map on every set under flood
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

async function flushDiskPending() {
  if (!pendingDisk.size) return;
  const pairs = [];
  pendingDisk.forEach((value, key) => {
    pairs.push([key, value]);
  });
  pendingDisk.clear();
  try {
    // multiSet is much cheaper than many setItem calls under load
    await AsyncStorage.multiSet(pairs);
  } catch {
    // Quota / disk errors — L1 memory still serves the UI
    try {
      // Fallback: write smaller critical keys only
      for (const [k, v] of pairs) {
        if (k.includes(':users:') || k.includes(':status')) continue;
        await AsyncStorage.setItem(k, v);
      }
    } catch {
      /* ignore */
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
    const entry = {
      ts: parsed.ts || 0,
      data: parsed.data,
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

  // Defense-in-depth: refuse to persist anything that looks like a secret
  try {
    const probe = JSON.stringify(payload);
    if (probe && FORBIDDEN_CACHE_PATTERNS.some((re) => re.test(probe))) {
      // Keep L1 only without secrets — drop entirely if contaminated
      return;
    }
  } catch {
    /* ignore */
  }

  const now = Date.now();
  const entry = {
    ts: now,
    data: payload,
    meta: metaOut,
    lastAccess: now,
  };

  // Skip disk/work if payload looks unchanged (rapid polls) — avoid JSON.stringify
  const prev = mem.get(k);
  if (prev && prev.data !== undefined) {
    try {
      let same = false;
      if (Array.isArray(payload) && Array.isArray(prev.data)) {
        const a = prev.data;
        const b = payload;
        if (a.length === b.length) {
          if (a.length === 0) {
            same = true;
          } else if (kind === 'status' && a.length <= 120) {
            // Status rows are small — compare status+pid without stringify
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
          } else {
            // Cheap edge fingerprint for large arrays (users / notify)
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
        // streams: compare station title/listeners only
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
        // Last resort for small objects only
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
    const raw = JSON.stringify({
      ts: entry.ts,
      data: payload,
      meta: metaOut,
    });
    pendingDisk.set(k, raw);
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
    await AsyncStorage.removeItem(k);
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
  };
}
