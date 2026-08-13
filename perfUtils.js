/**
 * RN-free hot-path helpers (cache fingerprints, stats, interpolate).
 * Imported by App / cache / i18n and by the Node bench.
 */

export function fnv1aHex(str) {
  const s = String(str || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return (h >>> 0).toString(16);
}

/** In-flight map key: length + tail — not the full session token. */
export function tokenDedupeId(token) {
  if (!token) return '';
  const t = String(token);
  const n = t.length;
  return n <= 10 ? t : `${n}:${t.slice(-8)}`;
}

/** `{name}` replace without compiling a RegExp per call. */
export function interpolate(template, vars) {
  let s = String(template ?? '');
  if (!vars || typeof vars !== 'object') return s;
  const keys = Object.keys(vars);
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    const needle = `{${k}}`;
    if (s.indexOf(needle) === -1) continue;
    s = s.split(needle).join(String(vars[k]));
  }
  return s;
}

export function payloadLooksSensitive(kind, data) {
  if (data == null) return false;
  const checkObj = (o) =>
    !!(
      o &&
      typeof o === 'object' &&
      (o.password ||
        o.password_hash ||
        o.token ||
        o.salt ||
        o.Authorization ||
        o.session_token)
    );
  if (Array.isArray(data)) {
    const n = Math.min(data.length, 12);
    for (let i = 0; i < n; i += 1) {
      if (checkObj(data[i])) return true;
    }
    return false;
  }
  if (typeof data === 'object') return checkObj(data);
  return false;
}

/** Cheap equality fingerprint — never JSON.stringify a 10k-user / stats tree. */
export function cheapCacheFp(kind, data, meta) {
  if (data == null) return `${kind}|n`;
  if (Array.isArray(data)) {
    const n = data.length;
    if (n === 0) return `${kind}|0|${meta?.total ?? 0}`;
    const a = data[0] || {};
    const b = data[n - 1] || {};
    const m = n > 2 ? data[n >> 1] || {} : a;
    return `${kind}|${n}|${a.id || a.username || a.text || ''}|${m.id || m.username || ''}|${b.id || b.username || b.text || ''}|${a.status || ''}|${b.status || ''}|${a.pid || ''}|${meta?.total ?? n}`;
  }
  if (kind === 'stats' && typeof data === 'object') {
    return fingerprintStats(data);
  }
  if (kind === 'streams' && typeof data === 'object') {
    const st = data.stations || data;
    const keys = st && typeof st === 'object' ? Object.keys(st) : [];
    let s = `streams|${keys.length}`;
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      const a = st[k] || {};
      s += `|${k}:${a.title || ''}:${a.listeners ?? 'x'}:${a.online ? 1 : 0}`;
    }
    return s;
  }
  if (typeof data === 'object') {
    const keys = Object.keys(data);
    const n = keys.length;
    const first = n ? keys[0] : '';
    const last = n ? keys[n - 1] : '';
    return `${kind}|${n}|${first}|${last}|${meta?.total ?? ''}`;
  }
  return `${kind}|${String(data).slice(0, 48)}`;
}

export function fingerprintStats(payload) {
  if (!payload || typeof payload !== 'object') return '0';
  const s = payload.stats && typeof payload.stats === 'object' ? payload.stats : payload;
  const d = s.day || {};
  const w = s.week || {};
  const m = s.month || {};
  const l = s.lifetime || {};
  const boards = s.leaderboards || {};
  const tip0 = (boards.tippers && boards.tippers[0]) || {};
  return [
    payload.station || '',
    s.as_of || '',
    d.tips_gold,
    d.tips_count,
    d.songs,
    d.visitors,
    d.people_max,
    d.transfers_gold,
    w.tips_gold,
    w.songs,
    w.visitors,
    m.tips_gold,
    m.songs,
    m.visitors,
    l.tips_gold,
    l.songs,
    l.visitors,
    l.bank_total,
    l.skips,
    l.room_minutes_total,
    tip0.user || '',
    tip0.value ?? '',
    s.tracked_days ?? '',
  ].join('|');
}
