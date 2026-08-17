/**
 * Single production origin + version.
 * Every baked URL (API, downloads, Icecast fallback) comes from here.
 * Do not add a second public host.
 */
export const PUBLIC_ORIGIN = 'https://kingdom.lifestyle';
export const DEFAULT_API_URL = `${PUBLIC_ORIGIN}/api`;
export const DEFAULT_DOWNLOAD_URL = `${PUBLIC_ORIGIN}/downloads`;

/** Must match app.json expo.version — hardcoded so JS-repack cannot inherit a stale native value. */
export const APP_VERSION = '1.5.12';

const LOCAL_HOST_RE =
  /^(https?:\/\/)?(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/i;
const HTTP_RE = /^http:\/\//i;
const PORT8000_RE = /:8000(?=\/|$)/;
const TRAIL_SLASH_RE = /\/+$/;
const WS_RE = /\s+/g;

/** Normalize public URLs: HTTPS + no leftover :8000 Icecast port. */
export function rewritePublicUrl(url) {
  let out = String(url || '').trim();
  if (!out) return out;
  if (out.indexOf(' ') !== -1 || out.indexOf('\t') !== -1) out = out.replace(WS_RE, '');
  if (!LOCAL_HOST_RE.test(out)) {
    if (HTTP_RE.test(out)) out = `https://${out.slice(7)}`;
    if (out.indexOf(':8000') !== -1) out = out.replace(PORT8000_RE, '');
  }
  if (out.length > 8 && out.charCodeAt(out.length - 1) === 47) {
    out = out.replace(TRAIL_SLASH_RE, '') || out;
  }
  return out;
}
