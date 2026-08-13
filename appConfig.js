/**
 * Single production origin + version.
 * Every baked URL (API, downloads, Icecast fallback) comes from here.
 * Do not add a second public host.
 */
export const PUBLIC_ORIGIN = 'https://kingdom.lifestyle';
export const DEFAULT_API_URL = `${PUBLIC_ORIGIN}/api`;
export const DEFAULT_DOWNLOAD_URL = `${PUBLIC_ORIGIN}/downloads`;

/** Must match app.json expo.version — hardcoded so JS-repack cannot inherit a stale native value. */
export const APP_VERSION = '1.5.7';

export const OLD_PUBLIC_HOSTS = ['crew.kingdom.forum'];

/** Rewrite leftover old-host / cleartext Icecast URLs onto the current origin. */
const LOCAL_HOST_RE =
  /^(https?:\/\/)?(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/i;

export function rewritePublicUrl(url) {
  let out = String(url || '').trim();
  if (!out) return out;
  out = out.replace(/\s+/g, '');
  if (!LOCAL_HOST_RE.test(out)) {
    out = out.replace(/^http:\/\//i, 'https://');
    out = out.replace(/:8000(?=\/|$)/, '');
  }
  for (let i = 0; i < OLD_PUBLIC_HOSTS.length; i += 1) {
    const host = OLD_PUBLIC_HOSTS[i];
    if (out.toLowerCase().includes(host)) {
      out = out.replace(
        new RegExp(`https?://(?:www\\.)?${host.replace(/\./g, '\\.')}`, 'i'),
        PUBLIC_ORIGIN
      );
    }
  }
  return out.replace(/\/+$/, '') || out;
}
