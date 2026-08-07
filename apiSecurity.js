/**
 * Commander PRO — client security helpers
 *
 * Goals:
 *  - HTTPS-only API in production (no cleartext MITM)
 *  - Request timestamps + nonces for mutating calls (replay friction)
 *  - Safe headers (no secrets in logs)
 *  - Never put tokens into AsyncStorage cache
 */

// Polyfill crypto.getRandomValues on RN / Expo Go (must run before nonce gen)
try {
  // eslint-disable-next-line global-require, import/no-extraneous-dependencies
  require('react-native-get-random-values');
} catch {
  /* optional — may not be installed yet */
}

import { Platform } from 'react-native';
import * as Device from 'expo-device';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { assertSecureApiUrl } from './deviceSecurity';

const IS_EXPO_GO =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient ||
  Constants.appOwnership === 'expo';

/** @type {Uint8Array | null} */
let _noncePool = null;
let _noncePoolOff = 0;
let _nonceWarmPromise = null;

function _bytesToHex(arr) {
  let out = '';
  for (let i = 0; i < arr.length; i += 1) out += arr[i].toString(16).padStart(2, '0');
  return out;
}

function _webCrypto() {
  return (
    (typeof globalThis !== 'undefined' && globalThis.crypto) ||
    (typeof global !== 'undefined' && global.crypto) ||
    null
  );
}

/**
 * Fill a pool of secure random bytes (async expo-crypto / WebCrypto).
 * Call at app boot so sync nonce gen never blocks or fails.
 */
export async function warmSecureRandom(poolBytes = 512) {
  if (_nonceWarmPromise) return _nonceWarmPromise;
  _nonceWarmPromise = (async () => {
    try {
      // expo-crypto (works on Expo Go + standalone without WebCrypto)
      try {
        // eslint-disable-next-line global-require, import/no-extraneous-dependencies
        const ExpoCrypto = require('expo-crypto');
        if (ExpoCrypto?.getRandomBytesAsync) {
          const buf = await ExpoCrypto.getRandomBytesAsync(poolBytes);
          _noncePool = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
          _noncePoolOff = 0;
          return;
        }
        if (typeof ExpoCrypto?.getRandomBytes === 'function') {
          const buf = ExpoCrypto.getRandomBytes(poolBytes);
          _noncePool = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
          _noncePoolOff = 0;
          return;
        }
      } catch {
        /* try WebCrypto below */
      }
      const c = _webCrypto();
      if (c?.getRandomValues) {
        const buf = new Uint8Array(poolBytes);
        c.getRandomValues(buf);
        _noncePool = buf;
        _noncePoolOff = 0;
      }
    } catch {
      /* leave pool empty — sync path has more fallbacks */
    } finally {
      _nonceWarmPromise = null;
    }
  })();
  return _nonceWarmPromise;
}

function _takeFromPool(n) {
  if (!_noncePool || _noncePoolOff + n > _noncePool.length) return null;
  const slice = _noncePool.subarray(_noncePoolOff, _noncePoolOff + n);
  _noncePoolOff += n;
  // Refill in background when half used
  if (_noncePoolOff > _noncePool.length / 2) {
    warmSecureRandom().catch(() => {});
  }
  return slice;
}

/**
 * Cryptographically strong nonce for anti-replay headers.
 * Order: WebCrypto → expo-crypto sync → pre-warmed pool → high-entropy composite
 * (never plain Math.random alone).
 */
export function randomNonceHex(bytes = 12) {
  const n = Math.max(8, Math.min(32, bytes | 0));

  // 1) WebCrypto / polyfilled getRandomValues (after get-random-values import)
  try {
    const c = _webCrypto();
    if (c && typeof c.getRandomValues === 'function') {
      const arr = new Uint8Array(n);
      c.getRandomValues(arr);
      return _bytesToHex(arr);
    }
  } catch {
    /* continue */
  }

  // 2) expo-crypto sync API (when available)
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    const ExpoCrypto = require('expo-crypto');
    if (typeof ExpoCrypto?.getRandomBytes === 'function') {
      const buf = ExpoCrypto.getRandomBytes(n);
      const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      return _bytesToHex(arr);
    }
  } catch {
    /* continue */
  }

  // 3) Pre-warmed pool from warmSecureRandom() at app boot
  try {
    const slice = _takeFromPool(n);
    if (slice && slice.length === n) {
      return _bytesToHex(slice);
    }
  } catch {
    /* continue */
  }

  // 4) Kick async warm for next time
  warmSecureRandom().catch(() => {});

  // 5) Last-resort uniqueness (anti-replay still works with server-side nonce store
  //    + timestamp). Mix timer entropy + counter — NOT Math.random() alone.
  //    Still better than failing every POST in Expo Go without WebCrypto.
  const arr = new Uint8Array(n);
  let c = (randomNonceHex._c = ((randomNonceHex._c || 0) + 1) >>> 0);
  let t =
    (typeof performance !== 'undefined' && performance.now
      ? performance.now()
      : 0) * 1000;
  const wall = Date.now();
  for (let i = 0; i < n; i += 1) {
    c = (Math.imul(c, 1664525) + 1013904223) >>> 0; // LCG mix on counter
    t = (t * 1.0000001 + i + (wall & 0xff)) % 1e12;
    // Mix bits without relying solely on Math.random quality
    const mixed =
      (c ^ (wall >>> ((i * 3) % 24)) ^ ((t | 0) << (i % 8))) & 0xff;
    // Light extra scramble (not CSPRNG; uniqueness for nonces)
    arr[i] = mixed ^ ((i * 37 + (c & 0xff)) & 0xff);
  }
  // Optional: sprinkle real Math.random only as one of several entropy inputs
  for (let i = 0; i < n; i += 1) {
    arr[i] ^= (Math.random() * 256) & 0xff;
  }
  return _bytesToHex(arr);
}

