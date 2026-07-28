/**
 * Commander PRO — client security helpers
 *
 * Goals:
 *  - HTTPS-only API in production (no cleartext MITM)
 *  - Request timestamps + nonces for mutating calls (replay friction)
 *  - Safe headers (no secrets in logs)
 *  - Never put tokens into AsyncStorage cache
 */

import { Platform } from 'react-native';
import * as Device from 'expo-device';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { assertSecureApiUrl } from './deviceSecurity';

const IS_EXPO_GO =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient ||
  Constants.appOwnership === 'expo';

/** Cryptographically strong enough for request nonces (not for passwords). */
export function randomNonceHex(bytes = 12) {
  const n = Math.max(8, Math.min(32, bytes | 0));
  // Prefer WebCrypto when available (Hermes / modern RN)
  try {
    if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
      const arr = new Uint8Array(n);
      globalThis.crypto.getRandomValues(arr);
      return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    /* fall through */
  }
  let out = '';
  for (let i = 0; i < n; i += 1) {
    out += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0');
  }
  return out;
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
    'X-App-Platform': Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'unknown',
    'X-Device-Integrity': String(integrity || 'unknown').slice(0, 120),
    'X-Device-Name': String(
      deviceName || Device.modelName || Device.deviceName || Device.modelId || ''
    ).slice(0, 48),
    'X-Request-Ts': String(requestTimestampSec()),
    'X-Client': IS_EXPO_GO ? 'expo-go' : 'standalone',
  };

  // Mutating requests get a nonce (server can log / future strict replay DB)
  if (methodU !== 'GET' && methodU !== 'HEAD' && methodU !== 'OPTIONS') {
    headers['X-Request-Nonce'] = randomNonceHex(12);
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
