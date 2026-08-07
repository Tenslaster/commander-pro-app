/**
 * Best-effort device integrity checks for rooted Android / jailbroken iOS.
 * Not bulletproof (nothing is on a rooted device) — raises friction + signals API.
 */
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';

const EXPECTED_ANDROID_PKG = 'com.commanderpro.radios';
const EXPECTED_IOS_BUNDLE = 'com.commanderpro.radios';

/**
 * Compact integrity token sent as X-Device-Integrity (server stores on session).
 * Format: ok|risk|reasons — never includes secrets.
 */
export function integrityHeaderValue(assessment) {
  if (!assessment || typeof assessment !== 'object') return 'unknown';
  const risk = assessment.compromised
    ? 'high'
    : !assessment.isDevice
      ? 'medium'
      : assessment.ok
        ? 'ok'
        : 'medium';
  const reasons = Array.isArray(assessment.reasons)
    ? assessment.reasons.slice(0, 6).join(',')
    : '';
  return `${risk}:${reasons || 'none'}`.slice(0, 120);
}

/**
 * @returns {Promise<{ ok: boolean, compromised: boolean, reasons: string[], packageOk: boolean }>}
 */
export async function assessDeviceIntegrity() {
  const reasons = [];
  let compromised = false;

  // Package / bundle id check (standalone only meaningful)
  let packageOk = true;
  const execEnv = Constants.executionEnvironment; // storeClient | standalone | bare
  const isStandalone =
    execEnv === 'standalone' || execEnv === 'bare' || execEnv === undefined;

  if (isStandalone && (Platform.OS === 'ios' || Platform.OS === 'android')) {
    const isIos = Platform.OS === 'ios';
    const expected = isIos ? EXPECTED_IOS_BUNDLE : EXPECTED_ANDROID_PKG;
    const id = isIos
      ? Constants.expoConfig?.ios?.bundleIdentifier || ''
      : Constants.expoConfig?.android?.package || '';
    if (id && id !== expected) {
      packageOk = false;
      compromised = true;
      reasons.push(isIos ? 'unexpected_bundle' : 'unexpected_package');
    }
  }

  // Emulator / simulator is not root by itself but riskier for stolen tokens
  if (!Device.isDevice) {
    reasons.push('emulator_or_simulator');
  }

  // Debuggable / dev flag inside a "production" standalone is suspicious
  if (typeof __DEV__ !== 'undefined' && __DEV__ && isStandalone) {
    reasons.push('dev_flag_in_standalone');
    compromised = true;
  }

  // Expo Go is fine for testing but weaker isolation than APK/IPA
  if (execEnv === 'storeClient' || Constants.appOwnership === 'expo') {
    reasons.push('expo_go');
  }

  return {
    ok: packageOk && !compromised,
    compromised,
    reasons,
    packageOk,
    isDevice: !!Device.isDevice,
    platform: Platform.OS,
    brand: Device.brand || '',
    modelName: Device.modelName || '',
    header: '', // filled below
  };
}

/** Run assess + attach compact header string. */
export async function assessDeviceIntegrityFull() {
  const a = await assessDeviceIntegrity();
  a.header = integrityHeaderValue(a);
  return a;
}

/** Reject cleartext API in production standalone builds. */
export function assertSecureApiUrl(apiUrl) {
  const u = String(apiUrl || '').trim();
  if (!u) return { ok: false, reason: 'missing_api_url' };
  // Block credentials embedded in URL
  if (/^https?:\/\/[^/]+:[^@/]+@/i.test(u)) {
    return { ok: false, reason: 'url_embedded_credentials' };
  }
  if (u.startsWith('https://')) {
    // Block obvious private IPs over https still ok for internal, but flag
    try {
      const host = u.replace(/^https:\/\//i, '').split('/')[0].split(':')[0];
      if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/i.test(host)) {
        return { ok: true, reason: 'local_https' };
      }
    } catch {
      /* ignore */
    }
    return { ok: true };
  }
  // Allow local dev only (Expo LAN)
  if (
    /^http:\/\/(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/i.test(
      u
    )
  ) {
    return { ok: true, reason: 'local_http' };
  }
  return { ok: false, reason: 'insecure_http' };
}
