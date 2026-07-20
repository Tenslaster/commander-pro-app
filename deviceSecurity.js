/**
 * Best-effort device integrity checks for rooted Android / jailbroken iOS.
 * Not bulletproof (nothing is on a rooted device) — raises friction + warns admins.
 */
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';

const EXPECTED_ANDROID_PKG = 'com.commanderpro.radios';
const EXPECTED_IOS_BUNDLE = 'com.commanderpro.radios';

/**
 * @returns {Promise<{ ok: boolean, compromised: boolean, reasons: string[], packageOk: boolean }>}
 */
export async function assessDeviceIntegrity() {
  const reasons = [];
  let compromised = false;

  const pkg =
    Constants.expoConfig?.android?.package ||
    Constants.expoConfig?.ios?.bundleIdentifier ||
    Constants.easConfig?.projectId ||
    '';

  // Package / bundle id check (standalone only meaningful)
  let packageOk = true;
  const execEnv = Constants.executionEnvironment; // storeClient | standalone | bare
  const isStandalone =
    execEnv === 'standalone' || execEnv === 'bare' || execEnv === undefined;

  if (isStandalone && Platform.OS === 'android') {
    const id =
      Constants.expoConfig?.android?.package ||
      // nativeApplicationVersion path not package
      '';
    if (id && id !== EXPECTED_ANDROID_PKG) {
      packageOk = false;
      compromised = true;
      reasons.push('unexpected_package');
    }
  }
  if (isStandalone && Platform.OS === 'ios') {
    const id = Constants.expoConfig?.ios?.bundleIdentifier || '';
    if (id && id !== EXPECTED_IOS_BUNDLE) {
      packageOk = false;
      compromised = true;
      reasons.push('unexpected_bundle');
    }
  }

  // Emulator / simulator is not a root by itself but riskier for stolen tokens
  if (!Device.isDevice) {
    reasons.push('emulator_or_simulator');
  }

  // Heuristic: rooted/jailbroken tooling leaves fingerprints some sandboxes still expose
  // (works only when FS access is allowed; never throw)
  if (Platform.OS === 'android') {
    const androidHints = [
      '/system/app/Superuser.apk',
      '/system/xbin/su',
      '/system/bin/su',
      '/sbin/su',
      '/data/local/xbin/su',
      '/data/local/bin/su',
    ];
    // We cannot reliably open these from Expo sandbox; flag debuggable builds instead
    if (typeof __DEV__ !== 'undefined' && __DEV__ && isStandalone) {
      // shouldn't happen for production APK
      reasons.push('dev_flag_in_standalone');
    }
    // Magisk / test-keys often set ro.build.tags — not readable without native module
    void androidHints;
  }

  if (Platform.OS === 'ios') {
    // Cydia / substrate paths are not readable from sandbox either
    // Flag: if app is sideloaded enterprise without expected team — skip
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
  };
}

/** Reject cleartext API in production standalone builds. */
export function assertSecureApiUrl(apiUrl) {
  const u = String(apiUrl || '');
  if (!u) return { ok: false, reason: 'missing_api_url' };
  if (u.startsWith('https://')) return { ok: true };
  // Allow local dev only
  if (
    /^http:\/\/(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/i.test(
      u
    )
  ) {
    return { ok: true, reason: 'local_http' };
  }
  return { ok: false, reason: 'insecure_http' };
}