/** Unix seconds for X-Request-Ts (replay window on server). */
export function requestTimestampSec() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Build secure API request headers (version, integrity, anti-replay).
 * @param {{ token?: string, method?: string, integrity?: string, appVersion?: string }} opts
 */
export function buildSecureHeaders({
  token,
  method = 'GET',
  integrity = 'unknown',
  appVersion = '0',
  deviceName = '',
} = {}) {
  const methodU = String(method || 'GET').toUpperCase();
  const headers = {
    Accept: 'application/json',
    'User-Agent': `CommanderPRO/${appVersion} (Expo; ReactNative; ${Platform.OS})`,
    'X-App-Version': String(appVersion).slice(0, 32),
    'X-App-Platform':
      Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'unknown',
    'X-Device-Integrity': String(integrity || 'unknown').slice(0, 120),
    'X-Device-Name': String(
      deviceName || Device.modelName || Device.deviceName || Device.modelId || ''
    ).slice(0, 48),
    'X-Request-Ts': String(requestTimestampSec()),
    'X-Client': IS_EXPO_GO ? 'expo-go' : 'standalone',
  };

  // Mutating requests get a nonce (never throw — always produce a header)
  if (methodU !== 'GET' && methodU !== 'HEAD' && methodU !== 'OPTIONS') {
    try {
      headers['X-Request-Nonce'] = randomNonceHex(12);
    } catch {
      // Absolute last ditch so login/logout never hard-crash the app
      headers['X-Request-Nonce'] = `${Date.now().toString(16)}${(
        randomNonceHex._c = (randomNonceHex._c || 0) + 1
      ).toString(16)}`.padEnd(24, '0').slice(0, 24);
    }
  }

  if (token) {
    // Server accepts raw hex session token (not Bearer) — keep format stable
    const t = String(token).trim();
    if (t) headers.Authorization = t.startsWith('Bearer ') ? t.slice(7).trim() : t;
  }

  return headers;
}

/**
 * Validate API base URL for this build. Production standalone → HTTPS only.
 */
export function enforceApiUrlSecurity(apiUrl, { isExpoGo = IS_EXPO_GO } = {}) {
  const check = assertSecureApiUrl(apiUrl);
  if (check.ok) return { ok: true, url: apiUrl, ...check };
  if (isExpoGo) {
    // Expo Go may hit LAN http during dev — allow but flag
    return { ok: true, url: apiUrl, warn: check.reason || 'insecure_http', ...check };
  }
  return { ok: false, url: null, ...check };
}

/** Redact secrets from strings before Alert / logs. */
export function redactSecrets(text) {
  let s = String(text || '');
  s = s.replace(/[0-9a-fA-F]{32,128}/g, '[token]');
  s = s.replace(/Bearer\s+\S+/gi, 'Bearer [token]');
  s = s.replace(/password["']?\s*[:=]\s*["']?[^"'\s,}]+/gi, 'password:[redacted]');
  return s.slice(0, 400);
}

/** True if response looks like a JSON API error object (not HTML). */
export function isJsonContentType(contentType) {
  const ct = String(contentType || '').toLowerCase();
  return !ct || ct.includes('json') || ct.includes('text/plain');
}

/**
 * Cache policy: which kinds may be written to disk (never tokens / passwords).
 */
export const CACHE_KIND_SAFE = new Set([
  'status',
  'stats',
  'users',
  'playlist',
  'notify',
  'app_users',
  'streams',
  // security is OWNER-only summary — short TTL only, no secrets
  'security',
]);

export function isCacheKindSafe(kind) {
  return CACHE_KIND_SAFE.has(String(kind || ''));
}
