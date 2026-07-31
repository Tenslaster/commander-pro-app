/**
 * Smart adaptive polling — faster when things change, calmer when quiet.
 * Tuned for mid phones + busy radio host (i5 / HDD) + API smart caches.
 *
 * Android + iOS parity:
 *  - `active` → full adaptive schedule
 *  - `inactive` (iOS Control Center / app switcher peek) → medium delay, not full sleep
 *  - `background` → long floor (battery + host)
 * Aligns with server TTLs (status ~1.4s, streams ~4s, stats ~45s).
 */

/**
 * Normalize AppState for polling.
 * @returns {'active'|'inactive'|'background'}
 */
export function normalizeAppState(state) {
  const s = String(state || 'active');
  if (s === 'active') return 'active';
  if (s === 'inactive') return 'inactive';
  return 'background';
}

/**
 * @param {{
 *   minMs: number,
 *   maxMs: number,
 *   stepUp?: number,
 *   stepDown?: number,
 *   quietBeforeSlow?: number,
 *   bgFloorMs?: number,
 *   inactiveFloorMs?: number,
 * }} opts
 */
export function createAdaptiveBudget({
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
    /** Call after each poll. `changed` = data actually differed. Returns next delay ms. */
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
    /** Full background (home screen / other app) */
    bgDelay() {
      return Math.max(bgFloor, current, 12000);
    },
    /** iOS inactive only — user may still be looking */
    inactiveDelay() {
      return Math.max(inactiveFloor, Math.min(hi, Math.round(current * 1.6)));
    },
    reset() {
      quietHits = 0;
      current = lo;
    },
  };
}

/**
 * setTimeout loop with adaptive delay. Safer than setInterval when work varies.
 * Never overlaps ticks; backs off on errors; Android + iOS AppState aware.
 *
 * @param {(ctx: { signal: { aborted: boolean } }) => Promise<boolean|void>|boolean|void} tick
 * @param {{
 *   budget: ReturnType<typeof createAdaptiveBudget>,
 *   enabled?: () => boolean,
 *   pauseWhenBackground?: boolean,
 *   getAppState?: () => string,
 *   immediate?: boolean,
 * }} opts
 * @returns {() => void} stop
 */
export function startSmartLoop(tick, opts) {
  const budget = opts.budget;
  const enabled = typeof opts.enabled === 'function' ? opts.enabled : () => true;
  const pauseBg = opts.pauseWhenBackground !== false;
  let timer = null;
  let stopped = false;
  let inflight = false;
  const signal = { aborted: false };
  let consecutiveErrors = 0;

  const schedule = (ms) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, Math.max(500, ms | 0));
  };

  const run = async () => {
    timer = null;
    if (stopped) return;
    if (!enabled()) {
      schedule(Math.max(budget.peek(), 4000));
      return;
    }
    if (pauseBg && typeof opts.getAppState === 'function') {
      const phase = normalizeAppState(opts.getAppState());
      if (phase === 'background') {
        const bgMs =
          typeof budget.bgDelay === 'function'
            ? budget.bgDelay()
            : Math.max(budget.peek(), 14000);
        schedule(bgMs);
        return;
      }
      if (phase === 'inactive') {
        // iOS: Control Center / phone call UI — slow but don't fully sleep
        // (status should refresh when user returns without waiting full bg floor)
        const idleMs =
          typeof budget.inactiveDelay === 'function'
            ? budget.inactiveDelay()
            : Math.max(budget.peek(), 6000);
        schedule(idleMs);
        return;
      }
      // active: if we just left a long bg delay, budget.boost() is called from App.js
    }
    if (inflight) {
      schedule(Math.min(2500, Math.max(800, budget.peek())));
      return;
    }
    inflight = true;
    let changed = false;
    try {
      const r = await tick({ signal });
      changed = r === true;
      consecutiveErrors = 0;
    } catch {
      changed = false;
      consecutiveErrors += 1;
    } finally {
      inflight = false;
    }
    if (stopped) return;
    let delay = budget.next(changed);
    if (consecutiveErrors >= 2) {
      delay = Math.min(
        typeof budget.bgDelay === 'function' ? budget.bgDelay() : 20000,
        Math.round(delay * (1 + consecutiveErrors * 0.35))
      );
    }
    schedule(delay);
  };

  schedule(opts.immediate ? 120 : Math.min(700, budget.peek()));

  return () => {
    stopped = true;
    signal.aborted = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

/** Fingerprint process list for change detection (status + pid only). */
export function fingerprintProcesses(list) {
  if (!Array.isArray(list) || !list.length) return '0';
  let s = String(list.length);
  for (let i = 0; i < list.length; i += 1) {
    const p = list[i];
    s += `|${p.id}:${p.status}:${p.pid || 0}:${p.auto_restart ? 1 : 0}`;
  }
  return s;
}

/** Fingerprint streams map for current station or whole map. */
export function fingerprintStreams(map, stationId) {
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

/** Cheap log buffer fingerprint (length + edges). */
export function fingerprintLogs(rows) {
  if (!Array.isArray(rows) || !rows.length) return '0';
  const n = rows.length;
  const first = rows[0];
  const last = rows[n - 1];
  const ft = typeof first === 'string' ? first : first?.text || '';
  const lt = typeof last === 'string' ? last : last?.text || '';
  const ltype = typeof last === 'object' && last ? last.type || '' : '';
  return `${n}|${ft.length}|${lt.length}|${ltype}|${lt.slice(-48)}`;
}

/** Notify feed fingerprint */
export function fingerprintNotify(items) {
  if (!Array.isArray(items) || !items.length) return '0';
  const a = items[0];
  const b = items[items.length - 1];
  return `${items.length}|${a?.id || ''}|${a?.ts || 0}|${b?.id || ''}|${b?.ts || 0}`;
}
