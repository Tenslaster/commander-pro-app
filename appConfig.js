/**
 * Single production origin + version.
 * Every baked URL (API, downloads, Icecast fallback) comes from here.
 * Do not add a second public host.
 */
export const PUBLIC_ORIGIN = 'https://kingdom.lifestyle';
export const DEFAULT_API_URL = `${PUBLIC_ORIGIN}/api`;
export const DEFAULT_DOWNLOAD_URL = `${PUBLIC_ORIGIN}/downloads`;

/** Must match app.json expo.version — hardcoded so JS-repack cannot inherit a stale native value. */
export const APP_VERSION = '1.5.11';

export const OLD_PUBLIC_HOSTS = ['crew.kingdom.forum'];

const LOCAL_HOST_RE =
  /^(https?:\/\/)?(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/i;
const HTTP_RE = /^http:\/\//i;
const PORT8000_RE = /:8000(?=\/|$)/;
const TRAIL_SLASH_RE = /\/+$/;
const WS_RE = /\s+/g;
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const OLD_HOST_RES = OLD_PUBLIC_HOSTS.map(
  (h) => new RegExp(`https?://(?:www\\.)?${escapeRegex(h)}`, 'i')
);

/** Rewrite leftover old-host / cleartext Icecast URLs onto the current origin. */
export function rewritePublicUrl(url) {
  let out = String(url || '').trim();
  if (!out) return out;
  if (out.indexOf(' ') !== -1 || out.indexOf('\t') !== -1) out = out.replace(WS_RE, '');
  if (!LOCAL_HOST_RE.test(out)) {
    if (HTTP_RE.test(out)) out = `https://${out.slice(7)}`;
    if (out.indexOf(':8000') !== -1) out = out.replace(PORT8000_RE, '');
  }
  for (let i = 0; i < OLD_HOST_RES.length; i += 1) {
    if (OLD_HOST_RES[i].test(out)) out = out.replace(OLD_HOST_RES[i], PUBLIC_ORIGIN);
  }
  if (out.length > 8 && out.charCodeAt(out.length - 1) === 47) {
    out = out.replace(TRAIL_SLASH_RE, '') || out;
  }
  return out;
}
