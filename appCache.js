/**
 * Commander PRO — client cache
 *
 * L1: in-memory Map (instant tab switches)
 * L2: AsyncStorage (survives app restarts; larger than SecureStore ~2KB)
 *
 * Stale-while-revalidate: show cache immediately, refresh in background.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = '@cp_cache_v1:';
const mem = new Map(); // key -> { ts, data, meta }

/** Default TTLs (ms) — soft: show stale; hard: prefer network only if too old */
export const CACHE_TTL = {
  status: 20_000,
  stats: 60_000,
  users: 45_000,
  playlist: 30_000,
  notify: 25_000,
  app_users: 40_000,
  security: 20_000,
};

const HARD_MULT = 12; // hard expiry = soft * 12 (e.g. stats soft 1m → hard 12m)

function fullKey(kind, id = '') {
  return `${PREFIX}${kind}${id ? `:${id}` : ''}`;
}

function softTtl(kind) {
  return CACHE_TTL[kind] || 30_000;
}

function hardTtl(kind) {
  return softTtl(kind) * HARD_MULT;
}

/**
 * @returns {{ data: any, ageMs: number, stale: boolean, expired: boolean } | null}
 */
export function cachePeek(kind, id = '') {
  const k = fullKey(kind, id);
  const hit = mem.get(k);
  if (!hit || hit.data === undefined) return null;
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
    mem.set(k, { ts: parsed.ts || 0, data: parsed.data, meta: parsed.meta });
    const ageMs = Date.now() - (parsed.ts || 0);
    return {
      data: parsed.data,
      ageMs,
      stale: ageMs > softTtl(kind),
      expired: ageMs > hardTtl(kind),
      meta: parsed.meta || null,
      source: 'disk',
    };
  } catch {
    return null;
  }
}

export async function cacheSet(kind, id, data, meta = null) {
  const k = fullKey(kind, id || '');
  const entry = { ts: Date.now(), data, meta };
  mem.set(k, entry);
  try {
    // Cap large payloads — users browse can be huge; keep a compact snapshot
    let payload = data;
    if (kind === 'users' && Array.isArray(data) && data.length > 400) {
      payload = data.slice(0, 400);
      entry.meta = { ...(meta || {}), truncated: true, total: data.length };
      mem.set(k, entry);
    }
    if (kind === 'notify' && Array.isArray(data) && data.length > 120) {
      payload = data.slice(0, 120);
    }
    await AsyncStorage.setItem(
      k,
      JSON.stringify({ ts: entry.ts, data: payload, meta: entry.meta || meta })
    );
  } catch {
    /* disk full / quota — memory still works */
  }
}

export async function cacheRemove(kind, id = '') {
  const k = fullKey(kind, id);
  mem.delete(k);
  try {
    await AsyncStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

/** Clear all Commander PRO cache keys (logout). */
export async function cacheClearAll() {
  mem.clear();
  try {
    const keys = await AsyncStorage.getAllKeys();
    const ours = (keys || []).filter((k) => k.startsWith(PREFIX));
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
