import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  SectionList,
  RefreshControl,
  StatusBar,
  Alert,
  Vibration,
  TextInput,
  LayoutAnimation,
  UIManager,
  Platform,
  Modal,
  FlatList,
  KeyboardAvoidingView,
  ActivityIndicator,
  ScrollView,
  Switch,
  useWindowDimensions,
  Image,
  Pressable,
  AppState,
  Keyboard,
  Linking,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Notifications from 'expo-notifications';
import * as LocalAuthentication from 'expo-local-authentication';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import * as ImagePicker from 'expo-image-picker';
import { LANG_KEY, createT, normalizeLang } from './i18n';

/**
 * Expo Go (store client) — remote push was removed from Expo Go in SDK 53+.
 * We still use the in-app alerts feed; only skip getExpoPushToken / remote push.
 */
const IS_EXPO_GO =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient ||
  Constants.appOwnership === 'expo';

// Local / foreground notification presentation (safe in Expo Go)
try {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
} catch {
  /* ignore */
}

/** Android 8+ local channel (not remote FCM — that needs a dev/prod build) */
if (Platform.OS === 'android' && !IS_EXPO_GO) {
  Notifications.setNotificationChannelAsync('default', {
    name: 'Commander PRO',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#38bdf8',
    sound: 'default',
    enableVibrate: true,
  }).catch(() => {
    /* ignore */
  });
}

// Production default baked in so EAS APK/IPA work even when .env is gitignored.
// Override locally with EXPO_PUBLIC_API_URL in .env if needed.
const DEFAULT_API_URL = 'https://crew.kingdom.forum/api';
const API_URL = (process.env.EXPO_PUBLIC_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
/** Base host without trailing /api — used for /api/chat/media/... images */
const API_ORIGIN = API_URL.replace(/\/api\/?$/i, '');

/** App store / build version — must stay >= API min_app_version (see app_version_policy.json) */
const APP_VERSION =
  Constants.expoConfig?.version ||
  Constants.nativeAppVersion ||
  Constants.manifest?.version ||
  '1.1.0';
const APP_PLATFORM = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'unknown';
const DEFAULT_DOWNLOAD_URL = 'https://crew.kingdom.forum/downloads';

/** Compare semver-ish strings: returns -1 / 0 / 1 */
function compareAppVersions(a, b) {
  const parse = (v) => {
    const s = String(v || '0')
      .split(/[+-]/)[0]
      .trim();
    const parts = s.split('.').map((p) => {
      const m = String(p).match(/^(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    });
    while (parts.length < 3) parts.push(0);
    return parts.slice(0, 3);
  };
  const aa = parse(a);
  const bb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (aa[i] < bb[i]) return -1;
    if (aa[i] > bb[i]) return 1;
  }
  return 0;
}

function isAppVersionBlocked(clientVersion, minVersion) {
  if (!minVersion) return false;
  return compareAppVersions(clientVersion || '0.0.0', minVersion) < 0;
}

const mediaUrl = (path) => {
  if (!path) return null;
  // Keep local / already-absolute URIs as-is (optimistic chat images use file:// or content://)
  if (/^(https?:|file:|content:|data:|ph:|assets-library:|blob:)/i.test(path)) return path;
  if (path.startsWith('/')) return `${API_ORIGIN}${path}`;
  return `${API_ORIGIN}/${path}`;
};

const SESSION_TOKEN_KEY = 'session_token';
const SESSION_ROLE_KEY = 'session_role';
const SESSION_USER_KEY = 'session_username';
const SESSION_LEVEL_KEY = 'session_level';
const SESSION_PERMS_KEY = 'session_permissions';
const SESSION_MASTER_KEY = 'session_is_master';
const BIOMETRIC_KEY = 'biometric_enabled';
/** Granular app-login permissions (not Highrise ranks) */
const APP_PERM_KEYS = [
  'status',
  'control',
  'bot_config',
  'logs',
  'chat',
  'chat_send',
  'alerts',
  'users',
  'users_edit',
  'manage_users',
  'playlist',
];
const APP_LEVELS = ['viewer', 'operator', 'admin'];
const APP_LEVEL_PRESETS = {
  viewer: ['status', 'alerts', 'chat', 'chat_send'],
  operator: [
    'status',
    'alerts',
    'chat',
    'chat_send',
    'control',
    'logs',
    'bot_config',
    'playlist',
  ],
  admin: [...APP_PERM_KEYS],
};
const POLL_PLAYLIST_MS = 4000;
const ALERTS_KEY = 'status_alerts_enabled';
const NOTIFY_READ_TS_KEY = 'notify_last_read_ts';
/** Old large feed cache — SecureStore max ~2048 bytes; we only delete this key now */
const ALERTS_CACHE_KEY_LEGACY = 'alerts_feed_cache_v1';
const CHAT_READ_PREFIX = 'chat_read_';

/** Poll intervals — faster on the active tab, slower in background tabs */
const POLL_STATUS_MS = 3000;
const POLL_STATUS_IDLE_MS = 9000;
const POLL_LOGS_MS = 2000;
const POLL_ADMIN_MS = 10000;
const POLL_NOTIFY_MS = 4000;
const POLL_NOTIFY_IDLE_MS = 14000;
const POLL_CHAT_MS = 2000;
const POLL_CHAT_LIST_MS = 4000;
const POLL_CHAT_LIST_IDLE_MS = 16000;
const COMMAND_REFRESH_MS = 1000;
const LOG_REFRESH_AFTER_CMD_MS = 500;
const SEARCH_DEBOUNCE_MS = 160;
const USERS_SEARCH_DEBOUNCE_MS = 280;

// --- Platform best practices (iOS Human Interface + Android Material) ---
const IS_IOS = Platform.OS === 'ios';
const IS_ANDROID = Platform.OS === 'android';
/** SecureStore: device-bound session (not iCloud-migrated / not shared) */
const SECURE_OPTS = IS_IOS
  ? {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }
  : undefined;
/** Minimum comfortable touch target (~44pt Apple HIG / 48dp Material) */
const HIT_SLOP_SM = { top: 8, bottom: 8, left: 8, right: 8 };
const HIT_SLOP_MD = { top: 12, bottom: 12, left: 12, right: 12 };
/** KeyboardAvoidingView for modals (login, sheets) — chat uses explicit keyboard height */
const KAV_BEHAVIOR = IS_IOS ? 'padding' : 'height';
const KAV_OFFSET_MODAL = IS_IOS ? 24 : 0;
/** Dark theme inputs look correct in system keyboard */
const INPUT_KEYBOARD_APPEARANCE = 'dark';
/** Cap runaway Dynamic Type / font scale that can break dense admin UI */
const MAX_FONT_MULT = 1.35;
const lightVibrate = () => {
  try {
    if (IS_IOS) Vibration.vibrate(10);
    else Vibration.vibrate(30);
  } catch {
    /* ignore */
  }
};
const warnVibrate = () => {
  try {
    if (IS_IOS) Vibration.vibrate(40);
    else Vibration.vibrate([0, 40, 40, 40]);
  } catch {
    /* ignore */
  }
};

/** Shared TextInput props — consistent iOS + Android dark keyboard UX */
const darkInputProps = {
  keyboardAppearance: INPUT_KEYBOARD_APPEARANCE,
  placeholderTextColor: '#64748b',
  underlineColorAndroid: 'transparent',
  autoCorrect: false,
  maxFontSizeMultiplier: MAX_FONT_MULT,
  // Avoid iOS password-manager / Android autofill fighting system passwords
  importantForAutofill: 'no',
};

/** Shared list props for RN lists on both platforms */
const platformListExtras = {
  keyboardShouldPersistTaps: 'handled',
  keyboardDismissMode: IS_IOS ? 'interactive' : 'on-drag',
  // Android: avoid glow / overscroll fighting nested scroll parents
  ...(IS_ANDROID
    ? {
        overScrollMode: 'never',
        nestedScrollEnabled: true,
      }
    : {
        alwaysBounceVertical: true,
      }),
};

const ROLE_COLORS = {
  OWNER: '#c084fc',
  RADIO1: '#38bdf8',
  RADIO2: '#34d399',
  RADIO3: '#fbbf24',
  RADIO4: '#f472b6',
  RADIO5: '#fb923c',
};

const NOTIFY_AUDIENCES = ['ALL', 'OWNER', 'RADIO1', 'RADIO2', 'RADIO3', 'RADIO4', 'RADIO5'];
const STATION_IDS = ['RADIO1', 'RADIO2', 'RADIO3', 'RADIO4', 'RADIO5'];
const USER_RANKS = ['guest', 'vip', 'superior', 'mod', 'admin', 'owner', 'dev'];
const OWNER_ONLY_RANKS = new Set(['owner', 'dev']);
const RADIO_ADMIN_RANKS = ['guest', 'vip', 'superior', 'mod', 'admin'];
const USER_LIST_FILTER_DEFS = [
  { id: 'all', labelKey: 'filter.all', color: '#38bdf8' },
  { id: 'ranks', labelKey: 'users.filter.ranks', color: '#a78bfa' },
  { id: 'banned', labelKey: 'users.filter.banned', color: '#f87171' },
  { id: 'vip', labelKey: 'VIP', color: '#fbbf24' },
  { id: 'mod', labelKey: 'Mod', color: '#34d399' },
  { id: 'owner', labelKey: 'Owner', color: '#c084fc' },
];
const RANK_LABELS_FR = {
  guest: 'Invité',
  vip: 'VIP',
  superior: 'Superior',
  mod: 'Modo',
  admin: 'Admin',
  owner: 'Owner',
  dev: 'Dev',
};
const RANK_LEVELS = {
  guest: 0,
  vip: 1,
  superior: 1,
  mod: 2,
  admin: 3,
  owner: 4,
  dev: 5,
};
const STATUS_FILTER_IDS = ['ALL', 'RUNNING', 'STOPPED', 'BOTS', 'MAINS'];

const rankColor = (rank) => {
  const r = (rank || 'guest').toLowerCase();
  if (r === 'dev') return '#f472b6';
  if (r === 'owner') return '#c084fc';
  if (r === 'admin') return '#60a5fa';
  if (r === 'mod') return '#34d399';
  if (r === 'vip' || r === 'superior') return '#fbbf24';
  return '#64748b';
};

const NOTIFY_CHAT_FILTER_DEFS = [
  { id: 'ALL', labelKey: 'filter.type.all', color: '#38bdf8' },
  { id: 'alert', labelKey: 'filter.type.alert', color: '#f87171' },
  { id: 'tip', labelKey: 'filter.type.tip', color: '#fbbf24' },
  { id: 'song', labelKey: 'filter.type.song', color: '#a78bfa' },
  { id: 'status', labelKey: 'filter.type.status', color: '#34d399' },
  { id: 'admin', labelKey: 'filter.type.admin', color: '#c084fc' },
  { id: 'system', labelKey: 'filter.type.system', color: '#94a3b8' },
  { id: 'log', labelKey: 'filter.type.log', color: '#60a5fa' },
];

const NOTIFY_PRESETS = [
  { title: '🛠️ Maintenance', body: 'Maintenance en cours. Merci de patienter.' },
  { title: '⚠️ Alerte système', body: 'Incident détecté — intervention en cours.' },
  { title: '✅ Système OK', body: 'Tous les services sont rétablis.' },
  { title: '🔄 Redémarrage', body: 'Redémarrage planifié dans quelques minutes.' },
  { title: '📢 Annonce', body: "Message important de l'administrateur." },
];

const notifyTypeMeta = (type, tFn) => {
  const t = (type || 'system').toLowerCase();
  const L = typeof tFn === 'function' ? tFn : (k) => k;
  if (t === 'alert') return { icon: 'warning', color: '#f87171', label: L('notify.alert') };
  if (t === 'status') return { icon: 'pulse', color: '#34d399', label: L('notify.status') };
  if (t === 'admin') return { icon: 'megaphone', color: '#c084fc', label: L('notify.admin') };
  if (t === 'tip') return { icon: 'cash', color: '#fbbf24', label: L('notify.tip') };
  if (t === 'song') return { icon: 'musical-notes', color: '#a78bfa', label: L('notify.song') };
  if (t === 'log') return { icon: 'document-text', color: '#60a5fa', label: L('notify.log') };
  return { icon: 'information-circle', color: '#94a3b8', label: L('notify.system') };
};

/** Extract track name from song alert body (not gold balance **5**, not generic title). */
const extractSongNameFromBody = (body) => {
  const text = String(body || '');
  // "queued **Track Name**" / "requested **Track**" (preferred)
  const m = text.match(
    /(?:queued|requested|added|playing|now\s+playing|started\s+playing)(?:\s+(?:to\s+)?(?:front|queue))?\s*[:\-]?\s*\*\*([^*]+)\*\*/i
  );
  if (m?.[1]?.trim()) return m[1].replace(/\s+/g, ' ').trim();

  // Longest non-numeric bold segment (skip VIP Play / balance numbers)
  const skip = new Set(['vip play', 'song', 'chanson', 'tip', 'unlimited', 'free']);
  const bolds = [...text.matchAll(/\*\*([^*]+)\*\*/g)].map((x) => x[1].replace(/\s+/g, ' ').trim());
  const candidates = bolds.filter((s) => s && !/^\d+$/.test(s) && !skip.has(s.toLowerCase()));
  if (candidates.length) {
    return candidates.reduce((a, b) => (b.length > a.length ? b : a));
  }
  return '';
};

const isGenericSongTitle = (title) =>
  /^(?:🎵\s*)?(?:song|chanson)(?:\s*[·•|\-]\s*RADIO[1-5])?$/i.test(String(title || '').trim());

/** Prefer unique song title from body (ingest often sends generic "Song · RADIO1"). */
const formatNotifyDisplay = (item) => {
  const type = (item?.type || '').toLowerCase();
  const title = (item?.title || '').trim();
  const body = (item?.body || '').trim();
  if (type === 'song') {
    let songName = extractSongNameFromBody(body);
    // Title already is the track name (new bridge) — use it when body parse fails
    if (!songName && title && !isGenericSongTitle(title)) {
      songName = title.replace(/^🎵\s*/, '').replace(/\s*[·•]\s*RADIO[1-5]\s*$/i, '').trim();
    }
    if (!songName) songName = (body.split('\n')[0] || title || 'Chanson').slice(0, 90);
    const station =
      item.station ||
      (title.match(/RADIO[1-5]/i) || [])[0] ||
      '';
    return {
      headline: songName,
      detail: body && body !== songName ? body : null,
      stationLabel: station ? String(station).replace(/^radio/i, 'R') : null,
    };
  }
  if (type === 'tip' && body) {
    return {
      headline: title || 'Tip',
      detail: body,
      stationLabel: item.station
        ? String(item.station).replace(/^radio/i, 'R')
        : null,
    };
  }
  return {
    headline: title || 'Notification',
    detail: body,
    stationLabel: item?.station
      ? String(item.station).replace(/^radio/i, 'R')
      : null,
  };
};

/** Bottom tab bar height (approx) — chat composer must sit above it */
const BOTTOM_NAV_HEIGHT = 58;

const formatNotifyWhen = (ts) => {
  if (!ts) return '—';
  try {
    const d = new Date(ts * 1000);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
};

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const animateLayout = () => {
  try {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
  } catch {
    /* ignore layout animation failures */
  }
};

/** True when process rows are identical for UI purposes (skip setState). */
const processRowEqual = (a, b) =>
  !!a &&
  !!b &&
  a.id === b.id &&
  a.status === b.status &&
  a.pid === b.pid &&
  a.name === b.name &&
  a.auto_restart === b.auto_restart &&
  a.is_bot === b.is_bot &&
  a.room_id === b.room_id &&
  a.api_key_masked === b.api_key_masked &&
  a.api_key_tail === b.api_key_tail;

const processListEqual = (prev, next) => {
  if (prev === next) return true;
  if (!prev || !next || prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i += 1) {
    if (!processRowEqual(prev[i], next[i])) return false;
  }
  return true;
};

/** Reuse previous row objects when unchanged → React.memo ProcessCard stays cold. */
const mergeProcessList = (prev, next) => {
  if (!prev?.length) return next;
  if (processListEqual(prev, next)) return prev;
  const prevById = new Map(prev.map((p) => [p.id, p]));
  return next.map((row) => {
    const old = prevById.get(row.id);
    return old && processRowEqual(old, row) ? old : row;
  });
};

const formatUptime = (sec) => {
  if (sec == null || Number.isNaN(Number(sec))) return '—';
  const s = Math.max(0, Math.floor(Number(sec)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
};

const formatTime = (ts) => {
  if (!ts) return '—';
  try {
    return new Date(ts * 1000).toLocaleTimeString();
  } catch {
    return '—';
  }
};

async function apiFetch(path, { method = 'GET', token, body, signal, timeoutMs } = {}) {
  if (!API_URL) {
    const err = new Error('API_URL manquant (EXPO_PUBLIC_API_URL).');
    err.code = 'CONFIG';
    throw err;
  }

  const headers = {
    Accept: 'application/json',
    // Cloudflare blocks some empty / bot signatures without a UA
    'User-Agent': `CommanderPRO/${APP_VERSION} (Expo; ReactNative; ${APP_PLATFORM})`,
    'X-App-Version': String(APP_VERSION),
    'X-App-Platform': APP_PLATFORM,
  };
  if (token) headers.Authorization = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  // Optional timeout (login uses this so the button never stays stuck forever)
  let timeoutId = null;
  let abortCtrl = null;
  let combinedSignal = signal;
  let onParentAbort = null;
  if (timeoutMs && timeoutMs > 0) {
    abortCtrl = new AbortController();
    timeoutId = setTimeout(() => {
      try {
        abortCtrl.abort();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) abortCtrl.abort();
      else {
        onParentAbort = () => {
          try {
            abortCtrl.abort();
          } catch {
            /* ignore */
          }
        };
        signal.addEventListener('abort', onParentAbort, { once: true });
      }
    }
    combinedSignal = abortCtrl.signal;
  }

  const clearFetchGuards = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (signal && onParentAbort) {
      try {
        signal.removeEventListener('abort', onParentAbort);
      } catch {
        /* ignore */
      }
      onParentAbort = null;
    }
  };

  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: combinedSignal,
    });
  } catch (networkErr) {
    clearFetchGuards();
    if (
      networkErr?.name === 'AbortError' ||
      combinedSignal?.aborted ||
      String(networkErr?.message || '').toLowerCase().includes('abort')
    ) {
      if (timeoutMs && abortCtrl?.signal?.aborted && !signal?.aborted) {
        const err = new Error('Délai dépassé — serveur injoignable');
        err.code = 'TIMEOUT';
        throw err;
      }
      const err = new Error('Annulé');
      err.code = 'ABORT';
      err.name = 'AbortError';
      throw err;
    }
    const err = new Error('Serveur injoignable');
    err.code = 'NETWORK';
    err.cause = networkErr;
    throw err;
  }
  clearFetchGuards();

  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Cloudflare HTML / non-JSON error pages
      if (/cloudflare|error code:\s*10\d{2}/i.test(text) || response.status === 403) {
        const err = new Error('Accès bloqué (Cloudflare / réseau). Réessayez.');
        err.code = 'NETWORK';
        err.status = response.status;
        throw err;
      }
      parsed = text;
    }
  }

  const serverMsg =
    parsed && typeof parsed === 'object' && parsed.error
      ? String(parsed.error)
      : '';

  // Login 401 = wrong password; later 401 = expired session
  if (response.status === 401) {
    const err = new Error(serverMsg || 'Session expirée');
    err.code = 'UNAUTHORIZED';
    err.serverError = serverMsg || null;
    throw err;
  }
  if (response.status === 403) {
    const err = new Error(serverMsg || 'Action non autorisée');
    err.code = 'FORBIDDEN';
    throw err;
  }
  if (response.status === 429) {
    const err = new Error(serverMsg || 'Trop de tentatives');
    err.code = 'RATE_LIMIT';
    throw err;
  }
  // 426 Upgrade Required — server forces a newer APK/IPA
  if (
    response.status === 426 ||
    (parsed && typeof parsed === 'object' && parsed.code === 'FORCE_UPDATE')
  ) {
    const err = new Error(
      (parsed && (parsed.message_fr || parsed.message_en || parsed.error)) ||
        'Mise à jour requise'
    );
    err.code = 'FORCE_UPDATE';
    err.status = response.status;
    err.forceUpdate = true;
    err.policy = parsed && typeof parsed === 'object' ? parsed : null;
    throw err;
  }

  if (!response.ok) {
    const err = new Error(serverMsg || `Erreur (${response.status})`);
    err.code = 'HTTP';
    err.status = response.status;
    err.serverError = serverMsg || null;
    throw err;
  }

  return parsed;
}

/** Full-screen gate when API requires a newer app build */
function ForceUpdateScreen({ policy, lang, t }) {
  const downloadUrl =
    (policy && policy.download_url) || DEFAULT_DOWNLOAD_URL;
  const msg =
    lang === 'en'
      ? policy?.message_en ||
        t('update.body') ||
        'This app version is no longer supported. Please download the update.'
      : policy?.message_fr ||
        t('update.body') ||
        "Cette version n'est plus supportée. Téléchargez la mise à jour.";
  const minV = policy?.min_app_version || '—';
  const latestV = policy?.latest_app_version || minV;

  return (
    <View style={styles.forceUpdateScreen}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
      <Ionicons name="cloud-download-outline" size={56} color="#f97316" />
      <Text style={styles.forceUpdateTitle}>{t('update.title') || 'Mise à jour requise'}</Text>
      <Text style={styles.forceUpdateBody}>{msg}</Text>
      <Text style={styles.forceUpdateMeta}>
        {t('update.yourVersion') || 'Votre version'}: {APP_VERSION}
        {'  ·  '}
        {t('update.required') || 'Requis'}: {minV}
        {latestV && latestV !== minV ? `  ·  ${t('update.latest') || 'Dernière'}: ${latestV}` : ''}
      </Text>
      <TouchableOpacity
        style={styles.forceUpdateBtn}
        onPress={() => {
          Linking.openURL(downloadUrl).catch(() => {
            Alert.alert(
              t('update.title') || 'Mise à jour',
              downloadUrl
            );
          });
        }}
      >
        <Text style={styles.forceUpdateBtnText}>
          {t('update.download') || 'Télécharger'}
        </Text>
      </TouchableOpacity>
      <Text style={styles.forceUpdateHint} selectable>
        {downloadUrl}
      </Text>
    </View>
  );
}

// --- SUB-COMPONENTS ---

const Chip = React.memo(({ label, active, onPress, color = '#38bdf8' }) => (
  <Pressable
    onPress={onPress}
    style={({ pressed }) => [
      styles.chip,
      active && { backgroundColor: `${color}33`, borderColor: color },
      pressed && { opacity: 0.75 },
    ]}
    hitSlop={HIT_SLOP_SM}
    android_ripple={{ color: `${color}33`, borderless: false }}
    accessibilityRole="button"
    accessibilityState={{ selected: !!active }}
  >
    <Text
      style={[styles.chipText, active && { color }]}
      numberOfLines={1}
      maxFontSizeMultiplier={MAX_FONT_MULT}
    >
      {label}
    </Text>
  </Pressable>
));

const NotifyChatBubble = React.memo(
  ({ item, unread, canDelete, onDelete, t }) => {
    const meta = notifyTypeMeta(item.type, t);
    const display = formatNotifyDisplay(item);
    const isSong = (item?.type || '').toLowerCase() === 'song';
    return (
      <Pressable
        onLongPress={canDelete ? onDelete : undefined}
        delayLongPress={280}
        style={[
          styles.notifyBubble,
          unread && styles.notifyBubbleUnread,
          { borderLeftColor: meta.color },
        ]}
      >
        <View style={styles.notifyBubbleTop}>
          <View style={[styles.notifyTypePill, { backgroundColor: `${meta.color}22` }]}>
            <Ionicons name={meta.icon} size={12} color={meta.color} />
            <Text style={[styles.notifyTypePillText, { color: meta.color }]}>{meta.label}</Text>
          </View>
          <View style={styles.notifyTopRight}>
            <Text style={styles.notifyWhen}>{formatNotifyWhen(item.ts)}</Text>
            {canDelete ? (
              <TouchableOpacity
                onPress={onDelete}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                style={styles.notifyDeleteBtn}
                accessibilityLabel="Supprimer alerte"
              >
                <Ionicons name="trash" size={15} color="#fff" />
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
        <Text style={styles.notifyTitle} numberOfLines={isSong ? 2 : 3}>
          {display.headline}
        </Text>
        {display.detail && display.detail !== display.headline ? (
          <Text style={styles.notifyBody} selectable numberOfLines={isSong ? 4 : 8}>
            {display.detail}
          </Text>
        ) : null}
        <View style={styles.notifyMetaRow}>
          {display.stationLabel ? (
            <Text style={styles.notifyMeta}>📻 {display.stationLabel}</Text>
          ) : item.station ? (
            <Text style={styles.notifyMeta}>📻 {item.station}</Text>
          ) : null}
          {item.source ? <Text style={styles.notifyMeta}>via {item.source}</Text> : null}
          {item.audience ? <Text style={styles.notifyMeta}>→ {item.audience}</Text> : null}
        </View>
      </Pressable>
    );
  },
  (a, b) =>
    a.unread === b.unread &&
    a.canDelete === b.canDelete &&
    a.t === b.t &&
    a.onDelete === b.onDelete &&
    a.item?.id === b.item?.id &&
    a.item?.title === b.item?.title &&
    a.item?.body === b.item?.body &&
    a.item?.ts === b.item?.ts &&
    a.item?.type === b.item?.type
);

/** Speaker label: prefer app username (tens), not station role (RADIO4). */
const chatSpeakerKey = (msg) => {
  if (!msg) return '';
  return String(msg.from_user || msg.display_name || msg.from || '').trim().toLowerCase();
};

const chatRoleLabel = (msg) => {
  const dn = String(msg?.display_name || '').trim();
  const fu = String(msg?.from_user || '').trim();
  // App login name first
  if (dn && !/^(OWNER|RADIO[1-5])$/i.test(dn)) return dn;
  if (fu && !/^(OWNER|RADIO[1-5])$/i.test(fu)) return fu;
  if (dn) return dn;
  if (fu) return fu;
  return String(msg?.from || 'User').trim() || 'User';
};

const chatAvatarColor = (msg) => {
  const role = String(msg?.from || '').toUpperCase();
  if (ROLE_COLORS[role]) return ROLE_COLORS[role];
  // Stable color from username
  const s = chatSpeakerKey(msg) || 'x';
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const palette = ['#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#f472b6', '#fb923c', '#60a5fa'];
  return palette[h % palette.length];
};

const ChatMsgBubble = React.memo(({ msg, isMine, showSender, onLongPress, t }) => {
  const tr = typeof t === 'function' ? t : (k) => k;
  const color = chatAvatarColor(msg);
  if (msg.deleted) {
    return (
      <View style={[styles.chatMsgRow, isMine && styles.chatMsgRowMine]}>
        <View style={[styles.chatBubble, styles.chatBubbleDeleted]}>
          <Text style={styles.chatDeletedText}>{tr('chat.deleted')}</Text>
          <Text style={styles.chatMsgTime}>{formatNotifyWhen(msg.ts)}</Text>
        </View>
      </View>
    );
  }
  const img = mediaUrl(msg.image);
  const label = chatRoleLabel(msg);
  const initial = (label || '?').slice(0, 1).toUpperCase();
  const seen = !!msg.seen || (Array.isArray(msg.seen_by) && msg.seen_by.length > 0);
  const seenNames = Array.isArray(msg.seen_by)
    ? msg.seen_by.filter((r) => r && r !== msg.from)
    : [];
  let receiptLabel = tr('chat.sent');
  if (seen) {
    receiptLabel =
      seenNames.length > 0 && seenNames.length <= 3
        ? tr('chat.seenBy', { names: seenNames.join(', ') })
        : tr('chat.seen');
  }
  return (
    <View style={[styles.chatMsgRow, isMine && styles.chatMsgRowMine]}>
      {!isMine && showSender ? (
        <View style={[styles.chatAvatar, { backgroundColor: `${color}33`, borderColor: color }]}>
          <Text style={[styles.chatAvatarText, { color }]}>{initial}</Text>
        </View>
      ) : !isMine ? (
        <View style={styles.chatAvatarSpacer} />
      ) : null}
      <Pressable
        onLongPress={onLongPress}
        delayLongPress={280}
        style={[
          styles.chatBubble,
          isMine ? styles.chatBubbleMine : styles.chatBubbleOther,
          !isMine && { borderColor: `${color}55` },
        ]}
      >
        {showSender && !isMine ? (
          <Text style={[styles.chatSender, { color }]} numberOfLines={1}>
            {label}
          </Text>
        ) : null}
        {img ? (
          <Image source={{ uri: img }} style={styles.chatImage} resizeMode="cover" />
        ) : null}
        {msg.text ? (
          <Text style={[styles.chatMsgText, isMine && styles.chatMsgTextMine]} selectable>
            {msg.text}
          </Text>
        ) : null}
        <View style={[styles.chatMetaRow, isMine && styles.chatMetaRowMine]}>
          <Text style={[styles.chatMsgTime, isMine && styles.chatMsgTimeMine]}>
            {msg.edited ? `${tr('chat.edited')} · ` : ''}
            {formatNotifyWhen(msg.ts)}
          </Text>
          {isMine ? (
            <View style={styles.chatReceipt}>
              <Ionicons
                name={seen ? 'checkmark-done' : 'checkmark'}
                size={14}
                color={seen ? '#bfdbfe' : 'rgba(255,255,255,0.7)'}
              />
              <Text
                style={[styles.chatReceiptText, seen && styles.chatReceiptTextSeen]}
                numberOfLines={1}
              >
                {receiptLabel}
              </Text>
            </View>
          ) : null}
        </View>
      </Pressable>
    </View>
  );
});

const ChannelRow = React.memo(({ channel, onPress, t }) => {
  const isPublic = channel.type === 'public' || channel.id === 'public';
  const last = channel.last_message;
  const tr = typeof t === 'function' ? t : (k) => k;
  let preview = tr('chat.noMessages');
  if (last) {
    // Prefer app username (Tens) over station role (RADIO4)
    const who = chatRoleLabel(last);
    const fromBit = who ? `${who}: ` : '';
    const textBit =
      last.text ||
      (last.image || last.deleted
        ? last.deleted
          ? tr('chat.deleted')
          : tr('chat.photo')
        : '');
    preview = `${fromBit}${textBit}`.trim() || preview;
  }
  return (
    <TouchableOpacity style={styles.channelRow} onPress={onPress} activeOpacity={0.75}>
      <View
        style={[
          styles.channelIconWrap,
          { backgroundColor: isPublic ? 'rgba(56,189,248,0.15)' : 'rgba(192,132,252,0.15)' },
        ]}
      >
        <Ionicons
          name={isPublic ? 'globe' : 'lock-closed'}
          size={20}
          color={isPublic ? '#38bdf8' : '#c084fc'}
        />
      </View>
      <View style={styles.channelBody}>
        <View style={styles.channelTitleRow}>
          <Text style={styles.channelName} numberOfLines={1}>
            {channel.name}
          </Text>
          {last?.ts ? (
            <Text style={styles.channelTime}>{formatNotifyWhen(last.ts)}</Text>
          ) : null}
        </View>
        <Text style={styles.channelPreview} numberOfLines={1}>
          {preview}
        </Text>
        {channel.subtitle ? (
          <Text style={styles.channelSub} numberOfLines={1}>
            {channel.subtitle}
          </Text>
        ) : null}
      </View>
      {channel.unread > 0 ? (
        <View style={styles.channelBadge}>
          <Text style={styles.channelBadgeText}>
            {channel.unread > 99 ? '99+' : String(channel.unread)}
          </Text>
        </View>
      ) : (
        <Ionicons name="chevron-forward" size={16} color="#475569" />
      )}
    </TouchableOpacity>
  );
});

const LockScreen = ({
  usernameInput,
  setUsernameInput,
  passwordInput,
  setPasswordInput,
  loginError,
  loginErrorMsg,
  handleLogin,
  isLoggingIn,
  showBiometric,
  onBiometric,
  lang,
  onChangeLang,
  t,
}) => {
  const insets = useSafeAreaInsets();
  const tr = typeof t === 'function' ? t : (k) => k;
  return (
    <View style={[styles.lockScreen, { paddingBottom: Math.max(insets.bottom, 16) + 12 }]}>
      <StatusBar
        barStyle="light-content"
        backgroundColor="#000000"
        translucent={IS_ANDROID}
      />

      {/* Language toggle — top of login, always visible on launch */}
      <View style={[styles.langToggleWrap, { top: insets.top + 12 }]} pointerEvents="box-none">
        <Text style={styles.langToggleLabel}>{tr('login.lang')}</Text>
        <View style={styles.langToggleRow}>
          <TouchableOpacity
            style={[styles.langChip, lang === 'fr' && styles.langChipActive]}
            onPress={() => onChangeLang?.('fr')}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityState={{ selected: lang === 'fr' }}
            accessibilityLabel={tr('login.langFr')}
          >
            <Text style={[styles.langChipText, lang === 'fr' && styles.langChipTextActive]}>
              FR
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.langChip, lang === 'en' && styles.langChipActive]}
            onPress={() => onChangeLang?.('en')}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityState={{ selected: lang === 'en' }}
            accessibilityLabel={tr('login.langEn')}
          >
            <Text style={[styles.langChipText, lang === 'en' && styles.langChipTextActive]}>
              EN
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.lockBody}>
        <Ionicons
          name="lock-closed"
          size={56}
          color={loginError ? '#ef4444' : '#38bdf8'}
          style={{ marginBottom: 16 }}
        />
        <Text style={styles.lockTitle}>{tr('login.title')}</Text>

        <View style={styles.inputContainer}>
          <TextInput
            style={styles.passwordInput}
            placeholder={tr('login.username')}
            {...darkInputProps}
            value={usernameInput}
            onChangeText={setUsernameInput}
            autoCapitalize="none"
            editable={!isLoggingIn}
            returnKeyType="next"
            textContentType="username"
            autoComplete="username"
            importantForAutofill="yes"
          />
        </View>

        <View style={styles.inputContainer}>
          <TextInput
            style={styles.passwordInput}
            placeholder={tr('login.password')}
            {...darkInputProps}
            secureTextEntry
            value={passwordInput}
            onChangeText={setPasswordInput}
            onSubmitEditing={handleLogin}
            autoCapitalize="none"
            editable={!isLoggingIn}
            returnKeyType="go"
            textContentType="password"
            autoComplete="password"
            importantForAutofill="yes"
            enablesReturnKeyAutomatically
          />
        </View>

        {loginError ? (
          <Text style={styles.errorText}>{loginErrorMsg || tr('login.error')}</Text>
        ) : null}

        <TouchableOpacity
          style={[styles.loginBtn, isLoggingIn && styles.loginBtnDisabled]}
          onPress={handleLogin}
          disabled={isLoggingIn}
          activeOpacity={0.85}
        >
          {isLoggingIn ? (
            <ActivityIndicator color="#000000" />
          ) : (
            <>
              <Text style={styles.loginBtnText}>{tr('login.button')}</Text>
              <Ionicons name="arrow-forward" size={18} color="#000000" style={{ marginLeft: 8 }} />
            </>
          )}
        </TouchableOpacity>

        {showBiometric ? (
          <TouchableOpacity style={styles.bioBtn} onPress={onBiometric} activeOpacity={0.8}>
            <Ionicons name="finger-print" size={22} color="#38bdf8" />
            <Text style={styles.bioBtnText}>{tr('login.bio')}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
};

const isBotProcess = (item) =>
  !!(
    item?.is_bot ||
    /_BOT$/i.test(item?.id || '') ||
    /highrise/i.test(item?.name || '')
  );

/** Action buttons are OUTSIDE the card press target so taps never open terminal by mistake. */
const ProcessCard = React.memo(
  ({
    item,
    onOpenTerminal,
    onSendCommand,
    onLongPress,
    onEditRoom,
    onEditApiKey,
    t,
    allowControl = true,
    allowLogs = true,
    allowBotConfig = true,
  }) => {
    const tr = typeof t === 'function' ? t : (k) => k;
    const isRunning = item.status === 'RUNNING';
    const isError = item.status === 'ERROR';
    // ERROR / STOPPED → can start; RUNNING / ERROR → can restart; RUNNING only → kill
    const canStart = allowControl && !isRunning;
    const canKill = allowControl && isRunning;
    const canRestart = allowControl && (isRunning || isError);
    const isBot = isBotProcess(item);
    const roomId = item.room_id || '';
    const keyMask = item.api_key_masked || (item.api_key_tail ? `…${item.api_key_tail}` : '');

    const statusColor = isRunning ? '#34d399' : isError ? '#fb923c' : '#f87171';
    const statusLabel = isRunning
      ? tr('status.online')
      : isError
        ? tr('status.error')
        : tr('status.offline');

    // Solid card bg (no LinearGradient per row) — major win when list re-renders
    const cardBg = isRunning ? '#022c22' : isError ? '#1c1917' : '#09090b';
    const cardBorder = isRunning ? '#065f46' : isError ? '#7c2d12' : '#27272a';

    return (
      <View
        style={[
          styles.card,
          isRunning ? styles.cardRunning : isError ? styles.cardError : styles.cardStopped,
          { backgroundColor: cardBg, borderColor: cardBorder },
        ]}
      >
        <View
          style={[
            styles.glowBar,
            { backgroundColor: isRunning ? '#10b981' : isError ? '#f97316' : '#ef4444' },
          ]}
        />
        <View style={styles.cardContent}>
          <TouchableOpacity
            activeOpacity={0.75}
            onPress={() => (allowLogs ? onOpenTerminal(item) : onLongPress?.(item))}
            onLongPress={() => onLongPress?.(item)}
            delayLongPress={380}
            style={styles.cardInfoPressable}
            disabled={!allowLogs && !onLongPress}
          >
            <View style={styles.cardTitleRow}>
              <Text style={styles.cardTitle} numberOfLines={1}>
                {item.name}
              </Text>
              {item.auto_restart ? (
                <View style={styles.autoBadge}>
                  <Ionicons name="flash" size={10} color="#fbbf24" />
                  <Text style={styles.autoBadgeText}>{tr('status.auto')}</Text>
                </View>
              ) : null}
            </View>
            <View style={styles.statusBadge}>
              <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
              <Text style={[styles.statusText, { color: statusColor }]} numberOfLines={2}>
                {statusLabel}
                {item.pid ? ` · PID ${item.pid}` : ''} · {item.id}
              </Text>
            </View>
            {isBot ? (
              <View style={styles.botConfigPreview}>
                <Text style={styles.botConfigLine} numberOfLines={1}>
                  <Text style={styles.botConfigLabel}>Room </Text>
                  {roomId || '—'}
                </Text>
                <Text style={styles.botConfigLine} numberOfLines={1}>
                  <Text style={styles.botConfigLabel}>Key </Text>
                  {keyMask || '—'}
                </Text>
              </View>
            ) : (
              <Text style={styles.cardHint}>{tr('status.hint')}</Text>
            )}
          </TouchableOpacity>

          {allowControl || (isBot && allowBotConfig) ? (
            <View style={styles.actionRow}>
              {allowControl ? (
                <>
                  <TouchableOpacity
                    style={[
                      styles.iconButton,
                      { backgroundColor: canStart ? '#10b981' : 'rgba(255,255,255,0.06)' },
                    ]}
                    disabled={!canStart}
                    onPress={() => onSendCommand(item.id, 'START')}
                    accessibilityLabel={`${tr('process.start')} ${item.name}`}
                    hitSlop={HIT_SLOP_SM}
                  >
                    <Ionicons name="play" size={20} color={canStart ? '#fff' : '#4b5563'} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.iconButton,
                      { backgroundColor: canKill ? '#ef4444' : 'rgba(255,255,255,0.06)' },
                    ]}
                    disabled={!canKill}
                    onPress={() => onSendCommand(item.id, 'KILL')}
                    accessibilityLabel={`${tr('process.stop')} ${item.name}`}
                    hitSlop={HIT_SLOP_SM}
                  >
                    <Ionicons name="square" size={18} color={canKill ? '#fff' : '#4b5563'} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.iconButton,
                      { backgroundColor: canRestart ? '#0ea5e9' : 'rgba(255,255,255,0.06)' },
                    ]}
                    disabled={!canRestart}
                    onPress={() => onSendCommand(item.id, 'RESTART')}
                    accessibilityLabel={`${tr('process.restart')} ${item.name}`}
                    hitSlop={HIT_SLOP_SM}
                  >
                    <Ionicons name="refresh" size={20} color={canRestart ? '#fff' : '#4b5563'} />
                  </TouchableOpacity>
                </>
              ) : null}
              {isBot && allowBotConfig ? (
                <>
                  <TouchableOpacity
                    style={[styles.iconButton, { backgroundColor: '#a855f7' }]}
                    onPress={() => onEditRoom?.(item)}
                    accessibilityLabel={`${tr('process.room')} ${item.name}`}
                    hitSlop={HIT_SLOP_SM}
                  >
                    <Ionicons name="home" size={18} color="#fff" />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.iconButton, { backgroundColor: '#f59e0b' }]}
                    onPress={() => onEditApiKey?.(item)}
                    accessibilityLabel={`${tr('process.key')} ${item.name}`}
                    hitSlop={HIT_SLOP_SM}
                  >
                    <Ionicons name="key" size={18} color="#fff" />
                  </TouchableOpacity>
                </>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
    );
  },
  (prev, next) =>
    processRowEqual(prev.item, next.item) &&
    prev.t === next.t &&
    prev.allowControl === next.allowControl &&
    prev.allowLogs === next.allowLogs &&
    prev.allowBotConfig === next.allowBotConfig &&
    prev.onOpenTerminal === next.onOpenTerminal &&
    prev.onSendCommand === next.onSendCommand &&
    prev.onLongPress === next.onLongPress &&
    prev.onEditRoom === next.onEditRoom &&
    prev.onEditApiKey === next.onEditApiKey
);

/**
 * Debounced search — keystrokes stay local; parent only updates after debounce.
 * Remount with a new `key` when parent needs a hard clear (logout).
 */
const DebouncedSearchInput = React.memo(
  ({
    placeholder,
    onChangeDebounced,
    debounceMs = SEARCH_DEBOUNCE_MS,
    containerStyle,
    inputStyle,
    iconColor = '#94a3b8',
    iconSize = 18,
  }) => {
    const [local, setLocal] = useState('');
    const timerRef = useRef(null);
    const onChangeDebouncedRef = useRef(onChangeDebounced);
    onChangeDebouncedRef.current = onChangeDebounced;

    useEffect(
      () => () => {
        if (timerRef.current) clearTimeout(timerRef.current);
      },
      []
    );

    const flush = useCallback(
      (text, immediate = false) => {
        if (timerRef.current) clearTimeout(timerRef.current);
        if (immediate) {
          onChangeDebouncedRef.current?.(text);
          return;
        }
        timerRef.current = setTimeout(() => {
          onChangeDebouncedRef.current?.(text);
        }, debounceMs);
      },
      [debounceMs]
    );

    return (
      <View style={containerStyle || styles.searchContainer}>
        <Ionicons
          name="search"
          size={iconSize}
          color={iconColor}
          style={styles.searchIcon}
        />
        <TextInput
          style={inputStyle || styles.searchInput}
          placeholder={placeholder}
          {...darkInputProps}
          value={local}
          onChangeText={(text) => {
            setLocal(text);
            flush(text, false);
          }}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          // iOS built-in clear; Android needs our button
          clearButtonMode="while-editing"
          returnKeyType="search"
          blurOnSubmit={false}
        />
        {local.length > 0 && IS_ANDROID ? (
          <TouchableOpacity
            onPress={() => {
              setLocal('');
              flush('', true);
            }}
            hitSlop={HIT_SLOP_MD}
            accessibilityLabel="Clear search"
            accessibilityRole="button"
          >
            <Ionicons name="close-circle" size={20} color="#94a3b8" />
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }
);

const ProcessSearchBar = React.memo(({ placeholder, onChangeDebounced, debounceMs }) => (
  <DebouncedSearchInput
    placeholder={placeholder}
    onChangeDebounced={onChangeDebounced}
    debounceMs={debounceMs ?? SEARCH_DEBOUNCE_MS}
  />
));

const UserRow = React.memo(
  ({ item, stationFallback, onPress }) => {
    const rank = (item.rank || 'guest').toLowerCase();
    const color = rankColor(rank);
    const st = item.station || stationFallback || '';
    const stColor = ROLE_COLORS[st] || '#64748b';
    return (
      <TouchableOpacity
        style={[styles.userRow, item.banned && styles.userRowBanned]}
        onPress={() => onPress(item)}
        activeOpacity={0.75}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.userRowTop}>
            {st ? (
              <View style={[styles.userStationPill, { borderColor: stColor }]}>
                <Text style={[styles.userStationPillText, { color: stColor }]}>
                  {String(st).replace('RADIO', 'R')}
                </Text>
              </View>
            ) : null}
            <Text style={styles.userRowName} numberOfLines={1}>
              {item.username}
            </Text>
            <View
              style={[styles.userRankPill, { backgroundColor: `${color}22`, borderColor: color }]}
            >
              <Text style={[styles.userRankPillText, { color }]}>
                {(item.rank || 'guest').toUpperCase()}
              </Text>
            </View>
            {item.banned ? (
              <View style={styles.userBanPill}>
                <Text style={styles.userBanPillText}>BAN</Text>
              </View>
            ) : null}
          </View>
          <Text style={styles.userRowMeta} numberOfLines={1}>
            💰 {item.bank ?? 0} · tips {item.gold_tipped ?? 0} · songs{' '}
            {item.songs_played ?? 0} · {item.room_time || '0m'}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color="#475569" />
      </TouchableOpacity>
    );
  },
  (a, b) =>
    a.onPress === b.onPress &&
    a.stationFallback === b.stationFallback &&
    a.item?.id === b.item?.id &&
    a.item?.username === b.item?.username &&
    a.item?.rank === b.item?.rank &&
    a.item?.bank === b.item?.bank &&
    a.item?.banned === b.item?.banned &&
    a.item?.station === b.item?.station &&
    a.item?.songs_played === b.item?.songs_played &&
    a.item?.gold_tipped === b.item?.gold_tipped &&
    a.item?.room_time === b.item?.room_time
);

const BottomNavItem = React.memo(
  ({ active, icon, iconActive, color, label, badge, onPress }) => (
    <Pressable
      style={({ pressed }) => [styles.bottomNavItem, pressed && { opacity: 0.7 }]}
      onPress={onPress}
      android_ripple={{ color: 'rgba(255,255,255,0.08)', borderless: true }}
      accessibilityRole="tab"
      accessibilityState={{ selected: !!active }}
      accessibilityLabel={label}
    >
      <View>
        <Ionicons
          name={active ? iconActive || icon : icon}
          size={22}
          color={active ? color : '#64748b'}
        />
        {badge > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{badge > 99 ? '99+' : String(badge)}</Text>
          </View>
        ) : null}
      </View>
      <Text
        style={[
          styles.bottomNavLabel,
          active && { color },
          active && color === '#38bdf8' && styles.bottomNavLabelActive,
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  )
);

const OwnerActionBtn = React.memo(({ icon, label, color, bg, onPress, disabled }) => (
  <TouchableOpacity
    style={[styles.ownerBarBtn, { backgroundColor: bg }, disabled && { opacity: 0.5 }]}
    onPress={onPress}
    disabled={disabled}
    activeOpacity={0.8}
    accessibilityLabel={label}
  >
    <Ionicons name={icon} size={16} color={color} />
    <Text style={[styles.ownerBarText, { color }]} numberOfLines={1}>
      {label}
    </Text>
  </TouchableOpacity>
));

// --- MAIN APP INNER ---

function AppInner() {
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const compact = windowWidth < 380;

  const [usernameInput, setUsernameInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [loginError, setLoginError] = useState(false);
  const [loginErrorMsg, setLoginErrorMsg] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [userRole, setUserRole] = useState(null);
  const [authToken, setAuthToken] = useState(null);
  const [appUsername, setAppUsername] = useState(null);
  const [appLevel, setAppLevel] = useState(null);
  const [appPermissions, setAppPermissions] = useState([]);
  const [isMasterLogin, setIsMasterLogin] = useState(false);
  const [isReady, setIsReady] = useState(false);
  /** When set, app is blocked until user installs a newer APK/IPA */
  const [forceUpdatePolicy, setForceUpdatePolicy] = useState(null);
  const [biometricGate, setBiometricGate] = useState(false);
  const [biometricHardwareOk, setBiometricHardwareOk] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  /** App UI language — chosen on login screen, persisted */
  const [lang, setLang] = useState('fr');
  const t = useMemo(() => createT(lang), [lang]);

  const [processes, setProcesses] = useState([]);
  /** True after at least one successful /status response this session */
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** Debounced search applied to process list (TextInput state lives in ProcessSearchBar). */
  const [searchQuery, setSearchQuery] = useState('');
  /** Bump to remount ProcessSearchBar (logout / hard clear). */
  const [searchBarKey, setSearchBarKey] = useState(0);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [clearingSessions, setClearingSessions] = useState(false);

  const [connectionOk, setConnectionOk] = useState(true);
  const [latencyMs, setLatencyMs] = useState(null);
  const lastSyncAtRef = useRef(null);
  const lastLatencyRef = useRef(null);
  const [statusAlerts, setStatusAlerts] = useState(true);
  const [banner, setBanner] = useState(null);

  const [terminalVisible, setTerminalVisible] = useState(false);
  const [selectedProcess, setSelectedProcess] = useState(null);
  const [liveLogs, setLiveLogs] = useState([]);
  const [commandInput, setCommandInput] = useState('');
  const [sendingConsole, setSendingConsole] = useState(false);

  // Highrise bot room_id / api_key editor (edits .bat via API)
  const [botConfigModal, setBotConfigModal] = useState(null);
  // { target, name, field: 'room'|'key', current, draft }
  const [botConfigSaving, setBotConfigSaving] = useState(false);

  const [cmdCenterVisible, setCmdCenterVisible] = useState(false);
  const [adminData, setAdminData] = useState(null);
  const [notifyAudience, setNotifyAudience] = useState('ALL');
  const [notifyTitle, setNotifyTitle] = useState('');
  const [notifyBody, setNotifyBody] = useState('');
  const [sendingNotify, setSendingNotify] = useState(false);
  const [actionLog, setActionLog] = useState([]);
  const [adminBusy, setAdminBusy] = useState(false);
  const [chatBroadcastText, setChatBroadcastText] = useState('');
  const [announceTitle, setAnnounceTitle] = useState('');
  const [announceBody, setAnnounceBody] = useState('');

  // System alerts feed (health / crashes / admin)
  const [notifyFeedVisible, setNotifyFeedVisible] = useState(false);
  const [notifyFeed, setNotifyFeed] = useState([]);
  const [notifyFilter, setNotifyFilter] = useState('ALL');
  /** Alerts station scope: ALL = central feed, RADIO1..5 = one radio */
  const [notifyStation, setNotifyStation] = useState('ALL');
  const [notifyUnread, setNotifyUnread] = useState(0);
  const [notifyLastReadTs, setNotifyLastReadTs] = useState(0);
  const [notifyLoading, setNotifyLoading] = useState(false);

  // Real user chat (public + private Owner↔Radio) — Discord replacement
  const [mainTab, setMainTab] = useState('radios'); // radios | users | chat | alerts | manage
  const [chatChannels, setChatChannels] = useState([]);
  const [chatUnreadTotal, setChatUnreadTotal] = useState(0);
  const [activeChat, setActiveChat] = useState(null); // channel meta
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [chatSending, setChatSending] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatTypingUsers, setChatTypingUsers] = useState([]);
  const [chatEditTarget, setChatEditTarget] = useState(null); // { id, text }
  const [pendingImage, setPendingImage] = useState(null); // { uri, base64, type }
  /** Keyboard height — lifts composer so it isn't clipped by the keyboard */
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // Station users / ranks / moderation (!userinfo directory) — SEARCH ONLY (no create)
  const [usersStation, setUsersStation] = useState('RADIO1');
  const [usersList, setUsersList] = useState([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersQuery, setUsersQuery] = useState('');
  const [usersFilter, setUsersFilter] = useState('all');
  const [usersSearchHits, setUsersSearchHits] = useState(null);
  const [usersSearchActiveQuery, setUsersSearchActiveQuery] = useState('');
  const [usersSearching, setUsersSearching] = useState(false);
  const [selectedStationUser, setSelectedStationUser] = useState(null);
  const [userEditRank, setUserEditRank] = useState('guest');
  const [userEditBank, setUserEditBank] = useState('0');
  const [userEditBanned, setUserEditBanned] = useState(false);
  const [userEditSaving, setUserEditSaving] = useState(false);
  // Playlist AutoDJ (RADIO#/playlist folder) — per-station edit
  const [playlistStation, setPlaylistStation] = useState('RADIO1');
  const [playlistSongs, setPlaylistSongs] = useState([]);
  const [playlistLoading, setPlaylistLoading] = useState(false);
  const [playlistQuery, setPlaylistQuery] = useState('');
  const [playlistAdding, setPlaylistAdding] = useState(false);
  const [playlistDownload, setPlaylistDownload] = useState(null); // server download status
  const playlistInflightRef = useRef(false);
  const playlistDlAnnouncedRef = useRef('');

  // Management tab — APP login accounts (not Highrise room users)
  const [appUsersList, setAppUsersList] = useState([]);
  const [appUsersLoading, setAppUsersLoading] = useState(false);
  const [manageUsername, setManageUsername] = useState('');
  const [managePassword, setManagePassword] = useState('');
  const [manageLevel, setManageLevel] = useState('operator');
  const [managePerms, setManagePerms] = useState(() => [...APP_LEVEL_PRESETS.operator]);
  const [manageStation, setManageStation] = useState('RADIO1');
  const [manageCreating, setManageCreating] = useState(false);
  const [manageEditUser, setManageEditUser] = useState(null);
  const [manageEditPerms, setManageEditPerms] = useState([]);
  const [manageEditPassword, setManageEditPassword] = useState('');
  const [manageEditSaving, setManageEditSaving] = useState(false);
  const [manageEditPwdOnly, setManageEditPwdOnly] = useState(false);
  const usersFetchGenRef = useRef(0);
  const usersAbortRef = useRef(null);
  const usersSearchAbortRef = useRef(null);
  const usersSearchGenRef = useRef(0);
  const usersLoadedStationRef = useRef('');

  const flatListRef = useRef(null);
  const notifyListRef = useRef(null);
  const chatListRef = useRef(null);
  const chatStickToBottomRef = useRef(true);
  /** Scroll message list to the latest bubble (iMessage-style stick-to-bottom). */
  const scrollChatToEnd = useCallback((animated = true) => {
    const run = () => {
      try {
        chatListRef.current?.scrollToEnd?.({ animated });
      } catch {
        /* ignore */
      }
    };
    requestAnimationFrame(run);
    setTimeout(run, animated ? 50 : 0);
    if (animated) {
      setTimeout(run, 180);
      setTimeout(run, 360);
    }
  }, []);
  const authTokenRef = useRef(null);
  const userRoleRef = useRef(null);
  const appUsernameRef = useRef(null);
  const mountedRef = useRef(true);
  const prevStatusRef = useRef({});
  const prevStatusReadyRef = useRef(false);
  const pendingSessionRef = useRef(null);
  const statusAlertsRef = useRef(true);
  const bannerTimerRef = useRef(null);
  const commandTimersRef = useRef([]);
  const notifyLastReadRef = useRef(0);
  const notifyFeedVisibleRef = useRef(false);
  const knownNotifyIdsRef = useRef(new Set());
  const activeChatIdRef = useRef(null);
  const mainTabRef = useRef('radios');
  const appStateRef = useRef(AppState.currentState || 'active');
  const netFailCountRef = useRef(0);
  /** Prevent overlapping polls (slow networks) from stacking work */
  const statusInflightRef = useRef(false);
  const notifyInflightRef = useRef(false);
  const chatChannelsInflightRef = useRef(false);
  const [usersSearchBarKey, setUsersSearchBarKey] = useState(0);

  useEffect(() => {
    authTokenRef.current = authToken;
  }, [authToken]);

  useEffect(() => {
    userRoleRef.current = userRole;
  }, [userRole]);

  useEffect(() => {
    appUsernameRef.current = appUsername || userRole;
  }, [appUsername, userRole]);

  useEffect(() => {
    statusAlertsRef.current = statusAlerts;
  }, [statusAlerts]);

  useEffect(() => {
    notifyLastReadRef.current = notifyLastReadTs;
  }, [notifyLastReadTs]);

  useEffect(() => {
    notifyFeedVisibleRef.current = notifyFeedVisible;
  }, [notifyFeedVisible]);

  useEffect(() => {
    activeChatIdRef.current = activeChat?.id || null;
  }, [activeChat?.id]);

  useEffect(() => {
    mainTabRef.current = mainTab;
  }, [mainTab]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
      commandTimersRef.current.forEach(clearTimeout);
      commandTimersRef.current = [];
    };
  }, []);

  const isUnlocked = authToken !== null && !biometricGate;
  const isOwner = userRole === 'OWNER';
  const showBioOnLock = biometricGate && biometricHardwareOk && biometricEnabled;
  const hasPerm = useCallback(
    (perm) => {
      if (isOwner || isMasterLogin) return true;
      return (appPermissions || []).includes(perm);
    },
    [isOwner, isMasterLogin, appPermissions]
  );
  const canManageAppUsers = isOwner || isMasterLogin || hasPerm('manage_users');
  const canControlRadios = isOwner || isMasterLogin || hasPerm('control');
  const canOpenLogs = isOwner || isMasterLogin || hasPerm('logs');
  const canBotConfig = isOwner || isMasterLogin || hasPerm('bot_config');
  const canChat = isOwner || isMasterLogin || hasPerm('chat');
  const canChatSend = isOwner || isMasterLogin || hasPerm('chat_send');
  const canAlerts = isOwner || isMasterLogin || hasPerm('alerts');
  const canUsersTab = isOwner || isMasterLogin || hasPerm('users');
  const canUsersEdit = isOwner || isMasterLogin || hasPerm('users_edit');
  // playlist right, or legacy control (operators already had control before playlist perm)
  const canPlaylist =
    isOwner || isMasterLogin || hasPerm('playlist') || hasPerm('control');

  const applyManagePreset = useCallback((level) => {
    const lv = APP_LEVELS.includes(level) ? level : 'viewer';
    setManageLevel(lv);
    setManagePerms([...(APP_LEVEL_PRESETS[lv] || APP_LEVEL_PRESETS.viewer)]);
  }, []);

  const toggleManagePerm = useCallback((key) => {
    setManagePerms((prev) => {
      const set = new Set(prev);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      const next = APP_PERM_KEYS.filter((k) => set.has(k));
      // Sync preset label if exact match
      let match = 'custom';
      for (const lv of APP_LEVELS) {
        const preset = APP_LEVEL_PRESETS[lv] || [];
        if (
          preset.length === next.length &&
          preset.every((p) => next.includes(p))
        ) {
          match = lv;
          break;
        }
      }
      setManageLevel(match);
      return next;
    });
  }, []);

  const pushActionLog = useCallback((text) => {
    const line = `${new Date().toLocaleTimeString()} — ${text}`;
    setActionLog((prev) => [line, ...prev].slice(0, 40));
  }, []);

  const showBanner = useCallback((text, type = 'info') => {
    setBanner({ text, type });
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    bannerTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setBanner(null);
    }, 4500);
  }, []);

  const scheduleRefresh = useCallback((fn, ms) => {
    const id = setTimeout(() => {
      commandTimersRef.current = commandTimersRef.current.filter((x) => x !== id);
      fn();
    }, ms);
    commandTimersRef.current.push(id);
    return id;
  }, []);

  // --- SESSION ---

  const handleLogout = useCallback(async () => {
    try {
      await SecureStore.deleteItemAsync(SESSION_TOKEN_KEY);
      await SecureStore.deleteItemAsync(SESSION_ROLE_KEY);
      await SecureStore.deleteItemAsync(SESSION_USER_KEY);
      await SecureStore.deleteItemAsync(SESSION_LEVEL_KEY);
      await SecureStore.deleteItemAsync(SESSION_PERMS_KEY);
      await SecureStore.deleteItemAsync(SESSION_MASTER_KEY);
    } catch (e) {
      console.warn('Failed to clear secure session', e);
    }
    if (!mountedRef.current) return;
    setAuthToken(null);
    setUserRole(null);
    setAppUsername(null);
    setAppLevel(null);
    setAppPermissions([]);
    setIsMasterLogin(false);
    setProcesses([]);
    setStatusLoaded(false);
    setSearchQuery('');
    setSearchBarKey((k) => k + 1);
    setUsersQuery('');
    setUsersSearchBarKey((k) => k + 1);
    setUsersSearchHits(null);
    setUsersSearchActiveQuery('');
    setManageUsername('');
    setManagePassword('');
    setManageLevel('operator');
    setManagePerms([...APP_LEVEL_PRESETS.operator]);
    setManageCreating(false);
    setManageEditUser(null);
    setManageEditPerms([]);
    setManageEditPassword('');
    setManageEditPwdOnly(false);
    setManageEditSaving(false);
    setAppUsersList([]);
    setStatusFilter('ALL');
    setTerminalVisible(false);
    setCmdCenterVisible(false);
    setSelectedProcess(null);
    setLiveLogs([]);
    setAdminData(null);
    setBiometricGate(false);
    setBanner(null);
    setNotifyFeedVisible(false);
    setNotifyFeed([]);
    setNotifyUnread(0);
    setNotifyFilter('ALL');
    setNotifyStation('ALL');
    setMainTab('radios');
    setChatChannels([]);
    setChatUnreadTotal(0);
    setActiveChat(null);
    setChatMessages([]);
    setChatInput('');
    setUsersList([]);
    setUsersQuery('');
    setUsersFilter('all');
    setUsersSearchHits(null);
    setUsersSearchActiveQuery('');
    setUsersSearching(false);
    setSelectedStationUser(null);
    setBotConfigModal(null);
    setUserEditSaving(false);
    setBotConfigSaving(false);
    setPlaylistSongs([]);
    setPlaylistQuery('');
    setPlaylistAdding(false);
    setPlaylistDownload(null);
    setPlaylistLoading(false);
    usersFetchGenRef.current += 1;
    usersSearchGenRef.current += 1;
    usersLoadedStationRef.current = '';
    try {
      usersAbortRef.current?.abort?.();
    } catch {
      /* ignore */
    }
    try {
      usersSearchAbortRef.current?.abort?.();
    } catch {
      /* ignore */
    }
    knownNotifyIdsRef.current = new Set();
    pendingSessionRef.current = null;
    prevStatusRef.current = {};
    prevStatusReadyRef.current = false;
  }, []);

  const registerForPushNotificationsAsync = useCallback(async (validToken) => {
    // SDK 53+: remote push is not available in Expo Go — skip quietly
    if (IS_EXPO_GO) return;
    if (!validToken) return;
    try {
      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;
      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }
      if (finalStatus !== 'granted') return;

      const projectId =
        Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
      if (!projectId) {
        console.warn('EAS Project ID missing.');
        return;
      }

      const expoToken = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
      await apiFetch('/register_token', {
        method: 'POST',
        token: validToken,
        body: { token: expoToken },
      });
    } catch (error) {
      if (error.code === 'UNAUTHORIZED') {
        handleLogout();
        return;
      }
      // Don't spam console for unsupported environments
      if (__DEV__) console.warn('Failed to register push token:', error?.message || error);
    }
  }, [handleLogout]);

  const unlockWithSession = useCallback(
    (
      token,
      role,
      {
        registerPush = true,
        username = null,
        level = null,
        permissions = null,
        isMaster = false,
      } = {}
    ) => {
      setAuthToken(token);
      setUserRole(role);
      setAppUsername(username || role);
      setAppLevel(level || (role === 'OWNER' || isMaster ? 'admin' : 'viewer'));
      const perms = Array.isArray(permissions)
        ? permissions
        : role === 'OWNER' || isMaster
          ? ['status', 'alerts', 'chat', 'control', 'users', 'manage_users', 'owner']
          : ['status', 'alerts', 'chat'];
      setAppPermissions(perms);
      setIsMasterLogin(!!isMaster || role === 'OWNER');
      if (role && role !== 'OWNER' && STATION_IDS.includes(role)) {
        setUsersStation(role);
        setManageStation(role);
        setPlaylistStation(role);
      }
      setBiometricGate(false);
      pendingSessionRef.current = null;
      prevStatusReadyRef.current = false;
      if (registerPush) registerForPushNotificationsAsync(token);
    },
    [registerForPushNotificationsAsync]
  );

  const changeLang = useCallback(async (next) => {
    const code = normalizeLang(next);
    setLang(code);
    try {
      await SecureStore.setItemAsync(LANG_KEY, code, SECURE_OPTS);
    } catch {
      /* ignore */
    }
  }, []);

  const tryBiometric = useCallback(async () => {
    const pending = pendingSessionRef.current;
    if (!pending?.token) return false;
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: t('login.bioPrompt'),
        cancelLabel: t('common.cancel'),
        disableDeviceFallback: false,
      });
      if (result.success && mountedRef.current) {
        unlockWithSession(pending.token, pending.role, {
          username: pending.username,
          level: pending.level,
          permissions: pending.permissions,
          isMaster: pending.isMaster,
        });
        return true;
      }
    } catch (e) {
      console.warn('Biometric failed', e);
    }
    return false;
  }, [unlockWithSession, t]);

  const applyForceUpdatePolicy = useCallback((policy) => {
    if (!policy || typeof policy !== 'object') return false;
    const minV = policy.min_app_version || policy.minAppVersion;
    const force =
      policy.force_update !== false &&
      (policy.code === 'FORCE_UPDATE' ||
        policy.force_update === true ||
        !!minV);
    if (!force || !minV) return false;
    if (!isAppVersionBlocked(APP_VERSION, minV)) return false;
    if (mountedRef.current) {
      setForceUpdatePolicy({
        min_app_version: minV,
        latest_app_version: policy.latest_app_version || minV,
        download_url: policy.download_url || DEFAULT_DOWNLOAD_URL,
        message_fr: policy.message_fr || policy.error || '',
        message_en: policy.message_en || policy.error || '',
        api_version: policy.api_version || policy.version,
      });
    }
    return true;
  }, []);

  useEffect(() => {
    async function boot() {
      try {
        // 1) Version gate vs API (must run even if offline → skip, not force)
        try {
          const health = await apiFetch('/health', { timeoutMs: 12000 });
          if (health && applyForceUpdatePolicy(health)) {
            if (mountedRef.current) setIsReady(true);
            return;
          }
        } catch (healthErr) {
          if (healthErr?.code === 'FORCE_UPDATE' && healthErr.policy) {
            applyForceUpdatePolicy(healthErr.policy);
            if (mountedRef.current) setIsReady(true);
            return;
          }
          // Network down: allow offline boot UI; login will re-check
        }

        const [
          hw,
          bioFlag,
          alertFlag,
          storedToken,
          storedRole,
          storedUser,
          storedLevel,
          storedPerms,
          storedMaster,
          readTsRaw,
          storedLang,
        ] = await Promise.all([
          LocalAuthentication.hasHardwareAsync().catch(() => false),
          SecureStore.getItemAsync(BIOMETRIC_KEY),
          SecureStore.getItemAsync(ALERTS_KEY),
          SecureStore.getItemAsync(SESSION_TOKEN_KEY),
          SecureStore.getItemAsync(SESSION_ROLE_KEY),
          SecureStore.getItemAsync(SESSION_USER_KEY),
          SecureStore.getItemAsync(SESSION_LEVEL_KEY),
          SecureStore.getItemAsync(SESSION_PERMS_KEY),
          SecureStore.getItemAsync(SESSION_MASTER_KEY),
          SecureStore.getItemAsync(NOTIFY_READ_TS_KEY),
          SecureStore.getItemAsync(LANG_KEY),
        ]);
        let restoredPerms = [];
        try {
          restoredPerms = storedPerms ? JSON.parse(storedPerms) : [];
        } catch {
          restoredPerms = [];
        }
        const sessionMeta = {
          username: storedUser || storedRole,
          level: storedLevel,
          permissions: Array.isArray(restoredPerms) ? restoredPerms : [],
          isMaster: storedMaster === '1' || storedRole === 'OWNER',
        };
        // Drop oversized legacy feed cache (SecureStore limit ~2048 bytes)
        SecureStore.deleteItemAsync(ALERTS_CACHE_KEY_LEGACY).catch(() => {});
        const langCode = normalizeLang(storedLang || 'fr');
        setLang(langCode);
        const enrolled = hw ? await LocalAuthentication.isEnrolledAsync().catch(() => false) : false;
        // Opt-in: only enabled when user set it to '1'
        const bioOn = bioFlag === '1';
        setBiometricHardwareOk(!!(hw && enrolled));
        setBiometricEnabled(bioOn);
        if (alertFlag === '0') setStatusAlerts(false);
        const readTs = parseFloat(readTsRaw || '0') || 0;
        notifyLastReadRef.current = readTs;
        setNotifyLastReadTs(readTs);

        if (storedToken && storedRole) {
          if (hw && enrolled && bioOn) {
            pendingSessionRef.current = {
              token: storedToken,
              role: storedRole,
              ...sessionMeta,
            };
            setUserRole(storedRole);
            setBiometricGate(true);
            const prompt =
              langCode === 'en' ? 'Unlock Commander PRO' : 'Déverrouiller Commander PRO';
            const cancel =
              langCode === 'en' ? 'Password' : 'Mot de passe';
            setTimeout(() => {
              if (!mountedRef.current || !pendingSessionRef.current) return;
              LocalAuthentication.authenticateAsync({
                promptMessage: prompt,
                cancelLabel: cancel,
              })
                .then((result) => {
                  if (result.success && mountedRef.current && pendingSessionRef.current) {
                    const p = pendingSessionRef.current;
                    unlockWithSession(storedToken, storedRole, {
                      username: p.username,
                      level: p.level,
                      permissions: p.permissions,
                      isMaster: p.isMaster,
                    });
                  }
                })
                .catch(() => {});
            }, 350);
          } else {
            unlockWithSession(storedToken, storedRole, sessionMeta);
          }
        }
      } catch (e) {
        console.error('Boot error', e);
      } finally {
        if (mountedRef.current) setIsReady(true);
      }
    }
    boot();
  }, [unlockWithSession, applyForceUpdatePolicy]);

  const handleLogin = useCallback(async () => {
    setLoginError(false);
    setLoginErrorMsg('');
    const pw = passwordInput.trim();
    const uname = usernameInput.trim();
    if (!pw) {
      setLoginError(true);
      setLoginErrorMsg(t('login.errorEmpty') || 'Entrez le mot de passe');
      return;
    }
    if (isLoggingIn) return;

    if (!API_URL) {
      Alert.alert(t('err.config') || 'Configuration', 'API_URL manquant (EXPO_PUBLIC_API_URL).');
      return;
    }

    setIsLoggingIn(true);
    try {
      const data = await apiFetch('/login', {
        method: 'POST',
        body: { password: pw, username: uname || undefined },
        timeoutMs: 20000,
      });

      if (!data?.token || !data?.role) {
        const err = new Error('Réponse invalide du serveur');
        err.code = 'HTTP';
        throw err;
      }

      if (!mountedRef.current) return;
      unlockWithSession(data.token, data.role, {
        username: data.username || uname || data.role,
        level: data.level,
        permissions: data.permissions,
        isMaster: !!data.is_master,
      });
      setPasswordInput('');
      setUsernameInput('');
      setLoginError(false);
      setLoginErrorMsg('');
      pushActionLog(
        `Connexion ${data.username || data.role} · ${data.role} · ${data.level || 'master'}`
      );

      try {
        await SecureStore.setItemAsync(SESSION_TOKEN_KEY, data.token, SECURE_OPTS);
        await SecureStore.setItemAsync(SESSION_ROLE_KEY, data.role, SECURE_OPTS);
        await SecureStore.setItemAsync(
          SESSION_USER_KEY,
          String(data.username || data.role || ''),
          SECURE_OPTS
        );
        await SecureStore.setItemAsync(
          SESSION_LEVEL_KEY,
          String(data.level || ''),
          SECURE_OPTS
        );
        await SecureStore.setItemAsync(
          SESSION_PERMS_KEY,
          JSON.stringify(data.permissions || []),
          SECURE_OPTS
        );
        await SecureStore.setItemAsync(
          SESSION_MASTER_KEY,
          data.is_master ? '1' : '0',
          SECURE_OPTS
        );
      } catch (storeErr) {
        console.warn('SecureStore session save failed', storeErr);
      }
    } catch (error) {
      warnVibrate();
      if (!mountedRef.current) return;
      if (error.code === 'RATE_LIMIT') {
        setLoginError(true);
        setLoginErrorMsg(t('security.rateLimit'));
        Alert.alert(t('login.title'), t('security.rateLimit'));
      } else if (error.code === 'CONFIG') {
        setLoginError(true);
        setLoginErrorMsg(error.message || t('err.config'));
        Alert.alert('Configuration', error.message || t('err.config'));
      } else if (error.code === 'FORCE_UPDATE') {
        applyForceUpdatePolicy(error.policy || { force_update: true, min_app_version: '999.0.0' });
      } else if (error.code === 'NETWORK' || error.code === 'TIMEOUT') {
        setLoginError(true);
        setLoginErrorMsg(error.message || t('err.server'));
        Alert.alert(t('err.server'), error.message || t('err.server'));
      } else if (error.code === 'UNAUTHORIZED') {
        setLoginError(true);
        setLoginErrorMsg(t('login.error'));
      } else {
        setLoginError(true);
        setLoginErrorMsg(error.message || t('login.error'));
      }
    } finally {
      if (mountedRef.current) setIsLoggingIn(false);
    }
  }, [
    passwordInput,
    usernameInput,
    isLoggingIn,
    unlockWithSession,
    pushActionLog,
    t,
    applyForceUpdatePolicy,
  ]);

  // --- API ---

  const fetchStatus = useCallback(
    async (isManualRefresh = false) => {
      const token = authTokenRef.current;
      if (!token) return;
      // Coalesce background polls — never stack status requests
      if (!isManualRefresh && statusInflightRef.current) return;
      statusInflightRef.current = true;

      const t0 = Date.now();
      try {
        if (isManualRefresh && mountedRef.current) setRefreshing(true);

        const data = await apiFetch('/status', { token, timeoutMs: 12000 });
        if (!data || typeof data !== 'object' || Array.isArray(data) || !mountedRef.current) return;

        const procArray = Object.keys(data)
          .filter((key) => key && typeof key === 'string')
          .map((key) => {
            const row = data[key] && typeof data[key] === 'object' ? data[key] : {};
            const id = String(key);
            const isBot =
              !!row.is_bot ||
              /_BOT$/i.test(id) ||
              /highrise/i.test(String(row.name || ''));
            let status = String(row.status || 'STOPPED').toUpperCase();
            // Normalize rare/legacy status strings so filters & colors work
            if (status === 'ONLINE' || status === 'UP') status = 'RUNNING';
            if (status === 'OFFLINE' || status === 'DOWN' || status === 'DEAD')
              status = 'STOPPED';
            if (status === 'CRASHED' || status === 'FAIL') status = 'ERROR';
            if (!['RUNNING', 'STOPPED', 'ERROR'].includes(status)) status = 'STOPPED';
            return {
              id,
              name: row.name != null && String(row.name).trim() ? String(row.name) : id,
              status,
              pid: row.pid ?? null,
              auto_restart: !!row.auto_restart,
              is_bot: isBot,
              room_id: row.room_id || '',
              api_key_masked: row.api_key_masked || '',
              api_key_tail: row.api_key_tail || '',
            };
          })
          // Stable order so the list doesn't jump every poll
          .sort((a, b) => {
            if (a.is_bot !== b.is_bot) return a.is_bot ? -1 : 1;
            return a.id.localeCompare(b.id, undefined, { sensitivity: 'base' });
          });

        // Skip alerts on first successful snapshot after login
        if (statusAlertsRef.current && prevStatusReadyRef.current) {
          const prev = prevStatusRef.current;
          const drops = [];
          const ups = [];
          procArray.forEach((p) => {
            if (prev[p.id] === 'RUNNING' && p.status !== 'RUNNING') drops.push(p.name);
            else if (prev[p.id] && prev[p.id] !== 'RUNNING' && p.status === 'RUNNING')
              ups.push(p.name);
          });
          if (drops.length === 1) {
            showBanner(`${drops[0]} est hors ligne`, 'warn');
            warnVibrate();
          } else if (drops.length > 1) {
            showBanner(`${drops.length} processus hors ligne`, 'warn');
            warnVibrate();
          } else if (ups.length === 1) {
            showBanner(`${ups[0]} est en ligne`, 'ok');
          } else if (ups.length > 1) {
            showBanner(`${ups.length} processus en ligne`, 'ok');
          }
        }
        prevStatusRef.current = Object.fromEntries(procArray.map((p) => [p.id, p.status]));
        prevStatusReadyRef.current = true;

        if (isManualRefresh) animateLayout();
        // Skip setState when snapshot unchanged — avoids full list re-render every 3s
        setProcesses((prev) => mergeProcessList(prev, procArray));
        setStatusLoaded((prev) => (prev ? prev : true));
        netFailCountRef.current = 0;
        setConnectionOk((prev) => (prev ? prev : true));
        const ms = Date.now() - t0;
        lastSyncAtRef.current = Date.now();
        // Throttle latency header updates (avoid re-render every poll for ±few ms)
        if (
          lastLatencyRef.current == null ||
          Math.abs(lastLatencyRef.current - ms) >= 40 ||
          isManualRefresh
        ) {
          lastLatencyRef.current = ms;
          setLatencyMs(ms);
        }
      } catch (error) {
        if (error.code === 'FORCE_UPDATE') {
          applyForceUpdatePolicy(
            error.policy || { force_update: true, min_app_version: '999.0.0' }
          );
          return;
        }
        if (error.code === 'UNAUTHORIZED') {
          // Only prompt when user is actually looking at the app
          if (appStateRef.current === 'active') {
            Alert.alert('Sécurité', 'Votre session a expiré.');
          }
          handleLogout();
          return;
        }
        // Background / tab-out network blips: never treat as a hard error
        if (appStateRef.current !== 'active') {
          return;
        }
        // Soft offline: only flip UI after a few consecutive failures while foreground
        netFailCountRef.current += 1;
        if (netFailCountRef.current >= 3 || isManualRefresh) {
          setConnectionOk(false);
        }
        // No Alert / no banner for "Serveur injoignable" on polling
      } finally {
        statusInflightRef.current = false;
        if (isManualRefresh && mountedRef.current) setRefreshing(false);
      }
    },
    [handleLogout, showBanner, applyForceUpdatePolicy]
  );

  const fetchAdmin = useCallback(async () => {
    const token = authTokenRef.current;
    if (!token || userRoleRef.current !== 'OWNER') return;
    try {
      const data = await apiFetch('/admin', { token });
      if (mountedRef.current) setAdminData(data);
    } catch (error) {
      if (error.code === 'UNAUTHORIZED') handleLogout();
    }
  }, [handleLogout]);

  const markNotificationsRead = useCallback(async (items) => {
    const latest = items.reduce((max, it) => Math.max(max, Number(it.ts) || 0), 0);
    if (!latest || latest <= notifyLastReadRef.current) return;
    notifyLastReadRef.current = latest;
    setNotifyLastReadTs(latest);
    setNotifyUnread(0);
    try {
      await SecureStore.setItemAsync(NOTIFY_READ_TS_KEY, String(latest));
    } catch {
      /* ignore */
    }
  }, []);

  const fetchNotifications = useCallback(
    async ({ silent = true } = {}) => {
      const token = authTokenRef.current;
      if (!token) return;
      if (silent && notifyInflightRef.current) return;
      notifyInflightRef.current = true;
      if (!silent && mountedRef.current) setNotifyLoading(true);
      try {
        const role = userRoleRef.current || '';
        // Radio logins always use their station filter option + ALL central of what they can see
        let stationParam = notifyStation;
        if (role && role !== 'OWNER' && STATION_IDS.includes(role)) {
          // keep ALL (central = everything this role can see) or force own radio
          if (stationParam !== 'ALL' && stationParam !== role) {
            stationParam = role;
          }
        }
        const typeQ =
          notifyFilter && notifyFilter !== 'ALL'
            ? `&type=${encodeURIComponent(notifyFilter)}`
            : '';
        const stQ =
          stationParam && stationParam !== 'ALL'
            ? `&station=${encodeURIComponent(stationParam)}`
            : '';
        const data = await apiFetch(
          `/notifications?limit=400${typeQ}${stQ}`,
          { token }
        );
        if (!mountedRef.current) return;
        const items = Array.isArray(data?.items) ? data.items : [];
        setNotifyFeed((prev) => {
          if (prev.length === items.length && prev.length > 0) {
            let same = true;
            for (let i = 0; i < prev.length; i++) {
              if (
                prev[i]?.id !== items[i]?.id ||
                prev[i]?.body !== items[i]?.body ||
                prev[i]?.title !== items[i]?.title
              ) {
                same = false;
                break;
              }
            }
            if (same) return prev;
          }
          if (prev.length === 0 && items.length === 0) return prev;
          return items;
        });
        // Alerts permanence is on the server (notification_feed.json) — not SecureStore

        const lastRead = notifyLastReadRef.current || 0;
        const unread = items.filter((it) => Number(it.ts) > lastRead).length;
        // Only auto-mark read when actively on the Alerts tab
        if (mainTabRef.current === 'alerts' || notifyFeedVisibleRef.current) {
          markNotificationsRead(items);
        } else {
          setNotifyUnread((prev) => (prev === unread ? prev : unread));
        }

        // In-app banner for brand-new alerts while app is open
        if (statusAlertsRef.current && knownNotifyIdsRef.current.size > 0) {
          const fresh = items.filter(
            (it) => it.id && !knownNotifyIdsRef.current.has(it.id) && Number(it.ts) > lastRead
          );
          if (fresh.length === 1) {
            showBanner(fresh[0].title || 'Nouvelle notification', 'warn');
            lightVibrate();
          } else if (fresh.length > 1) {
            showBanner(`${fresh.length} nouvelles notifications`, 'warn');
            lightVibrate();
          }
        }
        knownNotifyIdsRef.current = new Set(items.map((it) => it.id).filter(Boolean));
      } catch (error) {
        if (error.code === 'UNAUTHORIZED') {
          handleLogout();
          return;
        }
        if (!silent) console.warn('Fetch notifications failed', error.message);
      } finally {
        notifyInflightRef.current = false;
        if (!silent && mountedRef.current) setNotifyLoading(false);
      }
    },
    [handleLogout, markNotificationsRead, notifyFilter, notifyStation, showBanner]
  );

  const openNotificationFeed = useCallback(() => {
    setMainTab('alerts');
    setNotifyFeedVisible(false);
    fetchNotifications({ silent: false });
  }, [fetchNotifications]);

  const deleteFeedAlert = useCallback(
    (item) => {
      if (!isOwner || !item?.id) return;
      Alert.alert(
        'Supprimer l’alerte',
        `Supprimer « ${item.title || item.type || 'alerte'} » ?\n(Tout type : tip, song, alert…)`,
        [
          { text: 'Annuler', style: 'cancel' },
          {
            text: 'Supprimer',
            style: 'destructive',
            onPress: async () => {
              const token = authTokenRef.current;
              if (!token) return;
              try {
                await apiFetch('/admin/action', {
                  method: 'POST',
                  token,
                  body: { action: 'feed_delete', id: item.id },
                });
                setNotifyFeed((prev) => prev.filter((x) => x.id !== item.id));
                setNotifyUnread((u) => Math.max(0, u - 1));
                pushActionLog(`Alerte supprimée ${item.id}`);
                showBanner('Alerte supprimée', 'ok');
              } catch (error) {
                if (error.code === 'UNAUTHORIZED') handleLogout();
                else Alert.alert('Alertes', error.message || 'Suppression impossible.');
              }
            },
          },
        ]
      );
    },
    [isOwner, handleLogout, pushActionLog, showBanner]
  );

  const clearFeedByType = useCallback(
    (type) => {
      if (!isOwner) return;
      const label = type === 'all' ? 'toutes les alertes' : `toutes les alertes « ${type} »`;
      Alert.alert('Vider le feed', `Supprimer ${label} ?`, [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Supprimer',
          style: 'destructive',
          onPress: async () => {
            const token = authTokenRef.current;
            if (!token) return;
            try {
              const data = await apiFetch('/admin/action', {
                method: 'POST',
                token,
                body:
                  type === 'all'
                    ? { action: 'feed_clear' }
                    : { action: 'feed_delete_type', type },
              });
              pushActionLog(`Feed clear ${type} (${data?.cleared ?? 0})`);
              showBanner(`Feed nettoyé (${data?.cleared ?? 0})`, 'ok');
              fetchNotifications({ silent: false });
              fetchAdmin();
            } catch (error) {
              if (error.code === 'UNAUTHORIZED') handleLogout();
              else Alert.alert('Alertes', error.message || 'Échec.');
            }
          },
        },
      ]);
    },
    [isOwner, fetchNotifications, fetchAdmin, handleLogout, pushActionLog, showBanner]
  );

  // --- CHAT (public + private DMs) ---

  const fetchChatChannels = useCallback(async () => {
    const token = authTokenRef.current;
    if (!token) return;
    if (chatChannelsInflightRef.current) return;
    chatChannelsInflightRef.current = true;
    try {
      const data = await apiFetch('/chat/channels', { token, timeoutMs: 10000 });
      if (!mountedRef.current) return;
      const channels = Array.isArray(data?.channels) ? data.channels : [];
      setChatChannels((prev) => {
        if (
          prev.length === channels.length &&
          prev.every(
            (c, i) =>
              c?.id === channels[i]?.id &&
              c?.unread === channels[i]?.unread &&
              c?.last_preview === channels[i]?.last_preview
          )
        ) {
          return prev;
        }
        return channels;
      });
      const unread = Number(data?.unread_total) || 0;
      setChatUnreadTotal((prev) => (prev === unread ? prev : unread));
    } catch (error) {
      if (error.code === 'UNAUTHORIZED') handleLogout();
    } finally {
      chatChannelsInflightRef.current = false;
    }
  }, [handleLogout]);

  const markChatRead = useCallback(
    async (channelId, ts) => {
      const token = authTokenRef.current;
      if (!token || !channelId) return;
      try {
        await apiFetch('/chat/read', {
          method: 'POST',
          token,
          body: { channel: channelId, ts: ts || undefined },
        });
        fetchChatChannels();
      } catch (error) {
        if (error.code === 'UNAUTHORIZED') handleLogout();
      }
    },
    [fetchChatChannels, handleLogout]
  );

  const fetchChatMessages = useCallback(
    async (channelId, { silent = true } = {}) => {
      const token = authTokenRef.current;
      if (!token || !channelId) return;
      if (!silent && mountedRef.current) setChatLoading(true);
      try {
        const data = await apiFetch(
          `/chat/messages?channel=${encodeURIComponent(channelId)}&limit=120`,
          { token }
        );
        if (!mountedRef.current) return;
        const msgs = Array.isArray(data?.messages) ? data.messages : [];
        // Avoid full list re-render when nothing changed (kills VirtualizedList jank)
        setChatMessages((prev) => {
          if (prev.length === msgs.length) {
            if (prev.length === 0) return prev;
            let same = true;
            for (let i = 0; i < prev.length; i++) {
              const a = prev[i];
              const b = msgs[i];
              const aSeen = Array.isArray(a?.seen_by) ? a.seen_by.join(',') : '';
              const bSeen = Array.isArray(b?.seen_by) ? b.seen_by.join(',') : '';
              if (
                a?.id !== b?.id ||
                a?.text !== b?.text ||
                a?.edited !== b?.edited ||
                a?.deleted !== b?.deleted ||
                a?.image !== b?.image ||
                !!a?.seen !== !!b?.seen ||
                aSeen !== bSeen
              ) {
                same = false;
                break;
              }
            }
            if (same) return prev;
          }
          return msgs;
        });
        if (data?.channel) {
          setActiveChat((prev) =>
            prev?.id === channelId
              ? {
                  ...prev,
                  ...data.channel,
                  peer_read_ts: data.peer_read_ts ?? data.channel.peer_read_ts,
                  reads: data.reads || data.channel.reads,
                }
              : prev || data.channel
          );
        }
        // Mark read for the channel we just loaded (ref may lag one frame after open)
        if (msgs.length && (!activeChatIdRef.current || activeChatIdRef.current === channelId)) {
          const lastTs = msgs[msgs.length - 1]?.ts;
          markChatRead(channelId, lastTs);
        }
        // Open / refresh while pinned to bottom → show final messages
        if (chatStickToBottomRef.current && activeChatIdRef.current === channelId) {
          scrollChatToEnd(!silent);
        }
      } catch (error) {
        if (error.code === 'UNAUTHORIZED') {
          handleLogout();
          return;
        }
        if (!silent) {
          Alert.alert('Chat', error.message || 'Impossible de charger les messages.');
        }
      } finally {
        if (!silent && mountedRef.current) setChatLoading(false);
      }
    },
    [handleLogout, markChatRead, scrollChatToEnd]
  );

  const openChatChannel = useCallback(
    (channel) => {
      if (!channel?.id) return;
      // Set ref immediately so mark-read / typing use the right channel
      activeChatIdRef.current = channel.id;
      chatStickToBottomRef.current = true;
      setActiveChat(channel);
      setChatMessages([]);
      setChatInput('');
      setChatEditTarget(null);
      setPendingImage(null);
      setChatTypingUsers([]);
      fetchChatMessages(channel.id, { silent: false });
      // After history loads, pin to latest (real chat apps always open at bottom)
      setTimeout(() => scrollChatToEnd(false), 120);
      setTimeout(() => scrollChatToEnd(true), 320);
    },
    [fetchChatMessages, scrollChatToEnd]
  );

  const closeChatThread = useCallback(() => {
    activeChatIdRef.current = null;
    setActiveChat(null);
    setChatMessages([]);
    setChatInput('');
    setChatTypingUsers([]);
    setChatEditTarget(null);
    setPendingImage(null);
    fetchChatChannels();
  }, [fetchChatChannels]);

  const sendTypingPing = useCallback(async (typing = true) => {
    const token = authTokenRef.current;
    const channelId = activeChatIdRef.current;
    if (!token || !channelId) return;
    try {
      await apiFetch('/chat/typing', {
        method: 'POST',
        token,
        body: {
          channel: channelId,
          typing: !!typing,
          display_name: appUsernameRef.current || userRoleRef.current,
        },
      });
    } catch {
      /* ignore typing errors */
    }
  }, []);

  const fetchTyping = useCallback(async () => {
    const token = authTokenRef.current;
    const channelId = activeChatIdRef.current;
    if (!token || !channelId) return;
    try {
      const data = await apiFetch(
        `/chat/typing?channel=${encodeURIComponent(channelId)}`,
        { token }
      );
      if (mountedRef.current) {
        setChatTypingUsers(Array.isArray(data?.typing) ? data.typing : []);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const onChatInputChange = useCallback(
    (text) => {
      setChatInput(text);
      if (text.trim()) sendTypingPing(true);
    },
    [sendTypingPing]
  );

  const onChatInputFocus = useCallback(() => {
    // Tap composer → jump to final messages (standard messenger UX)
    chatStickToBottomRef.current = true;
    scrollChatToEnd(true);
  }, [scrollChatToEnd]);

  const isMyChatMessage = useCallback((msg) => {
    if (!msg) return false;
    const me = String(appUsernameRef.current || userRoleRef.current || '')
      .trim()
      .toLowerCase();
    const role = String(userRoleRef.current || '').trim().toLowerCase();
    const fu = String(msg.from_user || '').trim().toLowerCase();
    const dn = String(msg.display_name || '').trim().toLowerCase();
    // Custom app user: match by username (Tens ≠ RADIO4, Tens ≠ other user on same radio)
    if (me && (fu === me || dn === me)) return true;
    // Master password / role login only (username is OWNER or RADIO#)
    if (me && me === role && msg.from === userRoleRef.current) {
      if (!fu && !dn) return true;
      if (fu === role || dn === role) return true;
      if (!fu && /^(owner|radio[1-5])$/i.test(dn || role)) return true;
    }
    return false;
  }, []);

  const pickChatImage = useCallback(async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Photos', "Permission d'accès aux photos refusée.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.7,
        base64: true,
        allowsEditing: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      if (!asset.base64) {
        Alert.alert('Photo', 'Impossible de lire la photo.');
        return;
      }
      const mime = asset.mimeType || 'image/jpeg';
      setPendingImage({
        uri: asset.uri,
        base64: asset.base64,
        type: mime,
      });
    } catch (e) {
      Alert.alert('Photo', e.message || 'Erreur sélection photo.');
    }
  }, []);

  const onMessageLongPress = useCallback(
    (msg) => {
      if (!msg || msg.deleted || msg._local) return;
      // Must match bubble ownership (app username), not only station role —
      // multiple app logins can share RADIO1…RADIO5.
      const isMine = isMyChatMessage(msg);
      const isOwnerUser = userRoleRef.current === 'OWNER';
      if (!isMine && !isOwnerUser) return;

      const buttons = [];
      if (isMine && msg.text) {
        buttons.push({
          text: 'Modifier',
          onPress: () => {
            setChatEditTarget({ id: msg.id, text: msg.text || '' });
            setChatInput(msg.text || '');
            setPendingImage(null);
          },
        });
      }
      if (isMine || isOwnerUser) {
        buttons.push({
          text: 'Supprimer',
          style: 'destructive',
          onPress: () => {
            Alert.alert('Supprimer', 'Supprimer ce message ?', [
              { text: 'Annuler', style: 'cancel' },
              {
                text: 'Supprimer',
                style: 'destructive',
                onPress: async () => {
                  const token = authTokenRef.current;
                  const channelId = activeChatIdRef.current;
                  if (!token || !channelId) return;
                  try {
                    await apiFetch('/chat/delete', {
                      method: 'POST',
                      token,
                      body: { channel: channelId, id: msg.id },
                    });
                    fetchChatMessages(channelId, { silent: true });
                    fetchChatChannels();
                  } catch (error) {
                    if (error.code === 'UNAUTHORIZED') handleLogout();
                    else Alert.alert('Chat', error.message || 'Suppression impossible.');
                  }
                },
              },
            ]);
          },
        });
      }
      buttons.push({ text: 'Annuler', style: 'cancel' });
      const who = chatRoleLabel(msg);
      Alert.alert('Message', isMine ? 'Votre message' : `Message de ${who}`, buttons);
    },
    [fetchChatChannels, fetchChatMessages, handleLogout, isMyChatMessage]
  );

  const sendChatMessage = useCallback(async () => {
    const token = authTokenRef.current;
    const text = chatInput.trim();
    const channelId = activeChat?.id;
    if (!token || !channelId || chatSending) return;
    if (!canChatSend) {
      Alert.alert(t('err.forbidden'), t('manage.noChatSend'));
      return;
    }

    // Edit mode
    if (chatEditTarget?.id) {
      if (!text) {
        Alert.alert('Chat', 'Le message ne peut pas être vide.');
        return;
      }
      setChatSending(true);
      try {
        const data = await apiFetch('/chat/edit', {
          method: 'POST',
          token,
          body: { channel: channelId, id: chatEditTarget.id, text },
        });
        if (data?.message) {
          setChatMessages((prev) =>
            prev.map((m) => (m.id === data.message.id ? data.message : m))
          );
        } else {
          await fetchChatMessages(channelId, { silent: true });
        }
        setChatEditTarget(null);
        setChatInput('');
        sendTypingPing(false);
      } catch (error) {
        if (error.code === 'UNAUTHORIZED') handleLogout();
        else Alert.alert('Chat', error.message || 'Échec modification.');
      } finally {
        if (mountedRef.current) setChatSending(false);
      }
      return;
    }

    if (!text && !pendingImage) return;

    setChatSending(true);
    const myName = appUsernameRef.current || userRoleRef.current || 'me';
    const optimistic = {
      id: `local-${Date.now()}`,
      ts: Date.now() / 1000,
      from: userRoleRef.current,
      from_user: myName,
      display_name: myName,
      text,
      channel: channelId,
      image: pendingImage?.uri || null,
      _local: true,
      seen: false,
    };
    chatStickToBottomRef.current = true;
    setChatMessages((prev) => [...prev, optimistic]);
    const sentText = text;
    const sentImage = pendingImage;
    setChatInput('');
    setPendingImage(null);
    sendTypingPing(false);
    scrollChatToEnd(true);

    try {
      const body = {
        channel: channelId,
        text: sentText,
        display_name: myName,
      };
      if (sentImage?.base64) {
        body.image = sentImage.base64;
        body.image_type = sentImage.type || 'image/jpeg';
      }
      const data = await apiFetch('/chat/send', {
        method: 'POST',
        token,
        body,
      });
      if (data?.message) {
        setChatMessages((prev) => {
          const withoutLocal = prev.filter((m) => m.id !== optimistic.id);
          if (withoutLocal.some((m) => m.id === data.message.id)) return withoutLocal;
          return [...withoutLocal, data.message];
        });
      } else {
        await fetchChatMessages(channelId, { silent: true });
      }
      fetchChatChannels();
      scrollChatToEnd(true);
    } catch (error) {
      setChatMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setChatInput(sentText);
      if (sentImage) setPendingImage(sentImage);
      if (error.code === 'UNAUTHORIZED') {
        handleLogout();
        return;
      }
      Alert.alert('Chat', error.message || "Échec de l'envoi.");
    } finally {
      if (mountedRef.current) setChatSending(false);
    }
  }, [
    activeChat?.id,
    chatEditTarget,
    chatInput,
    chatSending,
    pendingImage,
    fetchChatChannels,
    fetchChatMessages,
    handleLogout,
    sendTypingPing,
    scrollChatToEnd,
    canChatSend,
    t,
  ]);

  const sendCommand = useCallback(
    async (target, command) => {
      const token = authTokenRef.current;
      if (!token) return;
      if (!canControlRadios) {
        Alert.alert(t('err.forbidden'), t('manage.noControl'));
        return;
      }

      lightVibrate();
      // Avoid LayoutAnimation on large lists — feels laggy; optimistic status is enough
      pushActionLog(`${command} → ${target}`);

      setProcesses((prev) =>
        prev.map((p) =>
          target === 'ALL' || p.id === target
            ? { ...p, status: command === 'KILL' ? 'STOPPED' : 'RUNNING' }
            : p
        )
      );

      try {
        await apiFetch('/command', {
          method: 'POST',
          token,
          body: { target, command },
        });
        scheduleRefresh(() => fetchStatus(false), COMMAND_REFRESH_MS);
      } catch (error) {
        if (error.code === 'UNAUTHORIZED') {
          handleLogout();
          return;
        }
        Alert.alert(
          'Erreur',
          error.code === 'FORBIDDEN' ? 'Action non autorisée.' : 'Échec de la commande.'
        );
        fetchStatus(true);
      }
    },
    [fetchStatus, handleLogout, pushActionLog, scheduleRefresh, canControlRadios, t]
  );

  const doGlobalAction = useCallback(
    (action) => {
      const pool =
        action === 'START'
          ? processes.filter((p) => p.status !== 'RUNNING')
          : processes.filter((p) => p.status === 'RUNNING');

      if (pool.length === 0) {
        Alert.alert(
          'Info',
          action === 'START'
            ? 'Aucun processus arrêté à démarrer.'
            : `Aucun processus actif à ${action === 'KILL' ? 'arrêter' : 'redémarrer'}.`
        );
        return;
      }

      const labels = { START: 'Démarrer', KILL: 'Arrêter', RESTART: 'Redémarrer' };
      Alert.alert('Confirmer', `${labels[action]} ${pool.length} processus ?`, [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Confirmer',
          style: action === 'KILL' ? 'destructive' : 'default',
          onPress: () => {
            // Sequential-ish fire; server handles each IPC
            pool.forEach((p) => sendCommand(p.id, action));
          },
        },
      ]);
    },
    [processes, sendCommand]
  );

  /** Active station for Users / Management — radio admins hard-locked to their role. */
  const effectiveUsersStation = useMemo(() => {
    const role = userRole || '';
    if (role && role !== 'OWNER' && STATION_IDS.includes(role)) return role;
    return usersStation;
  }, [userRole, usersStation]);

  /** Active station for Playlist tab — same isolation as Users. */
  const effectivePlaylistStation = useMemo(() => {
    const role = userRole || '';
    if (role && role !== 'OWNER' && STATION_IDS.includes(role)) return role;
    return playlistStation;
  }, [userRole, playlistStation]);

  const switchPlaylistStation = useCallback(
    (st) => {
      if (!isOwner) return;
      if (!STATION_IDS.includes(st) || st === playlistStation) return;
      setPlaylistSongs([]);
      setPlaylistDownload(null);
      setPlaylistQuery('');
      setPlaylistStation(st);
    },
    [isOwner, playlistStation]
  );

  const fetchPlaylist = useCallback(
    async ({ silent = true } = {}) => {
      const token = authTokenRef.current;
      if (!token || !canPlaylist) return;
      if (silent && playlistInflightRef.current) return;
      playlistInflightRef.current = true;
      const role = userRoleRef.current || '';
      const station =
        role === 'OWNER'
          ? playlistStation
          : STATION_IDS.includes(role)
            ? role
            : playlistStation;
      if (!station || !STATION_IDS.includes(station)) {
        playlistInflightRef.current = false;
        return;
      }
      if (!silent && mountedRef.current) setPlaylistLoading(true);
      try {
        const data = await apiFetch(
          `/playlist?station=${encodeURIComponent(station)}`,
          { token, timeoutMs: 15000 }
        );
        if (!mountedRef.current) return;
        const returned = data?.station || station;
        if (role === 'OWNER' && returned !== playlistStation) return;
        setPlaylistSongs(Array.isArray(data?.songs) ? data.songs : []);
        setPlaylistDownload(data?.download || null);
        if (role !== 'OWNER' && returned) setPlaylistStation(returned);
      } catch (error) {
        if (error.code === 'UNAUTHORIZED') {
          handleLogout();
          return;
        }
        if (!silent && appStateRef.current === 'active') {
          Alert.alert(t('playlist.title'), error.message || t('err.generic'));
        }
      } finally {
        playlistInflightRef.current = false;
        if (mountedRef.current && !silent) setPlaylistLoading(false);
      }
    },
    [canPlaylist, playlistStation, handleLogout, t]
  );

  const addPlaylistSong = useCallback(async () => {
    const token = authTokenRef.current;
    if (!token || !canPlaylist || playlistAdding) return;
    const q = playlistQuery.trim();
    if (!q) {
      Alert.alert(t('playlist.add'), t('playlist.needQuery'));
      return;
    }
    if (playlistDownload?.status === 'downloading') {
      Alert.alert(t('playlist.add'), t('playlist.busy'));
      return;
    }
    const station = effectivePlaylistStation;
    if (!STATION_IDS.includes(station)) return;
    setPlaylistAdding(true);
    try {
      const data = await apiFetch('/playlist/add', {
        method: 'POST',
        token,
        body: { station, query: q },
        timeoutMs: 20000,
      });
      if (!mountedRef.current) return;
      setPlaylistQuery('');
      setPlaylistDownload(data?.download || { status: 'downloading', query: q });
      showBanner(t('playlist.downloading'), 'info');
      // Poll until done / error
      scheduleRefresh(() => fetchPlaylist({ silent: true }), 2500);
      scheduleRefresh(() => fetchPlaylist({ silent: true }), 6000);
      scheduleRefresh(() => fetchPlaylist({ silent: true }), 12000);
      scheduleRefresh(() => fetchPlaylist({ silent: true }), 25000);
    } catch (error) {
      if (error.code === 'UNAUTHORIZED') handleLogout();
      else Alert.alert(t('playlist.add'), error.message || t('err.generic'));
    } finally {
      if (mountedRef.current) setPlaylistAdding(false);
    }
  }, [
    canPlaylist,
    playlistAdding,
    playlistQuery,
    playlistDownload,
    effectivePlaylistStation,
    fetchPlaylist,
    handleLogout,
    scheduleRefresh,
    showBanner,
    t,
  ]);

  const deletePlaylistSong = useCallback(
    (song) => {
      if (!song?.name || !canPlaylist) return;
      const station = effectivePlaylistStation;
      Alert.alert(
        t('playlist.deleteTitle'),
        t('playlist.deleteBody', {
          title: song.title || song.name,
          station,
        }),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('common.confirm') || 'OK',
            style: 'destructive',
            onPress: async () => {
              const token = authTokenRef.current;
              if (!token) return;
              try {
                const data = await apiFetch('/playlist/delete', {
                  method: 'POST',
                  token,
                  body: { station, name: song.name },
                });
                if (Array.isArray(data?.songs)) setPlaylistSongs(data.songs);
                else {
                  setPlaylistSongs((prev) =>
                    prev.filter((x) => x.name !== song.name && x.id !== song.id)
                  );
                }
                showBanner(t('playlist.deleted'), 'ok');
                lightVibrate();
              } catch (error) {
                if (error.code === 'UNAUTHORIZED') handleLogout();
                else Alert.alert(t('playlist.title'), error.message || t('err.generic'));
              }
            },
          },
        ]
      );
    },
    [canPlaylist, effectivePlaylistStation, handleLogout, showBanner, t]
  );

  const clearPlaylistAll = useCallback(() => {
    if (!canPlaylist) return;
    const station = effectivePlaylistStation;
    Alert.alert(
      t('playlist.clearTitle'),
      t('playlist.clearBody', { station }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('playlist.clearAll'),
          style: 'destructive',
          onPress: async () => {
            const token = authTokenRef.current;
            if (!token) return;
            try {
              const data = await apiFetch('/playlist/clear', {
                method: 'POST',
                token,
                body: { station },
              });
              setPlaylistSongs([]);
              showBanner(
                t('playlist.cleared', { n: data?.cleared ?? 0 }),
                'ok'
              );
              warnVibrate();
            } catch (error) {
              if (error.code === 'UNAUTHORIZED') handleLogout();
              else Alert.alert(t('playlist.title'), error.message || t('err.generic'));
            }
          },
        },
      ]
    );
  }, [canPlaylist, effectivePlaylistStation, handleLogout, showBanner, t]);

  const switchUsersStation = useCallback(
    (st) => {
      if (!isOwner) return;
      if (!STATION_IDS.includes(st) || st === usersStation) return;
      setSelectedStationUser(null);
      setUsersList([]);
      setUsersSearchHits(null);
      setUsersSearchActiveQuery('');
      usersLoadedStationRef.current = '';
      setUsersQuery('');
      setUsersFilter('all');
      setUsersStation(st);
    },
    [isOwner, usersStation]
  );

  const normalizeUserRow = useCallback((u, station) => {
    const rank = (u.rank || 'guest').toLowerCase();
    return {
      ...u,
      station: u.station || station,
      id: u.id || `${station}:${u.username}`,
      rank,
      rank_level:
        typeof u.rank_level === 'number' ? u.rank_level : RANK_LEVELS[rank] ?? 0,
    };
  }, []);

  /** Browse catalog (no search) — high limit, active + regulars */
  const fetchStationUsers = useCallback(
    async ({ silent = true } = {}) => {
      const token = authTokenRef.current;
      if (!token) return;
      const role = userRoleRef.current || '';
      const station =
        role === 'OWNER'
          ? usersStation
          : STATION_IDS.includes(role)
            ? role
            : usersStation;
      if (!station || !STATION_IDS.includes(station)) return;

      try {
        usersAbortRef.current?.abort?.();
      } catch {
        /* ignore */
      }
      const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      usersAbortRef.current = ac;
      const gen = ++usersFetchGenRef.current;

      if (usersLoadedStationRef.current && usersLoadedStationRef.current !== station) {
        setUsersList([]);
        setUsersSearchHits(null);
      }

      if (!silent && mountedRef.current) setUsersLoading(true);
      try {
        const data = await apiFetch(
          `/users?station=${encodeURIComponent(station)}&filter=all&limit=2000`,
          { token, signal: ac?.signal }
        );
        if (!mountedRef.current || gen !== usersFetchGenRef.current) return;
        const returned = data?.station || station;
        const expected =
          role === 'OWNER'
            ? usersStation
            : STATION_IDS.includes(role)
              ? role
              : usersStation;
        if (returned !== expected) return;

        const list = Array.isArray(data?.users) ? data.users : [];
        setUsersList(list.map((u) => normalizeUserRow(u, returned)));
        usersLoadedStationRef.current = returned;
        if (role !== 'OWNER' && returned) setUsersStation(returned);
      } catch (error) {
        if (error?.name === 'AbortError' || error?.code === 'ABORT') return;
        if (error.code === 'UNAUTHORIZED') {
          handleLogout();
          return;
        }
        if (!silent && appStateRef.current === 'active') {
          Alert.alert('Utilisateurs', error.message || 'Chargement impossible.');
        }
      } finally {
        if (mountedRef.current && gen === usersFetchGenRef.current) {
          setUsersLoading(false);
        }
      }
    },
    [usersStation, handleLogout, normalizeUserRow]
  );

  /** Full-database search (room_time + all maps) */
  const searchStationUsers = useCallback(
    async (rawQuery) => {
      const token = authTokenRef.current;
      const q = String(rawQuery || '')
        .trim()
        .toLowerCase()
        .replace(/^@/, '');
      if (!token || !q) {
        setUsersSearchHits(null);
        setUsersSearchActiveQuery('');
        setUsersSearching(false);
        return;
      }
      const role = userRoleRef.current || '';
      const station =
        role === 'OWNER'
          ? usersStation
          : STATION_IDS.includes(role)
            ? role
            : usersStation;
      if (!station || !STATION_IDS.includes(station)) return;

      try {
        usersSearchAbortRef.current?.abort?.();
      } catch {
        /* ignore */
      }
      const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      usersSearchAbortRef.current = ac;
      const gen = ++usersSearchGenRef.current;
      if (mountedRef.current) setUsersSearching(true);
      try {
        const data = await apiFetch(
          `/users?station=${encodeURIComponent(station)}&q=${encodeURIComponent(q)}&filter=all&limit=3000`,
          { token, signal: ac?.signal }
        );
        if (!mountedRef.current || gen !== usersSearchGenRef.current) return;
        const returned = data?.station || station;
        if (role === 'OWNER' && returned !== usersStation) return;
        const list = Array.isArray(data?.users) ? data.users : [];
        setUsersSearchHits(list.map((u) => normalizeUserRow(u, returned)));
        setUsersSearchActiveQuery(q);
      } catch (error) {
        if (error?.name === 'AbortError' || error?.code === 'ABORT') return;
        if (error.code === 'UNAUTHORIZED') {
          handleLogout();
          return;
        }
      } finally {
        if (mountedRef.current && gen === usersSearchGenRef.current) {
          setUsersSearching(false);
        }
      }
    },
    [usersStation, handleLogout, normalizeUserRow]
  );

  const filteredUsers = useMemo(() => {
    const q = usersQuery.trim().toLowerCase().replace(/^@/, '');
    let list;
    if (q && usersSearchHits && usersSearchActiveQuery === q) {
      list = usersSearchHits;
    } else if (q) {
      list = usersList.filter((u) => {
        if (u.station && u.station !== effectiveUsersStation) return false;
        return String(u.username || '')
          .toLowerCase()
          .includes(q);
      });
    } else {
      list = usersList.filter(
        (u) => !u.station || u.station === effectiveUsersStation
      );
    }
    const f = (usersFilter || 'all').toLowerCase();
    if (f === 'banned' || f === 'ban') list = list.filter((u) => !!u.banned);
    else if (f === 'ranks' || f === 'ranked' || f === 'staff') {
      list = list.filter((u) => (u.rank || 'guest').toLowerCase() !== 'guest');
    } else if (f !== 'all' && f) {
      list = list.filter((u) => (u.rank || '').toLowerCase() === f);
    }
    return list;
  }, [
    usersList,
    usersQuery,
    usersFilter,
    effectiveUsersStation,
    usersSearchHits,
    usersSearchActiveQuery,
  ]);

  const openStationUser = useCallback(
    (u) => {
      if (!u) return;
      const station = u.station || effectiveUsersStation;
      if (!station) {
        Alert.alert('Utilisateurs', 'Station manquante — impossible d’ouvrir ce profil.');
        return;
      }
      const rank = (u.rank || 'guest').toLowerCase();
      setSelectedStationUser({
        ...u,
        station,
        id: u.id || `${station}:${u.username}`,
        rank,
      });
      setUserEditRank(rank);
      setUserEditBank(String(u.bank ?? 0));
      setUserEditBanned(!!u.banned);
    },
    [effectiveUsersStation]
  );

  const closeStationUser = useCallback(() => {
    if (userEditSaving) return;
    setSelectedStationUser(null);
  }, [userEditSaving]);

  const fetchAppUsers = useCallback(
    async ({ silent = true } = {}) => {
      const token = authTokenRef.current;
      if (!token || !canManageAppUsers) return;
      if (!silent && mountedRef.current) setAppUsersLoading(true);
      try {
        const data = await apiFetch('/app_users', { token });
        if (!mountedRef.current) return;
        setAppUsersList(Array.isArray(data?.users) ? data.users : []);
      } catch (error) {
        if (error.code === 'UNAUTHORIZED') handleLogout();
        else if (!silent) {
          Alert.alert(t('manage.title'), error.message || t('err.generic'));
        }
      } finally {
        if (mountedRef.current && !silent) setAppUsersLoading(false);
      }
    },
    [canManageAppUsers, handleLogout, t]
  );

  const createAppLoginUser = useCallback(async () => {
    const token = authTokenRef.current;
    if (!token || manageCreating || !canManageAppUsers) return;
    const username = manageUsername.trim().toLowerCase();
    const password = managePassword;
    if (!username || username.length < 3) {
      Alert.alert(t('manage.create'), t('manage.invalidUser'));
      return;
    }
    if (!password || password.length < 4) {
      Alert.alert(t('manage.create'), t('manage.passwordShort'));
      return;
    }
    const perms =
      managePerms?.length > 0
        ? managePerms
        : APP_LEVEL_PRESETS[manageLevel] || APP_LEVEL_PRESETS.viewer;
    if (!perms.length) {
      Alert.alert(t('manage.create'), t('manage.needPerm'));
      return;
    }
    const role = isOwner
      ? manageStation
      : STATION_IDS.includes(userRole)
        ? userRole
        : manageStation;
    if (!STATION_IDS.includes(role)) {
      Alert.alert(t('manage.create'), t('manage.pickStation'));
      return;
    }
    setManageCreating(true);
    try {
      const data = await apiFetch('/app_users/create', {
        method: 'POST',
        token,
        body: {
          username,
          password,
          level: manageLevel === 'custom' ? 'custom' : manageLevel,
          permissions: perms,
          role,
          station: role,
        },
      });
      if (!mountedRef.current) return;
      const u = data?.user;
      if (u) setAppUsersList((prev) => [u, ...prev.filter((x) => x.id !== u.id)]);
      setManageUsername('');
      setManagePassword('');
      applyManagePreset('operator');
      pushActionLog(
        `App user +${username} → ${role} · ${u?.level || manageLevel} · [${perms.join(',')}]`
      );
      showBanner(
        t('manage.success', {
          user: username,
          station: role,
          rank: u?.level || manageLevel,
        }),
        'ok'
      );
      lightVibrate();
      fetchAppUsers({ silent: true });
    } catch (error) {
      if (error.code === 'UNAUTHORIZED') handleLogout();
      else Alert.alert(t('manage.create'), error.message || t('err.generic'));
    } finally {
      if (mountedRef.current) setManageCreating(false);
    }
  }, [
    manageCreating,
    canManageAppUsers,
    manageUsername,
    managePassword,
    manageLevel,
    managePerms,
    manageStation,
    isOwner,
    userRole,
    t,
    pushActionLog,
    showBanner,
    fetchAppUsers,
    handleLogout,
    applyManagePreset,
  ]);

  const updateAppLoginUser = useCallback(
    async (user, patch) => {
      const token = authTokenRef.current;
      if (!token || !user?.id) return null;
      // Never send empty role/password fields that could wipe state
      const body = { id: user.id };
      if (Array.isArray(patch?.permissions)) {
        body.permissions = patch.permissions.filter((p) =>
          APP_PERM_KEYS.includes(p)
        );
      }
      if (patch?.level != null && patch.level !== '') body.level = patch.level;
      if (patch?.password != null && String(patch.password).length >= 4) {
        body.password = String(patch.password);
      }
      if (typeof patch?.active === 'boolean') body.active = patch.active;
      if (patch?.display_name != null) body.display_name = patch.display_name;
      if (patch?.role && STATION_IDS.includes(String(patch.role).toUpperCase())) {
        body.role = String(patch.role).toUpperCase();
      }

      if (
        !body.permissions &&
        body.level == null &&
        body.password == null &&
        body.active == null &&
        body.display_name == null &&
        body.role == null
      ) {
        Alert.alert(t('manage.title'), t('manage.needPerm'));
        return null;
      }

      try {
        const data = await apiFetch('/app_users/update', {
          method: 'POST',
          token,
          body,
        });
        const u = data?.user;
        if (!u) {
          Alert.alert(t('manage.title'), t('err.generic'));
          return null;
        }
        // If we sent permissions, verify the server actually stored them
        if (body.permissions) {
          const got = Array.isArray(u.permissions) ? [...u.permissions].sort() : [];
          const want = [...body.permissions].sort();
          const same =
            got.length === want.length && got.every((p, i) => p === want[i]);
          if (!same) {
            Alert.alert(
              t('manage.title'),
              t('manage.saveServerOld')
            );
            // Still update UI with what server returned
          }
        }
        setAppUsersList((prev) => prev.map((x) => (x.id === u.id ? u : x)));
        showBanner(t('manage.updated', { user: u.username || user.username }), 'ok');
        return u;
      } catch (error) {
        if (error.code === 'UNAUTHORIZED') handleLogout();
        else Alert.alert(t('manage.title'), error.message || t('err.generic'));
        return null;
      }
    },
    [handleLogout, showBanner, t]
  );

  const saveManageEdit = useCallback(async () => {
    if (!manageEditUser?.id || manageEditSaving) return;
    if (manageEditPwdOnly) {
      if (!manageEditPassword || manageEditPassword.length < 4) {
        Alert.alert(t('manage.resetPassword'), t('manage.passwordShort'));
        return;
      }
      setManageEditSaving(true);
      try {
        const u = await updateAppLoginUser(manageEditUser, {
          password: manageEditPassword,
        });
        if (u) {
          setManageEditUser(null);
          setManageEditPassword('');
          setManageEditPwdOnly(false);
          setManageEditPerms([]);
        }
      } finally {
        if (mountedRef.current) setManageEditSaving(false);
      }
      return;
    }
    const perms = (manageEditPerms || []).filter((p) => APP_PERM_KEYS.includes(p));
    if (!perms.length) {
      Alert.alert(t('manage.editPerms'), t('manage.needPerm'));
      return;
    }
    setManageEditSaving(true);
    try {
      const patch = { permissions: perms };
      if (manageEditPassword && manageEditPassword.length >= 4) {
        patch.password = manageEditPassword;
      }
      const u = await updateAppLoginUser(manageEditUser, patch);
      if (u) {
        setManageEditUser(null);
        setManageEditPassword('');
        setManageEditPwdOnly(false);
        setManageEditPerms([]);
        // Refresh list from server so UI matches disk
        fetchAppUsers({ silent: true });
      }
    } finally {
      if (mountedRef.current) setManageEditSaving(false);
    }
  }, [
    manageEditUser,
    manageEditSaving,
    manageEditPwdOnly,
    manageEditPassword,
    manageEditPerms,
    updateAppLoginUser,
    fetchAppUsers,
    t,
  ]);

  const deleteAppLoginUser = useCallback(
    (user) => {
      if (!user?.id) return;
      Alert.alert(
        t('manage.deleteTitle'),
        t('manage.deleteBody', { user: user.username }),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('common.confirm') || 'OK',
            style: 'destructive',
            onPress: async () => {
              const token = authTokenRef.current;
              if (!token) return;
              try {
                await apiFetch('/app_users/delete', {
                  method: 'POST',
                  token,
                  body: { id: user.id },
                });
                setAppUsersList((prev) => prev.filter((x) => x.id !== user.id));
                showBanner(t('manage.deleted', { user: user.username }), 'ok');
              } catch (error) {
                if (error.code === 'UNAUTHORIZED') handleLogout();
                else Alert.alert(t('manage.title'), error.message || t('err.generic'));
              }
            },
          },
        ]
      );
    },
    [handleLogout, showBanner, t]
  );

  const saveStationUser = useCallback(async () => {
    const token = authTokenRef.current;
    if (!token || !selectedStationUser || userEditSaving) return;
    if (!canUsersEdit) {
      Alert.alert(t('err.forbidden'), t('manage.noUsersEdit'));
      return;
    }
    const username = selectedStationUser.username;
    const station = selectedStationUser.station;
    const previous = { ...selectedStationUser };
    if (!station || !STATION_IDS.includes(station)) {
      Alert.alert(
        'Isolation',
        'Profil sans station. Ferme et rouvre l’utilisateur depuis la bonne radio.'
      );
      return;
    }
    if (isOwner && station !== usersStation) {
      Alert.alert(
        'Mauvaise radio',
        `Ce profil est ${station}, tu es sur ${usersStation}.\nRien n’a été modifié.`
      );
      setSelectedStationUser(null);
      return;
    }
    if (!isOwner && OWNER_ONLY_RANKS.has(userEditRank)) {
      Alert.alert(
        'Permission',
        'Seul le OWNER de l’app peut attribuer les rangs owner ou dev.'
      );
      return;
    }
    if (
      !isOwner &&
      OWNER_ONLY_RANKS.has((selectedStationUser.rank || '').toLowerCase())
    ) {
      Alert.alert(
        'Permission',
        'Seul le OWNER de l’app peut modifier un owner/dev Highrise.'
      );
      return;
    }
    let bankVal = parseInt(String(userEditBank).trim(), 10);
    if (Number.isNaN(bankVal) || bankVal < 0) {
      Alert.alert('Bank', 'Solde invalide (entier ≥ 0).');
      return;
    }

    const rankNorm = (userEditRank || 'guest').toLowerCase();
    const optimistic = {
      ...selectedStationUser,
      station,
      username,
      rank: rankNorm,
      rank_level: RANK_LEVELS[rankNorm] ?? 0,
      banned: userEditBanned,
      bank: bankVal,
      id: selectedStationUser.id || `${station}:${username}`,
    };
    setSelectedStationUser(optimistic);
    setUsersList((prev) => {
      const id = optimistic.id;
      return prev.map((x) =>
        (x.id || `${x.station}:${x.username}`) === id ? { ...x, ...optimistic } : x
      );
    });
    setUsersSearchHits((prev) => {
      if (!prev) return prev;
      const id = optimistic.id;
      return prev.map((x) =>
        (x.id || `${x.station}:${x.username}`) === id ? { ...x, ...optimistic } : x
      );
    });

    setUserEditSaving(true);
    try {
      const data = await apiFetch('/users/update', {
        method: 'POST',
        token,
        body: {
          station,
          username,
          rank: rankNorm,
          banned: userEditBanned,
          bank: bankVal,
        },
      });
      if (data?.station && data.station !== station) {
        setSelectedStationUser(previous);
        fetchStationUsers({ silent: true });
        Alert.alert('Erreur isolation', 'Le serveur a renvoyé une autre radio. Annulé.');
        return;
      }
      if (mountedRef.current && data) {
        const stamped = {
          ...data,
          station,
          id: data.id || `${station}:${data.username || username}`,
          rank: (data.rank || 'guest').toLowerCase(),
          rank_level:
            typeof data.rank_level === 'number'
              ? data.rank_level
              : RANK_LEVELS[(data.rank || 'guest').toLowerCase()] ?? 0,
        };
        setSelectedStationUser(stamped);
        setUserEditRank(stamped.rank);
        setUserEditBank(String(stamped.bank ?? 0));
        setUserEditBanned(!!stamped.banned);
        const patch = (prev) =>
          prev.map((x) =>
            (x.id || `${x.station}:${x.username}`) === stamped.id
              ? { ...x, ...stamped }
              : x
          );
        setUsersList(patch);
        setUsersSearchHits((prev) => (prev ? patch(prev) : prev));
      }
      pushActionLog(
        `User [${station}] ${username} → rang=${rankNorm} ban=${userEditBanned} bank=${bankVal}`
      );
      showBanner(
        `✓ ${username} · ${station} · bank ${bankVal} · ${rankNorm}`,
        'ok'
      );
      lightVibrate();
    } catch (error) {
      if (error.code === 'UNAUTHORIZED') {
        handleLogout();
        return;
      }
      setSelectedStationUser(previous);
      setUserEditRank((previous.rank || 'guest').toLowerCase());
      setUserEditBank(String(previous.bank ?? 0));
      setUserEditBanned(!!previous.banned);
      fetchStationUsers({ silent: true });
      Alert.alert('Erreur', error.message || 'Échec de la sauvegarde.');
    } finally {
      if (mountedRef.current) setUserEditSaving(false);
    }
  }, [
    selectedStationUser,
    userEditSaving,
    userEditBank,
    userEditRank,
    userEditBanned,
    usersStation,
    isOwner,
    canUsersEdit,
    fetchStationUsers,
    handleLogout,
    pushActionLog,
    showBanner,
    t,
  ]);

  const clearAllSessions = useCallback(() => {
    if (!isOwner || clearingSessions) return;

    Alert.alert(
      'Révoquer les sessions',
      'Déconnecter TOUS les appareils, y compris vous ?',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Tout déconnecter',
          style: 'destructive',
          onPress: async () => {
            const token = authTokenRef.current;
            if (!token) return;
            setClearingSessions(true);
            try {
              const data = await apiFetch('/clear_sessions', {
                method: 'POST',
                token,
                body: {},
              });
              await handleLogout();
              Alert.alert(
                'Sessions révoquées',
                `${data?.cleared ?? 0} session(s) invalidée(s).`
              );
            } catch (error) {
              if (error.code === 'UNAUTHORIZED') {
                await handleLogout();
                Alert.alert('Sessions révoquées', 'Reconnectez-vous.');
                return;
              }
              Alert.alert(
                'Erreur',
                error.message ||
                  'Impossible de révoquer. Redémarrez Batch Manager (API v2).'
              );
            } finally {
              if (mountedRef.current) setClearingSessions(false);
            }
          },
        },
      ]
    );
  }, [isOwner, clearingSessions, handleLogout]);

  const sendNotification = useCallback(async () => {
    const token = authTokenRef.current;
    if (!token || !isOwner || sendingNotify) return;

    const title = notifyTitle.trim();
    const body = notifyBody.trim();
    if (!title || !body) {
      Alert.alert('Notification', 'Titre et message requis.');
      return;
    }

    setSendingNotify(true);
    try {
      const data = await apiFetch('/notify', {
        method: 'POST',
        token,
        body: { audience: notifyAudience, title, body },
      });
      pushActionLog(`Notif → ${notifyAudience} (${data?.sent ?? 0} app.)`);
      showBanner(`Envoyé à ${data?.sent ?? 0} appareil(s)`, 'ok');
      lightVibrate();
      setNotifyTitle('');
      setNotifyBody('');
      fetchAdmin();
    } catch (error) {
      if (error.code === 'UNAUTHORIZED') {
        handleLogout();
        return;
      }
      Alert.alert(
        'Erreur',
        error.message || 'Échec. Redémarrez Batch Manager pour /api/notify.'
      );
    } finally {
      if (mountedRef.current) setSendingNotify(false);
    }
  }, [
    isOwner,
    sendingNotify,
    notifyTitle,
    notifyBody,
    notifyAudience,
    pushActionLog,
    showBanner,
    fetchAdmin,
    handleLogout,
  ]);

  const runAdminAction = useCallback(
    async (action, body = {}, { confirmTitle, confirmMsg, destructive } = {}) => {
      const token = authTokenRef.current;
      if (!token || !isOwner || adminBusy) return null;

      const exec = async () => {
        setAdminBusy(true);
        try {
          const data = await apiFetch('/admin/action', {
            method: 'POST',
            token,
            body: { action, ...body },
          });
          pushActionLog(`Admin ${action} OK`);
          showBanner(`Admin · ${action}`, 'ok');
          lightVibrate();
          fetchAdmin();
          if (mainTabRef.current === 'chat') fetchChatChannels();
          return data;
        } catch (error) {
          if (error.code === 'UNAUTHORIZED') {
            handleLogout();
            return null;
          }
          Alert.alert('Admin', error.message || `Échec ${action}`);
          return null;
        } finally {
          if (mountedRef.current) setAdminBusy(false);
        }
      };

      if (confirmTitle) {
        return new Promise((resolve) => {
          Alert.alert(confirmTitle, confirmMsg || '', [
            { text: 'Annuler', style: 'cancel', onPress: () => resolve(null) },
            {
              text: destructive ? 'Confirmer' : 'OK',
              style: destructive ? 'destructive' : 'default',
              onPress: async () => resolve(await exec()),
            },
          ]);
        });
      }
      return exec();
    },
    [
      isOwner,
      adminBusy,
      pushActionLog,
      showBanner,
      fetchAdmin,
      fetchChatChannels,
      handleLogout,
    ]
  );

  // --- TERMINAL ---

  const fetchLogs = useCallback(
    async (processId) => {
      const token = authTokenRef.current;
      if (!token || !processId) return;
      try {
        const data = await apiFetch(
          `/logs?target=${encodeURIComponent(processId)}&limit=60`,
          { token }
        );
        if (!mountedRef.current) return;
        const next = Array.isArray(data) ? data : [];
        setLiveLogs((prev) => {
          if (prev.length === next.length && prev.length > 0) {
            const a = prev[prev.length - 1];
            const b = next[next.length - 1];
            if (a?.text === b?.text && prev[0]?.text === next[0]?.text) return prev;
          }
          if (prev.length === 0 && next.length === 0) return prev;
          return next;
        });
      } catch (error) {
        if (error.code === 'UNAUTHORIZED') handleLogout();
      }
    },
    [handleLogout]
  );

  const openTerminal = useCallback(
    (process) => {
      if (!canOpenLogs) {
        Alert.alert(t('err.forbidden'), t('manage.noLogs'));
        return;
      }
      setSelectedProcess(process);
      setLiveLogs([]);
      setCommandInput('');
      setTerminalVisible(true);
      fetchLogs(process.id);
    },
    [fetchLogs, canOpenLogs, t]
  );

  const closeTerminal = useCallback(() => {
    setTerminalVisible(false);
    setSelectedProcess(null);
    setLiveLogs([]);
    setCommandInput('');
    setSendingConsole(false);
  }, []);

  const sendConsoleText = useCallback(
    async (rawText, { clearInput = false } = {}) => {
      const token = authTokenRef.current;
      let textToSend = String(rawText || '').trim();
      if (!textToSend || !selectedProcess || !token || sendingConsole) return;

      // Normalize common prefixes so play / play2 always parse
      textToSend = textToSend.replace(/^\s*[!$/]+/, '').trim();
      if (!textToSend) return;

      const first = textToSend.split(/\s+/)[0].toLowerCase();
      const isPlayCmd = first === 'play' || first === 'play2' || first === 'p' || first === 'playfront';
      if (isPlayCmd && !textToSend.includes(' ')) {
        Alert.alert(
          'play / play2',
          'Usage:\nplay <url ou recherche>\nplay2 <url ou recherche>  (prochaine chanson)\n\nEx: play despacito\nEx: play2 https://youtu.be/…'
        );
        return;
      }

      if (clearInput) setCommandInput('');
      setSendingConsole(true);
      setLiveLogs((prev) => [
        ...prev,
        {
          text: isPlayCmd
            ? `📱 [ENVOYÉ] : ${textToSend}  (téléchargement si besoin…)`
            : `📱 [ENVOYÉ] : ${textToSend}`,
          type: 'admin',
        },
      ]);
      pushActionLog(`Console ${selectedProcess.id}: ${textToSend}`);

      const processId = selectedProcess.id;
      try {
        await apiFetch('/smart_command', {
          method: 'POST',
          token,
          body: { target: processId, text: textToSend },
        });
        // play downloads can take a while — poll logs several times
        const delays = isPlayCmd
          ? [800, 2000, 4000, 7000, 12000]
          : [LOG_REFRESH_AFTER_CMD_MS, 1500];
        delays.forEach((ms) => scheduleRefresh(() => fetchLogs(processId), ms));
      } catch (error) {
        if (error.code === 'UNAUTHORIZED') {
          handleLogout();
          return;
        }
        if (error.code === 'NETWORK' && appStateRef.current !== 'active') {
          return;
        }
        Alert.alert('Erreur', "Impossible d'envoyer la commande.");
      } finally {
        if (mountedRef.current) setSendingConsole(false);
      }
    },
    [selectedProcess, sendingConsole, fetchLogs, handleLogout, pushActionLog, scheduleRefresh]
  );

  const submitTypedCommand = useCallback(() => {
    sendConsoleText(commandInput, { clearInput: true });
  }, [commandInput, sendConsoleText]);

  const openBotConfigEditor = useCallback(
    (item, field) => {
      if (!item?.id || !isBotProcess(item)) return;
      if (!canBotConfig) {
        Alert.alert(t('err.forbidden'), t('manage.noBotConfig'));
        return;
      }
      setBotConfigModal({
        target: item.id,
        name: item.name || item.id,
        field, // 'room' | 'key'
        current: field === 'room' ? item.room_id || '' : item.api_key_masked || '',
        draft: field === 'room' ? item.room_id || '' : '',
      });
    },
    [canBotConfig, t]
  );

  const closeBotConfigEditor = useCallback(() => {
    if (botConfigSaving) return;
    setBotConfigModal(null);
  }, [botConfigSaving]);

  const saveBotConfig = useCallback(async () => {
    const token = authTokenRef.current;
    if (!token || !botConfigModal || botConfigSaving) return;
    const draft = String(botConfigModal.draft || '').trim();
    if (!draft) {
      Alert.alert(
        botConfigModal.field === 'room' ? 'Room ID' : 'API key',
        botConfigModal.field === 'room'
          ? 'Colle un room id ou l‘URL (ownedRoomId).'
          : 'Colle la nouvelle API key Highrise.'
      );
      return;
    }

    setBotConfigSaving(true);
    try {
      const body =
        botConfigModal.field === 'room'
          ? { target: botConfigModal.target, room_id: draft }
          : { target: botConfigModal.target, api_key: draft };
      const data = await apiFetch('/bot_config', {
        method: 'POST',
        token,
        body,
      });

      // Optimistic local update from response
      if (mountedRef.current && data) {
        setProcesses((prev) =>
          prev.map((p) =>
            p.id === botConfigModal.target
              ? {
                  ...p,
                  room_id: data.room_id ?? p.room_id,
                  api_key_masked: data.api_key_masked ?? p.api_key_masked,
                  api_key_tail: data.api_key_tail ?? p.api_key_tail,
                  is_bot: true,
                }
              : p
          )
        );
      }

      setBotConfigModal(null);
      pushActionLog(
        botConfigModal.field === 'room'
          ? `Room → ${botConfigModal.target}: ${data?.room_id || draft}`
          : `API key → ${botConfigModal.target}`
      );

      const restartHint =
        'Le .bat a été mis à jour. Il faut RESTART le bot pour appliquer.';
      Alert.alert(
        'Config bot',
        `${restartHint}\n\nRoom: ${data?.room_id || '—'}\nKey: ${data?.api_key_masked || '—'}`,
        [
          { text: 'Plus tard', style: 'cancel' },
          {
            text: 'RESTART',
            onPress: () => sendCommand(botConfigModal.target, 'RESTART'),
          },
        ]
      );
      scheduleRefresh(() => fetchStatus(false), 600);
    } catch (error) {
      if (error.code === 'UNAUTHORIZED') {
        handleLogout();
        return;
      }
      Alert.alert(
        'Erreur',
        error.message || "Impossible de modifier le .bat du bot."
      );
    } finally {
      if (mountedRef.current) setBotConfigSaving(false);
    }
  }, [
    botConfigModal,
    botConfigSaving,
    fetchStatus,
    handleLogout,
    pushActionLog,
    scheduleRefresh,
    sendCommand,
  ]);

  const onProcessLongPress = useCallback(
    (item) => {
      const buttons = [];
      if (canOpenLogs) {
        buttons.push({ text: 'Terminal', onPress: () => openTerminal(item) });
      }
      if (canControlRadios) {
        buttons.push({ text: 'START', onPress: () => sendCommand(item.id, 'START') });
        buttons.push({
          text: 'KILL',
          style: 'destructive',
          onPress: () => sendCommand(item.id, 'KILL'),
        });
        buttons.push({ text: 'RESTART', onPress: () => sendCommand(item.id, 'RESTART') });
      }
      if (isOwner) {
        buttons.push({
          text: 'Notifier à propos',
          onPress: () => {
            setNotifyTitle(`📻 ${item.name}`);
            setNotifyBody(`Mise à jour concernant ${item.id} (${item.status}).`);
            setNotifyAudience('ALL');
            setCmdCenterVisible(true);
          },
        });
      }
      if (buttons.length === 0) {
        Alert.alert(item.name, `ID: ${item.id}\n${t('status.hint')}`);
        return;
      }
      buttons.push({ text: 'Annuler', style: 'cancel' });
      Alert.alert(item.name, `ID: ${item.id}`, buttons);
    },
    [openTerminal, sendCommand, isOwner, canOpenLogs, canControlRadios, t]
  );

  const toggleBiometricPref = useCallback(async (value) => {
    if (value && !biometricHardwareOk) {
      Alert.alert(
        'Biométrie',
        "Aucune biométrie n'est configurée sur cet appareil (Face ID / empreinte)."
      );
      setBiometricEnabled(false);
      await SecureStore.setItemAsync(BIOMETRIC_KEY, '0');
      return;
    }
    setBiometricEnabled(value);
    await SecureStore.setItemAsync(BIOMETRIC_KEY, value ? '1' : '0');
  }, [biometricHardwareOk]);

  const toggleAlerts = useCallback(async (value) => {
    setStatusAlerts(value);
    await SecureStore.setItemAsync(ALERTS_KEY, value ? '1' : '0');
  }, []);

  // --- LIFECYCLE ---

  // Pause polls when app is backgrounded (tab out) so failed requests don't look like errors
  useEffect(() => {
    const onChange = (next) => {
      const prev = appStateRef.current;
      appStateRef.current = next;
      if (prev.match(/inactive|background/) && next === 'active') {
        // Coming back: quiet refresh, reset fail counter
        netFailCountRef.current = 0;
        if (authTokenRef.current) {
          fetchStatus(false);
          fetchNotifications({ silent: true });
          fetchChatChannels();
          if (userRoleRef.current === 'OWNER') fetchAdmin();
        }
      }
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [fetchStatus, fetchNotifications, fetchChatChannels, fetchAdmin]);

  // Lift chat composer by real keyboard height (works with Android edge-to-edge)
  useEffect(() => {
    const showEvt = IS_IOS ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = IS_IOS ? 'keyboardWillHide' : 'keyboardDidHide';
    const onShow = (e) => {
      const h = Math.round(e?.endCoordinates?.height || 0);
      // Full keyboard height from bottom of screen — composer rides on top of keys
      setKeyboardHeight(h > 0 ? h : 0);
      chatStickToBottomRef.current = true;
      scrollChatToEnd(true);
    };
    const onHide = () => setKeyboardHeight(0);
    const subShow = Keyboard.addListener(showEvt, onShow);
    const subHide = Keyboard.addListener(hideEvt, onHide);
    return () => {
      subShow.remove();
      subHide.remove();
    };
  }, [scrollChatToEnd]);

  const onRadiosTab = mainTab === 'radios';
  const onAlertsTab = mainTab === 'alerts' || notifyFeedVisible;
  const onChatTab = mainTab === 'chat';

  // Status: fast on Radios tab, idle elsewhere (still keeps dashboard counts fresh enough)
  useEffect(() => {
    if (!isUnlocked) return undefined;
    fetchStatus(true);
    const ms = onRadiosTab ? POLL_STATUS_MS : POLL_STATUS_IDLE_MS;
    const interval = setInterval(() => {
      if (appStateRef.current !== 'active') return;
      fetchStatus(false);
    }, ms);
    return () => clearInterval(interval);
  }, [isUnlocked, fetchStatus, onRadiosTab]);

  useEffect(() => {
    if (!isUnlocked || !isOwner) return undefined;
    fetchAdmin();
    const interval = setInterval(() => {
      if (appStateRef.current !== 'active') return;
      fetchAdmin();
    }, POLL_ADMIN_MS);
    return () => clearInterval(interval);
  }, [isUnlocked, isOwner, fetchAdmin]);

  // Notifications: fast on Alerts, slow badge-only elsewhere
  useEffect(() => {
    if (!isUnlocked) return undefined;
    fetchNotifications({ silent: true });
    const ms = onAlertsTab ? POLL_NOTIFY_MS : POLL_NOTIFY_IDLE_MS;
    const interval = setInterval(() => {
      if (appStateRef.current !== 'active') return;
      fetchNotifications({ silent: true });
    }, ms);
    return () => clearInterval(interval);
  }, [isUnlocked, fetchNotifications, onAlertsTab]);

  // Chat channel list: fast on Chat tab; slower elsewhere for badge only
  useEffect(() => {
    if (!isUnlocked) return undefined;
    if (onChatTab) fetchChatChannels();
    const ms = onChatTab ? POLL_CHAT_LIST_MS : POLL_CHAT_LIST_IDLE_MS;
    const interval = setInterval(() => {
      if (appStateRef.current !== 'active') return;
      fetchChatChannels();
    }, ms);
    return () => clearInterval(interval);
  }, [isUnlocked, fetchChatChannels, onChatTab]);

  useEffect(() => {
    if (!isUnlocked || !activeChat?.id) return undefined;
    const id = activeChat.id;
    fetchChatMessages(id, { silent: true });
    fetchTyping();
    const interval = setInterval(() => {
      if (appStateRef.current !== 'active') return;
      fetchChatMessages(id, { silent: true });
      fetchTyping();
    }, POLL_CHAT_MS);
    return () => clearInterval(interval);
  }, [isUnlocked, activeChat?.id, fetchChatMessages, fetchTyping]);

  // Notification tap / receive — only useful outside Expo Go (remote push).
  // In Expo Go, chat/alerts still refresh via polling (no OS push).
  useEffect(() => {
    if (!isUnlocked || IS_EXPO_GO) return undefined;

    let receivedSub;
    let responseSub;
    try {
      receivedSub = Notifications.addNotificationReceivedListener((notification) => {
        const data = notification?.request?.content?.data || {};
        if (data.kind === 'chat') {
          fetchChatChannels();
          if (activeChatIdRef.current === data.channel) {
            fetchChatMessages(data.channel, { silent: true });
          }
          const me = String(appUsernameRef.current || userRoleRef.current || '')
            .trim()
            .toLowerCase();
          const role = String(userRoleRef.current || '')
            .trim()
            .toLowerCase();
          const from = String(data.from_user || data.from || data.display_name || '')
            .trim()
            .toLowerCase();
          const isOwn =
            !!from && (from === me || from === role || data.from === userRoleRef.current);
          if (statusAlertsRef.current && !isOwn) {
            const label = data.from_user || data.display_name || data.from || 'Chat';
            showBanner(`${label}: ${notification.request.content.body || ''}`, 'info');
          }
        } else {
          fetchNotifications({ silent: true });
        }
      });

      responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
        const data = response?.notification?.request?.content?.data || {};
        if (data.kind === 'chat' && data.channel) {
          setMainTab('chat');
          openChatChannel({
            id: data.channel,
            name:
              data.channel === 'public'
                ? 'Général'
                : `Chat ${data.from_user || data.from || ''}`.trim(),
            type: data.channel === 'public' ? 'public' : 'dm',
          });
        } else {
          setMainTab('alerts');
          fetchNotifications({ silent: true });
        }
      });
    } catch {
      return undefined;
    }

    return () => {
      try {
        receivedSub?.remove?.();
        responseSub?.remove?.();
      } catch {
        /* ignore */
      }
    };
  }, [
    isUnlocked,
    fetchNotifications,
    fetchChatChannels,
    fetchChatMessages,
    openChatChannel,
    showBanner,
  ]);

  useEffect(() => {
    if (!terminalVisible || !selectedProcess?.id) return undefined;
    const id = selectedProcess.id;
    const logInterval = setInterval(() => {
      if (appStateRef.current !== 'active') return;
      fetchLogs(id);
    }, POLL_LOGS_MS);
    return () => clearInterval(logInterval);
  }, [terminalVisible, selectedProcess?.id, fetchLogs]);

  // When user opens system alerts tab / modal, mark as read
  useEffect(() => {
    if ((mainTab === 'alerts' || notifyFeedVisible) && notifyFeed.length) {
      markNotificationsRead(notifyFeed);
    }
  }, [mainTab, notifyFeedVisible, notifyFeed, markNotificationsRead]);

  useEffect(() => {
    if (mainTab === 'alerts') {
      fetchNotifications({ silent: true });
    }
    if (mainTab === 'chat' && !activeChat) {
      fetchChatChannels();
    }
  }, [mainTab, activeChat, fetchNotifications, fetchChatChannels]);

  // Users tab: Highrise directory
  useEffect(() => {
    if (mainTab !== 'users') return undefined;
    const already =
      usersLoadedStationRef.current === usersStation && usersList.length > 0;
    fetchStationUsers({ silent: already });
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainTab, usersStation, fetchStationUsers]);

  // Management tab: app login accounts
  useEffect(() => {
    if (mainTab !== 'manage' || !canManageAppUsers) return undefined;
    fetchAppUsers({ silent: false });
    return undefined;
  }, [mainTab, canManageAppUsers, fetchAppUsers]);

  // Playlist tab: AutoDJ folder for current station
  useEffect(() => {
    if (mainTab !== 'playlist' || !canPlaylist) return undefined;
    fetchPlaylist({ silent: false });
    const interval = setInterval(() => {
      if (appStateRef.current !== 'active') return;
      fetchPlaylist({ silent: true });
    }, POLL_PLAYLIST_MS);
    return () => clearInterval(interval);
  }, [mainTab, canPlaylist, playlistStation, fetchPlaylist]);

  // Surface download completion as banner (once per finished job)
  useEffect(() => {
    if (!playlistDownload || mainTab !== 'playlist') return;
    const st = playlistDownload.status;
    if (st !== 'done' && st !== 'error') return;
    const key = `${st}|${playlistDownload.finished_at || ''}|${playlistDownload.file || playlistDownload.error || ''}`;
    if (playlistDlAnnouncedRef.current === key) return;
    playlistDlAnnouncedRef.current = key;
    if (st === 'done') {
      showBanner(
        t('playlist.downloadDone', {
          title: playlistDownload.title || playlistDownload.file || 'OK',
        }),
        'ok'
      );
      lightVibrate();
    } else {
      showBanner(
        `${t('playlist.downloadError')}: ${playlistDownload.error || ''}`,
        'warn'
      );
    }
  }, [playlistDownload, mainTab, showBanner, t]);

  // Debounced full-DB search while typing (not create)
  useEffect(() => {
    if (mainTab !== 'users') return undefined;
    const q = usersQuery.trim().replace(/^@/, '');
    if (!q) {
      setUsersSearchHits(null);
      setUsersSearchActiveQuery('');
      setUsersSearching(false);
      return undefined;
    }
    // Parent DebouncedSearchInput already waited ~280ms — short settle only
    const timer = setTimeout(() => searchStationUsers(q), 40);
    return () => clearTimeout(timer);
  }, [usersQuery, usersStation, mainTab, searchStationUsers]);

  // --- DERIVED ---

  const visibleProcesses = useMemo(() => {
    if (isOwner) return processes;
    if (!userRole) return [];
    const roleUpper = userRole.toUpperCase();
    return processes.filter((p) => p.id.toUpperCase().startsWith(roleUpper));
  }, [processes, userRole, isOwner]);

  const activeCount = useMemo(
    () => visibleProcesses.filter((p) => p.status === 'RUNNING').length,
    [visibleProcesses]
  );
  const stoppedCount = useMemo(
    () => visibleProcesses.filter((p) => p.status === 'STOPPED' || (!p.status)).length,
    [visibleProcesses]
  );
  const errorCount = useMemo(
    () => visibleProcesses.filter((p) => p.status === 'ERROR').length,
    [visibleProcesses]
  );
  // leftover non-running non-error (unknown statuses)
  const otherDown = useMemo(
    () =>
      visibleProcesses.filter(
        (p) => p.status !== 'RUNNING' && p.status !== 'STOPPED' && p.status !== 'ERROR'
      ).length,
    [visibleProcesses]
  );
  const offlineCount = stoppedCount + otherDown;

  const groupedData = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    // Same definition as ProcessCard room/key buttons (RADIO*_BOT / Highrise)
    const isBot = (p) => isBotProcess(p);

    let filtered = visibleProcesses;
    if (q) {
      filtered = visibleProcesses.filter((p) => {
        if (!p?.id) return false;
        const name = (p.name || '').toLowerCase();
        const id = String(p.id).toLowerCase();
        return name.includes(q) || id.includes(q);
      });
    } else {
      filtered = visibleProcesses.filter((p) => !!p?.id);
    }

    if (statusFilter === 'RUNNING') {
      filtered = filtered.filter((p) => p.status === 'RUNNING');
    } else if (statusFilter === 'STOPPED') {
      // Hors ligne = anything not RUNNING (includes ERROR)
      filtered = filtered.filter((p) => p.status !== 'RUNNING');
    } else if (statusFilter === 'BOTS') {
      filtered = filtered.filter(isBot);
    } else if (statusFilter === 'MAINS') {
      filtered = filtered.filter((p) => !isBot(p));
    }

    // Single pass split into bots / systems
    const bots = [];
    const mains = [];
    for (let i = 0; i < filtered.length; i += 1) {
      const p = filtered[i];
      if (isBot(p)) bots.push(p);
      else mains.push(p);
    }

    const sections = [];
    if (bots.length > 0) sections.push({ title: t('process.bots'), data: bots });
    if (mains.length > 0) sections.push({ title: t('process.systems'), data: mains });
    return sections;
  }, [visibleProcesses, searchQuery, statusFilter, t]);

  const onProcessSearchChange = useCallback((text) => {
    setSearchQuery(text);
  }, []);

  const onUsersSearchChange = useCallback((text) => {
    setUsersQuery(text);
  }, []);

  const switchMainTab = useCallback((tab) => {
    Keyboard.dismiss();
    setMainTab(tab);
    if (tab !== 'chat') {
      // Clear ref immediately so in-flight polls don't mark-read the wrong channel
      activeChatIdRef.current = null;
      setActiveChat(null);
      setChatMessages([]);
      setChatInput('');
      setChatEditTarget(null);
      setPendingImage(null);
      setChatTypingUsers([]);
    }
  }, []);

  const processKeyExtractor = useCallback(
    (item, index) => (item?.id != null ? String(item.id) : `proc-${index}`),
    []
  );

  const processSections = useMemo(
    () =>
      // Empty sections array can skip ListEmptyComponent on some RN builds
      groupedData.length > 0 ? groupedData : [{ title: '', data: [] }],
    [groupedData]
  );

  const processExtraData = useMemo(
    () => `${statusLoaded ? 1 : 0}|${statusFilter}|${searchQuery}|${connectionOk ? 1 : 0}`,
    [statusLoaded, statusFilter, searchQuery, connectionOk]
  );

  const renderLogItem = useCallback(({ item }) => {
    let color = '#e2e8f0';
    if (item.type === 'error') color = '#ef4444';
    if (item.type === 'warning') color = '#f59e0b';
    if (item.type === 'success') color = '#10b981';
    if (item.type === 'info') color = '#38bdf8';
    if (item.type === 'admin') color = '#c084fc';
    return (
      <Text style={[styles.logText, { color }]} selectable numberOfLines={8}>
        {item.text}
      </Text>
    );
  }, []);

  const renderProcessItem = useCallback(
    ({ item }) => (
      <ProcessCard
        item={item}
        onOpenTerminal={openTerminal}
        onSendCommand={sendCommand}
        onLongPress={onProcessLongPress}
        onEditRoom={(p) => openBotConfigEditor(p, 'room')}
        onEditApiKey={(p) => openBotConfigEditor(p, 'key')}
        t={t}
        allowControl={canControlRadios}
        allowLogs={canOpenLogs}
        allowBotConfig={canBotConfig}
      />
    ),
    [
      openTerminal,
      sendCommand,
      onProcessLongPress,
      openBotConfigEditor,
      t,
      canControlRadios,
      canOpenLogs,
      canBotConfig,
    ]
  );

  const renderChatMessage = useCallback(
    ({ item, index }) => {
      const isMine = isMyChatMessage(item);
      const prev = chatMessages[index - 1];
      // Group by real speaker (app username), not only station role
      const showSender = !prev || chatSpeakerKey(prev) !== chatSpeakerKey(item);
      return (
        <ChatMsgBubble
          msg={item}
          isMine={isMine}
          showSender={showSender}
          onLongPress={() => onMessageLongPress(item)}
          t={t}
        />
      );
    },
    [chatMessages, onMessageLongPress, t, isMyChatMessage]
  );

  const renderNotifyItem = useCallback(
    ({ item }) => (
      <NotifyChatBubble
        item={item}
        unread={Number(item.ts) > (notifyLastReadTs || 0)}
        canDelete={isOwner}
        onDelete={() => deleteFeedAlert(item)}
        t={t}
      />
    ),
    [notifyLastReadTs, isOwner, deleteFeedAlert, t]
  );

  const renderUserItem = useCallback(
    ({ item }) => (
      <UserRow
        item={item}
        stationFallback={effectiveUsersStation}
        onPress={openStationUser}
      />
    ),
    [effectiveUsersStation, openStationUser]
  );

  const userKeyExtractor = useCallback(
    (item) => item.id || `${item.station || effectiveUsersStation}:${item.username}`,
    [effectiveUsersStation]
  );

  const notifyKeyExtractor = useCallback(
    (item, index) => item.id || `n-${index}`,
    []
  );

  const listPerfProps = useMemo(
    () => ({
      initialNumToRender: IS_ANDROID ? 10 : 12,
      maxToRenderPerBatch: IS_ANDROID ? 5 : 6,
      updateCellsBatchingPeriod: IS_ANDROID ? 100 : 80,
      windowSize: IS_ANDROID ? 6 : 7,
      // removeClippedSubviews: blank lists on Android + some iOS tab switches
      removeClippedSubviews: false,
      ...platformListExtras,
    }),
    []
  );

  /** Heavier list (radios with cards) — keep virtualization tighter */
  const radiosListPerfProps = useMemo(
    () => ({
      initialNumToRender: IS_ANDROID ? 6 : 8,
      maxToRenderPerBatch: IS_ANDROID ? 3 : 4,
      updateCellsBatchingPeriod: 100,
      windowSize: IS_ANDROID ? 4 : 5,
      removeClippedSubviews: false,
      ...platformListExtras,
    }),
    []
  );

  // Never leave mainTab in an unknown / unauthorized state (blank UI or push deep-link)
  useEffect(() => {
    if (!['radios', 'users', 'chat', 'alerts', 'playlist', 'manage'].includes(mainTab)) {
      setMainTab('radios');
      return;
    }
    if (mainTab === 'users' && !canUsersTab) setMainTab('radios');
    else if (mainTab === 'chat' && !canChat) setMainTab('radios');
    else if (mainTab === 'alerts' && !canAlerts) setMainTab('radios');
    else if (mainTab === 'playlist' && !canPlaylist) setMainTab('radios');
    else if (mainTab === 'manage' && !canManageAppUsers) setMainTab('radios');
  }, [mainTab, canUsersTab, canChat, canAlerts, canPlaylist, canManageAppUsers]);

  const renderSectionHeader = useCallback(({ section }) => {
    if (!section?.title) return null;
    return <Text style={styles.sectionHeader}>{section.title}</Text>;
  }, []);

  const listHeader = useMemo(
    () => (
      <View>
        {banner ? (
          <View
            style={[
              styles.banner,
              banner.type === 'warn' && styles.bannerWarn,
              banner.type === 'ok' && styles.bannerOk,
            ]}
          >
            <Text style={styles.bannerText} numberOfLines={2}>
              {banner.text}
            </Text>
          </View>
        ) : null}

        <View style={styles.dashboard}>
          <View style={[styles.dashCard, { borderBottomColor: '#10b981' }]}>
            <Text style={styles.dashNumber}>{activeCount}</Text>
            <Text style={styles.dashLabel}>{t('dash.active')}</Text>
          </View>
          <View style={[styles.dashCard, { borderBottomColor: '#ef4444' }]}>
            <Text style={styles.dashNumber}>{offlineCount}</Text>
            <Text style={styles.dashLabel}>{t('dash.stopped')}</Text>
          </View>
          <View style={[styles.dashCard, { borderBottomColor: '#f59e0b' }]}>
            <Text style={styles.dashNumber}>{errorCount}</Text>
            <Text style={styles.dashLabel}>{t('dash.errors')}</Text>
          </View>
          {isOwner ? (
            <View style={[styles.dashCard, { borderBottomColor: '#a78bfa' }]}>
              <Text style={styles.dashNumber}>{adminData?.sessions?.total ?? '—'}</Text>
              <Text style={styles.dashLabel}>{t('dash.sessions')}</Text>
            </View>
          ) : null}
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
          style={styles.filterScroll}
          keyboardShouldPersistTaps="handled"
        >
          {STATUS_FILTER_IDS.map((id) => {
            const labelKey =
              id === 'ALL'
                ? 'filter.all'
                : id === 'RUNNING'
                  ? 'filter.running'
                  : id === 'STOPPED'
                    ? 'filter.stopped'
                    : id === 'BOTS'
                      ? 'filter.bots'
                      : 'filter.mains';
            return (
              <Chip
                key={id}
                label={t(labelKey)}
                active={statusFilter === id}
                onPress={() => {
                  // No LayoutAnimation here — animating whole SectionList on filter = jank
                  setStatusFilter(id);
                }}
              />
            );
          })}
        </ScrollView>

        <ProcessSearchBar
          key={searchBarKey}
          placeholder={t('search.process')}
          onChangeDebounced={onProcessSearchChange}
          debounceMs={160}
        />

        {isOwner ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.ownerBarContent}
            style={styles.ownerBar}
            keyboardShouldPersistTaps="handled"
          >
            <OwnerActionBtn
              icon="play"
              label="Start"
              color="#34d399"
              bg="rgba(16,185,129,0.15)"
              onPress={() => doGlobalAction('START')}
            />
            <OwnerActionBtn
              icon="stop"
              label="Stop"
              color="#f87171"
              bg="rgba(239,68,68,0.15)"
              onPress={() => doGlobalAction('KILL')}
            />
            <OwnerActionBtn
              icon="sync"
              label="Restart"
              color="#38bdf8"
              bg="rgba(14,165,233,0.15)"
              onPress={() => doGlobalAction('RESTART')}
            />
            <OwnerActionBtn
              icon="notifications"
              label="Notif"
              color="#c084fc"
              bg="rgba(168,85,247,0.2)"
              onPress={() => {
                setCmdCenterVisible(true);
                fetchAdmin();
              }}
            />
            <OwnerActionBtn
              icon="people"
              label="Kick"
              color="#fbbf24"
              bg="rgba(245,158,11,0.15)"
              onPress={clearAllSessions}
              disabled={clearingSessions}
            />
          </ScrollView>
        ) : null}
      </View>
    ),
    [
      banner,
      activeCount,
      offlineCount,
      errorCount,
      isOwner,
      adminData,
      statusFilter,
      searchBarKey,
      onProcessSearchChange,
      doGlobalAction,
      fetchAdmin,
      clearAllSessions,
      clearingSessions,
      t,
    ]
  );

  // --- RENDER GATES ---

  if (!isReady) {
    return (
      <View style={styles.bootScreen}>
        <ActivityIndicator size="large" color="#38bdf8" />
      </View>
    );
  }

  if (forceUpdatePolicy) {
    return <ForceUpdateScreen policy={forceUpdatePolicy} lang={lang} t={t} />;
  }

  if (!isUnlocked) {
    return (
      <LockScreen
        usernameInput={usernameInput}
        setUsernameInput={setUsernameInput}
        passwordInput={passwordInput}
        setPasswordInput={setPasswordInput}
        loginError={loginError}
        loginErrorMsg={loginErrorMsg}
        handleLogin={handleLogin}
        isLoggingIn={isLoggingIn}
        showBiometric={showBioOnLock}
        onBiometric={tryBiometric}
        lang={lang}
        onChangeLang={changeLang}
        t={t}
      />
    );
  }

  const tabPadBottom = BOTTOM_NAV_HEIGHT + Math.max(insets.bottom, 8);
  const safeMainTab = ['radios', 'users', 'chat', 'alerts', 'playlist', 'manage'].includes(
    mainTab
  )
    ? mainTab
    : 'radios';

  return (
    <LinearGradient colors={['#000000', '#0a0a0a', '#111827']} style={styles.container}>
      <SafeAreaView style={styles.flex} edges={['top', 'left', 'right']}>
        <StatusBar
          barStyle="light-content"
          backgroundColor="#000000"
          translucent={IS_ANDROID}
        />

        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerTextBlock}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {safeMainTab === 'chat'
                ? t('tab.chat')
                : safeMainTab === 'alerts'
                  ? t('tab.alerts')
                  : safeMainTab === 'users'
                    ? t('tab.users')
                    : safeMainTab === 'playlist'
                      ? t('tab.playlist')
                      : safeMainTab === 'manage'
                        ? t('tab.manage')
                        : (
                          <>
                            Commander<Text style={{ color: '#f8fafc' }}> PRO</Text>
                          </>
                        )}
            </Text>
            <View style={styles.headerBadgeRow}>
              <View
                style={[
                  styles.connDot,
                  { backgroundColor: connectionOk ? '#10b981' : '#ef4444' },
                ]}
              />
              <Text style={styles.headerSubtitle} numberOfLines={1}>
                {isOwner
                  ? t('header.owner')
                  : appUsername && appUsername !== userRole
                    ? `${appUsername} · ${userRole}`
                    : userRole}
                {appLevel && !isMasterLogin ? ` · ${appLevel}` : ''}
                {latencyMs != null ? ` · ${latencyMs}ms` : ''}
                {!connectionOk ? ` · ${t('header.offline')}` : ''}
                {safeMainTab === 'chat' ? ` · ${t('header.chat')}` : ''}
                {safeMainTab === 'users' ? ` · ${effectiveUsersStation}` : ''}
                {safeMainTab === 'playlist' ? ` · ${effectivePlaylistStation}` : ''}
                {safeMainTab === 'manage' ? ` · ${t('nav.manage')}` : ''}
              </Text>
            </View>
          </View>
          <View style={styles.globalActions}>
            {isOwner ? (
              <TouchableOpacity
                style={[styles.globalBtn, { backgroundColor: 'rgba(168, 85, 247, 0.25)' }]}
                onPress={() => {
                  setCmdCenterVisible(true);
                  fetchAdmin();
                }}
                accessibilityLabel={t('common.cmdCenter')}
                hitSlop={6}
              >
                <Ionicons name="construct" size={18} color="#c084fc" />
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={[styles.globalBtn, { backgroundColor: 'rgba(148, 163, 184, 0.2)' }]}
              onPress={handleLogout}
              accessibilityLabel={t('common.logout')}
              hitSlop={6}
            >
              <Ionicons name="log-out" size={18} color="#94a3b8" />
            </TouchableOpacity>
          </View>
        </View>

        {/* ===== TAB: RADIOS ===== */}
        {safeMainTab === 'radios' ? (
          <View style={styles.tabBody}>
            <SectionList
              style={styles.tabList}
              sections={processSections}
              keyExtractor={processKeyExtractor}
              renderItem={renderProcessItem}
              renderSectionHeader={renderSectionHeader}
              ListHeaderComponent={listHeader}
              stickySectionHeadersEnabled={false}
              extraData={processExtraData}
              {...radiosListPerfProps}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={() => {
                    fetchStatus(true);
                    if (isOwner) fetchAdmin();
                  }}
                  tintColor="#38bdf8"
                  colors={['#38bdf8']}
                />
              }
              contentContainerStyle={[
                styles.tabListContent,
                { paddingBottom: tabPadBottom + 8 },
                groupedData.length === 0 && styles.tabListContentEmpty,
              ]}
              ListEmptyComponent={
                <View style={styles.emptyWrap}>
                  {refreshing || (!statusLoaded && connectionOk) ? (
                    <ActivityIndicator color="#38bdf8" style={{ marginBottom: 12 }} />
                  ) : null}
                  <Text style={styles.emptyText}>
                    {searchQuery || statusFilter !== 'ALL'
                      ? t('process.emptyFilter')
                      : !connectionOk && statusLoaded
                        ? t('process.emptyOffline')
                        : !connectionOk && !statusLoaded
                          ? t('process.emptyConnecting')
                          : !statusLoaded || refreshing
                            ? t('process.loading')
                            : visibleProcesses.length === 0
                              ? t('process.emptyRole')
                              : t('process.empty')}
                  </Text>
                </View>
              }
            />
          </View>
        ) : null}

        {/* ===== TAB: CHAT (Discord replacement) ===== */}
        {safeMainTab === 'chat' ? (
          <View
            style={[
              styles.tabBody,
              { marginBottom: activeChat ? 0 : tabPadBottom },
            ]}
          >
            {activeChat ? (
              // Explicit keyboard lift (not KAV): edge-to-edge Android + iOS both keep
              // the composer fully above the keys so you can always see what you type.
              <View
                style={[
                  styles.flex,
                  keyboardHeight > 0 ? { paddingBottom: keyboardHeight } : null,
                ]}
              >
                <View style={styles.chatThreadHeader}>
                  <TouchableOpacity
                    onPress={closeChatThread}
                    hitSlop={HIT_SLOP_MD}
                    style={styles.chatBackBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Back"
                  >
                    <Ionicons name={IS_IOS ? 'chevron-back' : 'arrow-back'} size={24} color="#38bdf8" />
                  </TouchableOpacity>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.chatThreadTitle} numberOfLines={1}>
                      {activeChat.name || 'Chat'}
                    </Text>
                    <Text style={styles.chatThreadSub} numberOfLines={1}>
                      {activeChat.type === 'public' || activeChat.id === 'public'
                        ? t('chat.public')
                        : `${t('chat.private')} · ${activeChat.peer || activeChat.subtitle || 'DM'}`}
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => fetchChatMessages(activeChat.id, { silent: false })}
                    hitSlop={8}
                  >
                    {chatLoading ? (
                      <ActivityIndicator size="small" color="#94a3b8" />
                    ) : (
                      <Ionicons name="refresh" size={20} color="#94a3b8" />
                    )}
                  </TouchableOpacity>
                </View>

                <FlatList
                  ref={chatListRef}
                  style={[styles.chatMessages, styles.tabList]}
                  data={chatMessages}
                  keyExtractor={(item, index) => item.id || `m-${index}`}
                  contentContainerStyle={[
                    {
                      paddingHorizontal: 10,
                      paddingTop: 10,
                      paddingBottom: 16,
                      flexGrow: chatMessages.length === 0 ? 1 : undefined,
                    },
                    chatMessages.length === 0 && styles.tabListContentEmpty,
                  ]}
                  {...listPerfProps}
                  keyboardShouldPersistTaps="handled"
                  keyboardDismissMode={IS_IOS ? 'interactive' : 'on-drag'}
                  maintainVisibleContentPosition={undefined}
                  onScroll={(e) => {
                    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
                    const pad = 120;
                    chatStickToBottomRef.current =
                      layoutMeasurement.height + contentOffset.y >=
                      contentSize.height - pad;
                  }}
                  scrollEventThrottle={32}
                  onContentSizeChange={() => {
                    if (chatStickToBottomRef.current) {
                      scrollChatToEnd(false);
                    }
                  }}
                  onLayout={() => {
                    if (chatStickToBottomRef.current) {
                      scrollChatToEnd(false);
                    }
                  }}
                  renderItem={renderChatMessage}
                  ListEmptyComponent={
                    <View style={styles.notifyEmpty}>
                      <Ionicons name="chatbubbles-outline" size={40} color="#475569" />
                      <Text style={styles.emptyText}>
                        {chatLoading ? t('chat.loading') : t('chat.empty')}
                      </Text>
                    </View>
                  }
                />

                {chatTypingUsers.length > 0 ? (
                  <Text style={styles.typingBar} numberOfLines={1}>
                    {chatTypingUsers.join(', ')}{' '}
                    {chatTypingUsers.length === 1
                      ? t('chat.typingOne')
                      : t('chat.typingMany')}
                  </Text>
                ) : null}

                {chatEditTarget ? (
                  <View style={styles.editBanner}>
                    <Ionicons name="create-outline" size={16} color="#fbbf24" />
                    <Text style={styles.editBannerText} numberOfLines={1}>
                      {t('chat.placeholderEdit')}
                    </Text>
                    <TouchableOpacity
                      onPress={() => {
                        setChatEditTarget(null);
                        setChatInput('');
                      }}
                      hitSlop={8}
                    >
                      <Ionicons name="close" size={18} color="#94a3b8" />
                    </TouchableOpacity>
                  </View>
                ) : null}

                {pendingImage?.uri ? (
                  <View style={styles.pendingImageRow}>
                    <Image source={{ uri: pendingImage.uri }} style={styles.pendingImageThumb} />
                    <Text style={styles.pendingImageLabel}>Photo prête à envoyer</Text>
                    <TouchableOpacity onPress={() => setPendingImage(null)} hitSlop={8}>
                      <Ionicons name="close-circle" size={22} color="#f87171" />
                    </TouchableOpacity>
                  </View>
                ) : null}

                {/* Composer sits above keyboard via parent paddingBottom = keyboardHeight */}
                <View
                  style={[
                    styles.chatComposer,
                    {
                      paddingBottom:
                        keyboardHeight > 0 ? 8 : Math.max(insets.bottom, 8),
                      paddingTop: 8,
                    },
                  ]}
                >
                  <TouchableOpacity
                    style={styles.chatAttachBtn}
                    onPress={pickChatImage}
                    disabled={!!chatEditTarget || chatSending || !canChatSend}
                    hitSlop={6}
                  >
                    <Ionicons
                      name="image"
                      size={22}
                      color={chatEditTarget || !canChatSend ? '#475569' : '#38bdf8'}
                    />
                  </TouchableOpacity>
                  <TextInput
                    style={styles.chatInput}
                    placeholder={
                      chatEditTarget
                        ? t('chat.placeholderEdit')
                        : activeChat.id === 'public'
                          ? t('chat.placeholderPublic')
                          : t('chat.placeholderDm')
                    }
                    {...darkInputProps}
                    value={chatInput}
                    onChangeText={onChatInputChange}
                    onFocus={onChatInputFocus}
                    multiline
                    maxLength={1500}
                    editable={!chatSending && canChatSend}
                    onSubmitEditing={IS_IOS ? undefined : sendChatMessage}
                    blurOnSubmit={false}
                    textAlignVertical="center"
                    returnKeyType="default"
                  />
                  <TouchableOpacity
                    style={[
                      styles.chatSendBtn,
                      ((!chatInput.trim() && !pendingImage) || chatSending) && { opacity: 0.45 },
                    ]}
                    onPress={sendChatMessage}
                    disabled={(!chatInput.trim() && !pendingImage) || chatSending || !canChatSend}
                  >
                    {chatSending ? (
                      <ActivityIndicator color="#fff" size="small" />
                    ) : (
                      <Ionicons
                        name={chatEditTarget ? 'checkmark' : 'send'}
                        size={18}
                        color="#fff"
                      />
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <FlatList
                style={styles.tabList}
                data={chatChannels}
                keyExtractor={(item) => item.id}
                contentContainerStyle={[
                  { padding: 14, paddingBottom: 24 },
                  chatChannels.length === 0 && styles.tabListContentEmpty,
                ]}
                {...listPerfProps}
                refreshControl={
                  <RefreshControl
                    refreshing={chatLoading}
                    onRefresh={fetchChatChannels}
                    tintColor="#38bdf8"
                    colors={['#38bdf8']}
                  />
                }
                renderItem={({ item }) => (
                  <ChannelRow channel={item} onPress={() => openChatChannel(item)} />
                )}
                ListEmptyComponent={
                  <View style={styles.emptyWrap}>
                    {chatLoading ? (
                      <ActivityIndicator color="#38bdf8" style={{ marginBottom: 12 }} />
                    ) : null}
                    <Text style={styles.emptyText}>
                      {chatLoading
                        ? 'Chargement des salons…'
                        : 'Aucun salon.\nRedémarrez Batch Manager si rien n’apparaît.'}
                    </Text>
                  </View>
                }
              />
            )}
          </View>
        ) : null}

        {/* ===== TAB: ALERTES SYSTÈME ===== */}
        {safeMainTab === 'alerts' ? (
          <View style={[styles.tabBody, { marginBottom: tabPadBottom }]}>
            <View style={styles.alertsHeaderBar}>
              <View style={{ flex: 1 }}>
                <Text style={styles.alertsHeaderTitle}>
                  {t('alerts.title')}
                  {notifyFeed.length ? ` · ${notifyFeed.length}` : ''}
                  {notifyStation !== 'ALL'
                    ? ` · ${String(notifyStation).replace('RADIO', 'R')}`
                    : ` · ${t('alerts.all')}`}
                </Text>
                <Text style={styles.alertsHeaderSub}>
                  {isOwner ? t('alerts.centralOwner') : t('alerts.centralUser')}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.alertsRefreshBtn}
                onPress={() => fetchNotifications({ silent: false })}
                hitSlop={8}
              >
                {notifyLoading ? (
                  <ActivityIndicator size="small" color="#f87171" />
                ) : (
                  <Ionicons name="refresh" size={20} color="#f87171" />
                )}
              </TouchableOpacity>
            </View>

            {/* Station chips: Tous (central) + R1..R5 */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.notifyFilterRow}
              style={styles.notifyFilterScroll}
            >
              <Chip
                label={t('alerts.all')}
                color="#f87171"
                active={notifyStation === 'ALL'}
                onPress={() => setNotifyStation('ALL')}
              />
              {(isOwner
                ? STATION_IDS
                : STATION_IDS.includes(userRole)
                  ? [userRole]
                  : STATION_IDS
              ).map((st) => (
                <Chip
                  key={st}
                  label={st.replace('RADIO', 'R')}
                  color={ROLE_COLORS[st] || '#38bdf8'}
                  active={notifyStation === st}
                  onPress={() => setNotifyStation(st)}
                />
              ))}
            </ScrollView>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.notifyFilterRow}
              style={styles.notifyFilterScroll}
            >
              {NOTIFY_CHAT_FILTER_DEFS.map((f) => (
                <Chip
                  key={f.id}
                  label={t(f.labelKey)}
                  color={f.color}
                  active={notifyFilter === f.id}
                  onPress={() => setNotifyFilter(f.id)}
                />
              ))}
            </ScrollView>

            {isOwner ? (
              <View style={styles.ownerAlertsPanel}>
                <Text style={styles.ownerAlertsPanelTitle}>{t('alerts.ownerTools')}</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.ownerAlertsActions}
                >
                  <TouchableOpacity
                    style={[styles.adminChip, styles.adminChipDanger]}
                    onPress={() => clearFeedByType('all')}
                  >
                    <Ionicons name="trash" size={12} color="#fca5a5" style={{ marginRight: 4 }} />
                    <Text style={styles.adminChipText}>Tout vider</Text>
                  </TouchableOpacity>
                  {['tip', 'song', 'alert', 'status', 'admin', 'system', 'log'].map((typeId) => (
                    <TouchableOpacity
                      key={typeId}
                      style={styles.adminChip}
                      onPress={() => clearFeedByType(typeId)}
                    >
                      <Text style={styles.adminChipText}>
                        {t('alerts.clearType', { type: typeId })}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            ) : null}

            <FlatList
              ref={notifyListRef}
              style={[styles.notifyList, styles.tabList]}
              data={notifyFeed}
              keyExtractor={notifyKeyExtractor}
              contentContainerStyle={[
                {
                  padding: 12,
                  paddingBottom: 28,
                },
                notifyFeed.length === 0 && styles.tabListContentEmpty,
              ]}
              {...listPerfProps}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              renderItem={renderNotifyItem}
              ListEmptyComponent={
                <View style={styles.emptyWrap}>
                  {notifyLoading ? (
                    <ActivityIndicator color="#f87171" style={{ marginBottom: 12 }} />
                  ) : (
                    <Ionicons name="notifications-off-outline" size={40} color="#475569" />
                  )}
                  <Text style={styles.emptyText}>
                    {notifyLoading
                      ? 'Chargement des alertes…'
                      : notifyStation !== 'ALL'
                        ? `Aucune alerte pour ${String(notifyStation).replace('RADIO', 'R')}.\nPasse sur « Tous » pour le feed central.`
                        : 'Aucune alerte pour le moment.\nTips, songs et crashes apparaîtront ici\net restent après redémarrage.'}
                  </Text>
                </View>
              }
              refreshControl={
                <RefreshControl
                  refreshing={notifyLoading}
                  onRefresh={() => fetchNotifications({ silent: false })}
                  tintColor="#f87171"
                  colors={['#f87171']}
                />
              }
            />
          </View>
        ) : null}

        {/* ===== TAB: PLAYLIST AutoDJ (before Gestion) ===== */}
        {safeMainTab === 'playlist' ? (
          <View style={styles.tabBody}>
            {!canPlaylist ? (
              <View style={[styles.emptyWrap, { flex: 1 }]}>
                <Ionicons name="musical-notes-outline" size={40} color="#475569" />
                <Text style={styles.emptyText}>{t('playlist.noAccess')}</Text>
              </View>
            ) : (
              <>
                <View style={styles.playlistHeaderBlock}>
                  <Text style={styles.playlistTitle}>{t('playlist.title')}</Text>
                  <Text style={styles.playlistSubtitle}>
                    {isOwner ? t('playlist.subtitleOwner') : t('playlist.subtitleRadio')}
                  </Text>

                  {isOwner ? (
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.notifyFilterRow}
                      style={styles.notifyFilterScroll}
                    >
                      {STATION_IDS.map((st) => (
                        <Chip
                          key={st}
                          label={st.replace('RADIO', 'R')}
                          color={ROLE_COLORS[st] || '#f472b6'}
                          active={playlistStation === st}
                          onPress={() => switchPlaylistStation(st)}
                        />
                      ))}
                    </ScrollView>
                  ) : (
                    <View style={styles.manageStationLock}>
                      <Ionicons name="radio" size={16} color={ROLE_COLORS[effectivePlaylistStation] || '#f472b6'} />
                      <Text
                        style={[
                          styles.manageStationLockText,
                          { color: ROLE_COLORS[effectivePlaylistStation] || '#f472b6' },
                        ]}
                      >
                        {effectivePlaylistStation}
                      </Text>
                    </View>
                  )}

                  <View style={styles.playlistAddRow}>
                    <TextInput
                      style={styles.playlistAddInput}
                      placeholder={t('playlist.addPlaceholder')}
                      {...darkInputProps}
                      value={playlistQuery}
                      onChangeText={setPlaylistQuery}
                      editable={!playlistAdding && playlistDownload?.status !== 'downloading'}
                      onSubmitEditing={addPlaylistSong}
                      returnKeyType="go"
                    />
                    <TouchableOpacity
                      style={[
                        styles.playlistAddBtn,
                        (playlistAdding ||
                          !playlistQuery.trim() ||
                          playlistDownload?.status === 'downloading') && { opacity: 0.5 },
                      ]}
                      onPress={addPlaylistSong}
                      disabled={
                        playlistAdding ||
                        !playlistQuery.trim() ||
                        playlistDownload?.status === 'downloading'
                      }
                    >
                      {playlistAdding || playlistDownload?.status === 'downloading' ? (
                        <ActivityIndicator color="#000" size="small" />
                      ) : (
                        <Ionicons name="add" size={22} color="#000" />
                      )}
                    </TouchableOpacity>
                  </View>
                  {playlistDownload?.status === 'downloading' ? (
                    <View style={styles.playlistDlBanner}>
                      <ActivityIndicator color="#f472b6" size="small" />
                      <Text style={styles.playlistDlText} numberOfLines={2}>
                        {t('playlist.downloading')}
                        {playlistDownload.query ? ` · ${playlistDownload.query}` : ''}
                      </Text>
                    </View>
                  ) : null}

                  <View style={styles.playlistToolbar}>
                    <Text style={styles.playlistCount}>
                      {playlistLoading
                        ? t('playlist.loading')
                        : `${playlistSongs.length} ${t('playlist.count')} · ${effectivePlaylistStation}`}
                    </Text>
                    <View style={styles.playlistToolbarActions}>
                      <TouchableOpacity
                        onPress={() => fetchPlaylist({ silent: false })}
                        hitSlop={HIT_SLOP_SM}
                        style={styles.playlistToolBtn}
                      >
                        <Ionicons name="refresh" size={18} color="#94a3b8" />
                      </TouchableOpacity>
                      {playlistSongs.length > 0 ? (
                        <TouchableOpacity
                          onPress={clearPlaylistAll}
                          hitSlop={HIT_SLOP_SM}
                          style={[styles.playlistToolBtn, styles.playlistToolBtnDanger]}
                        >
                          <Ionicons name="trash-outline" size={16} color="#fca5a5" />
                          <Text style={styles.playlistToolBtnText}>{t('playlist.clearAll')}</Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  </View>
                </View>

                <FlatList
                  style={styles.tabList}
                  data={playlistSongs}
                  keyExtractor={(item, index) => item.id || item.name || `pl-${index}`}
                  {...listPerfProps}
                  keyboardShouldPersistTaps="handled"
                  keyboardDismissMode="on-drag"
                  refreshControl={
                    <RefreshControl
                      refreshing={playlistLoading}
                      onRefresh={() => fetchPlaylist({ silent: false })}
                      tintColor="#f472b6"
                      colors={['#f472b6']}
                    />
                  }
                  contentContainerStyle={[
                    styles.tabListContent,
                    { paddingBottom: tabPadBottom + 8 },
                    playlistSongs.length === 0 && styles.tabListContentEmpty,
                  ]}
                  ListEmptyComponent={
                    <View style={styles.emptyWrap}>
                      {playlistLoading ? (
                        <ActivityIndicator color="#f472b6" style={{ marginBottom: 12 }} />
                      ) : (
                        <Ionicons
                          name="musical-notes-outline"
                          size={36}
                          color="#475569"
                          style={{ marginBottom: 10 }}
                        />
                      )}
                      <Text style={styles.emptyText}>
                        {playlistLoading ? t('playlist.loading') : t('playlist.empty')}
                      </Text>
                    </View>
                  }
                  renderItem={({ item }) => (
                    <View style={styles.playlistSongRow}>
                      <View style={styles.playlistSongIcon}>
                        <Ionicons name="musical-note" size={18} color="#f472b6" />
                      </View>
                      <View style={styles.playlistSongBody}>
                        <Text style={styles.playlistSongTitle} numberOfLines={2}>
                          {item.title || item.name}
                        </Text>
                        <Text style={styles.playlistSongMeta} numberOfLines={1}>
                          {(item.ext || '').toUpperCase()}
                          {item.size_mb != null ? ` · ${item.size_mb} MB` : ''}
                        </Text>
                      </View>
                      <TouchableOpacity
                        onPress={() => deletePlaylistSong(item)}
                        hitSlop={HIT_SLOP_MD}
                        style={styles.playlistDeleteBtn}
                        accessibilityLabel={t('playlist.deleteTitle')}
                      >
                        <Ionicons name="close-circle" size={24} color="#f87171" />
                      </TouchableOpacity>
                    </View>
                  )}
                />
              </>
            )}
          </View>
        ) : null}

        {/* ===== TAB: MANAGEMENT — app login accounts (not Highrise) ===== */}
        {safeMainTab === 'manage' ? (
          <View style={styles.tabBody}>
            {!canManageAppUsers ? (
              <View style={[styles.emptyWrap, { flex: 1 }]}>
                <Ionicons name="shield-outline" size={40} color="#475569" />
                <Text style={styles.emptyText}>{t('manage.noAccess')}</Text>
              </View>
            ) : (
              <ScrollView
                style={styles.tabList}
                contentContainerStyle={[
                  styles.tabListContent,
                  { paddingBottom: tabPadBottom + 16, paddingTop: 10 },
                ]}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                refreshControl={
                  <RefreshControl
                    refreshing={appUsersLoading}
                    onRefresh={() => fetchAppUsers({ silent: false })}
                    tintColor="#fbbf24"
                    colors={['#fbbf24']}
                  />
                }
              >

                {isOwner ? (
                  <>
                    <Text style={styles.manageFieldLabel}>{t('manage.station')}</Text>
                    <View style={styles.manageRankWrap}>
                      {STATION_IDS.map((st) => {
                        const active = manageStation === st;
                        const col = ROLE_COLORS[st] || '#38bdf8';
                        return (
                          <Pressable
                            key={`ms-${st}`}
                            onPress={() => setManageStation(st)}
                            style={[
                              styles.manageRankChip,
                              active && { backgroundColor: `${col}33`, borderColor: col },
                            ]}
                          >
                            <Text
                              style={[
                                styles.manageRankChipText,
                                active && { color: col },
                              ]}
                            >
                              {st.replace('RADIO', 'R')}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </>
                ) : (
                  <View style={styles.manageStationLock}>
                    <Ionicons
                      name="lock-closed"
                      size={14}
                      color={ROLE_COLORS[userRole] || '#94a3b8'}
                    />
                    <Text
                      style={[
                        styles.manageStationLockText,
                        { color: ROLE_COLORS[userRole] || '#94a3b8' },
                      ]}
                    >
                      {userRole}
                    </Text>
                    <Text style={styles.manageStationLockHint}>
                      {t('manage.subtitleRadio')}
                    </Text>
                  </View>
                )}

                <View style={styles.manageCard}>
                  <Text style={styles.manageCardTitle}>{t('manage.createApp')}</Text>
                  <TextInput
                    style={styles.manageInput}
                    placeholder={t('login.username')}
                    {...darkInputProps}
                    value={manageUsername}
                    onChangeText={setManageUsername}
                    autoCapitalize="none"
                    autoComplete="off"
                  />
                  <Text style={styles.manageFieldLabel}>{t('manage.password')}</Text>
                  <TextInput
                    style={styles.manageInput}
                    placeholder={t('manage.passwordHint')}
                    {...darkInputProps}
                    secureTextEntry
                    value={managePassword}
                    onChangeText={setManagePassword}
                    autoCapitalize="none"
                  />
                  <Text style={styles.manageFieldLabel}>{t('manage.presets')}</Text>
                  <View style={styles.manageRankWrap}>
                    {APP_LEVELS.map((lv) => {
                      const active = manageLevel === lv;
                      const col =
                        lv === 'admin' ? '#fbbf24' : lv === 'operator' ? '#38bdf8' : '#94a3b8';
                      return (
                        <Pressable
                          key={lv}
                          onPress={() => applyManagePreset(lv)}
                          style={[
                            styles.manageRankChip,
                            active && { backgroundColor: `${col}33`, borderColor: col },
                          ]}
                        >
                          <Text
                            style={[
                              styles.manageRankChipText,
                              active && { color: col },
                            ]}
                          >
                            {t(`manage.level.${lv}`)}
                          </Text>
                        </Pressable>
                      );
                    })}
                    {manageLevel === 'custom' ? (
                      <View
                        style={[
                          styles.manageRankChip,
                          { backgroundColor: 'rgba(251,191,36,0.2)', borderColor: '#fbbf24' },
                        ]}
                      >
                        <Text style={[styles.manageRankChipText, { color: '#fbbf24' }]}>
                          {t('manage.level.custom')}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.manageOwnerNote}>{t('manage.levelHelp')}</Text>

                  <Text style={styles.manageFieldLabel}>{t('manage.permissions')}</Text>
                  <View style={styles.managePermGrid}>
                    {APP_PERM_KEYS.map((key) => {
                      const on = managePerms.includes(key);
                      return (
                        <Pressable
                          key={key}
                          onPress={() => toggleManagePerm(key)}
                          style={[styles.managePermRow, on && styles.managePermRowOn]}
                        >
                          <Ionicons
                            name={on ? 'checkbox' : 'square-outline'}
                            size={20}
                            color={on ? '#fbbf24' : '#64748b'}
                          />
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={[styles.managePermTitle, on && { color: '#f8fafc' }]}>
                              {t(`manage.perm.${key}`)}
                            </Text>
                            <Text style={styles.managePermDesc} numberOfLines={2}>
                              {t(`manage.perm.${key}.desc`)}
                            </Text>
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>

                  <TouchableOpacity
                    style={[styles.manageCreateBtn, manageCreating && { opacity: 0.6 }]}
                    onPress={createAppLoginUser}
                    disabled={manageCreating}
                    activeOpacity={0.85}
                  >
                    {manageCreating ? (
                      <ActivityIndicator color="#000" />
                    ) : (
                      <>
                        <Ionicons name="person-add" size={18} color="#000" />
                        <Text style={styles.manageCreateBtnText}>
                          {t('manage.createBtn')}
                        </Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>

                <View style={styles.manageStaffHeader}>
                  <Text style={styles.manageCardTitle}>{t('manage.appUsers')}</Text>
                  <TouchableOpacity
                    onPress={() => fetchAppUsers({ silent: false })}
                    hitSlop={HIT_SLOP_SM}
                  >
                    <Ionicons name="refresh" size={18} color="#94a3b8" />
                  </TouchableOpacity>
                </View>

                {appUsersLoading && appUsersList.length === 0 ? (
                  <ActivityIndicator color="#fbbf24" style={{ marginVertical: 24 }} />
                ) : appUsersList.length === 0 ? (
                  <Text style={styles.emptyText}>{t('manage.emptyApp')}</Text>
                ) : (
                  appUsersList.map((u) => {
                    const col = ROLE_COLORS[u.role] || '#94a3b8';
                    const lvCol =
                      u.level === 'admin'
                        ? '#fbbf24'
                        : u.level === 'operator'
                          ? '#38bdf8'
                          : '#94a3b8';
                    return (
                      <View
                        key={u.id}
                        style={[styles.manageUserRow, !u.active && { opacity: 0.45 }]}
                      >
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.manageUserName} numberOfLines={1}>
                            {u.username}
                          </Text>
                          <Text style={styles.manageUserMeta} numberOfLines={2}>
                            <Text style={{ color: col, fontWeight: '800' }}>{u.role}</Text>
                            {' · '}
                            <Text style={{ color: lvCol }}>{u.level}</Text>
                            {Array.isArray(u.permissions)
                              ? ` · ${u.permissions.length} ${t('manage.permCount')}`
                              : ''}
                            {!u.active ? ` · ${t('manage.disabled')}` : ''}
                          </Text>
                        </View>
                        <TouchableOpacity
                          style={styles.manageMiniBtn}
                          onPress={() => {
                            setManageEditPwdOnly(false);
                            setManageEditUser(u);
                            setManageEditPerms(
                              Array.isArray(u.permissions) && u.permissions.length
                                ? [...u.permissions]
                                : [
                                    ...(APP_LEVEL_PRESETS[u.level] ||
                                      APP_LEVEL_PRESETS.viewer),
                                  ]
                            );
                            setManageEditPassword('');
                          }}
                        >
                          <Ionicons name="shield" size={16} color="#fbbf24" />
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.manageMiniBtn}
                          onPress={() => {
                            setManageEditPwdOnly(true);
                            setManageEditUser(u);
                            setManageEditPerms([]);
                            setManageEditPassword('');
                          }}
                        >
                          <Ionicons name="key" size={16} color="#38bdf8" />
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.manageMiniBtn}
                          onPress={() =>
                            updateAppLoginUser(u, { active: !u.active })
                          }
                        >
                          <Ionicons
                            name={u.active ? 'pause' : 'play'}
                            size={16}
                            color={u.active ? '#f87171' : '#34d399'}
                          />
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.manageMiniBtn}
                          onPress={() => deleteAppLoginUser(u)}
                        >
                          <Ionicons name="trash" size={16} color="#f87171" />
                        </TouchableOpacity>
                      </View>
                    );
                  })
                )}

              </ScrollView>
            )}

            {/* Edit permissions / password — Modal so Save is always visible */}
            <Modal
              animationType="slide"
              transparent
              visible={!!manageEditUser}
              onRequestClose={() => {
                if (manageEditSaving) return;
                setManageEditUser(null);
                setManageEditPerms([]);
                setManageEditPassword('');
                setManageEditPwdOnly(false);
              }}
              statusBarTranslucent={IS_ANDROID}
              presentationStyle={IS_IOS ? 'overFullScreen' : undefined}
            >
              <KeyboardAvoidingView
                behavior={KAV_BEHAVIOR}
                keyboardVerticalOffset={KAV_OFFSET_MODAL}
                style={styles.modalContainer}
              >
                <TouchableOpacity
                  style={styles.modalBackdrop}
                  activeOpacity={1}
                  onPress={() => {
                    if (manageEditSaving) return;
                    setManageEditUser(null);
                    setManageEditPerms([]);
                    setManageEditPassword('');
                    setManageEditPwdOnly(false);
                  }}
                />
                <View
                  style={[
                    styles.sheet,
                    { paddingBottom: Math.max(insets.bottom, 16), maxHeight: '88%' },
                  ]}
                >
                  <View style={styles.sheetHandle} />
                  <View style={styles.terminalHeader}>
                    <View style={{ flex: 1, marginRight: 8 }}>
                      <Text style={styles.terminalTitle}>
                        {manageEditPwdOnly
                          ? t('manage.resetPassword')
                          : t('manage.editPerms')}
                      </Text>
                      <Text style={styles.terminalSub} numberOfLines={1}>
                        {manageEditUser?.username} · {manageEditUser?.role}
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => {
                        if (manageEditSaving) return;
                        setManageEditUser(null);
                        setManageEditPerms([]);
                        setManageEditPassword('');
                        setManageEditPwdOnly(false);
                      }}
                      hitSlop={HIT_SLOP_MD}
                    >
                      <Ionicons name="close" size={24} color="#94a3b8" />
                    </TouchableOpacity>
                  </View>

                  <ScrollView
                    keyboardShouldPersistTaps="handled"
                    contentContainerStyle={{ padding: 14, paddingBottom: 20 }}
                  >
                    {!manageEditPwdOnly ? (
                      <>
                        <Text style={styles.manageFieldLabel}>{t('manage.presets')}</Text>
                        <View style={styles.manageRankWrap}>
                          {APP_LEVELS.map((lv) => (
                            <Pressable
                              key={`ed-${lv}`}
                              onPress={() =>
                                setManageEditPerms([...(APP_LEVEL_PRESETS[lv] || [])])
                              }
                              style={styles.manageRankChip}
                            >
                              <Text style={styles.manageRankChipText}>
                                {t(`manage.level.${lv}`)}
                              </Text>
                            </Pressable>
                          ))}
                        </View>
                        <Text style={styles.manageFieldLabel}>{t('manage.permissions')}</Text>
                        <View style={styles.managePermGrid}>
                          {APP_PERM_KEYS.map((key) => {
                            const on = manageEditPerms.includes(key);
                            return (
                              <Pressable
                                key={`edp-${key}`}
                                onPress={() => {
                                  setManageEditPerms((prev) => {
                                    const s = new Set(prev);
                                    if (s.has(key)) s.delete(key);
                                    else s.add(key);
                                    return APP_PERM_KEYS.filter((k) => s.has(k));
                                  });
                                }}
                                style={[styles.managePermRow, on && styles.managePermRowOn]}
                              >
                                <Ionicons
                                  name={on ? 'checkbox' : 'square-outline'}
                                  size={20}
                                  color={on ? '#fbbf24' : '#64748b'}
                                />
                                <View style={{ flex: 1 }}>
                                  <Text
                                    style={[
                                      styles.managePermTitle,
                                      on && { color: '#f8fafc' },
                                    ]}
                                  >
                                    {t(`manage.perm.${key}`)}
                                  </Text>
                                  <Text style={styles.managePermDesc} numberOfLines={2}>
                                    {t(`manage.perm.${key}.desc`)}
                                  </Text>
                                </View>
                              </Pressable>
                            );
                          })}
                        </View>
                      </>
                    ) : null}

                    <Text style={styles.manageFieldLabel}>{t('manage.password')}</Text>
                    <TextInput
                      style={styles.manageInput}
                      placeholder={
                        manageEditPwdOnly
                          ? t('manage.passwordHint')
                          : t('manage.passwordOptional')
                      }
                      {...darkInputProps}
                      secureTextEntry
                      value={manageEditPassword}
                      onChangeText={setManageEditPassword}
                    />

                    <TouchableOpacity
                      style={[
                        styles.manageCreateBtn,
                        { marginTop: 16 },
                        manageEditSaving && { opacity: 0.6 },
                      ]}
                      onPress={saveManageEdit}
                      disabled={manageEditSaving}
                      activeOpacity={0.85}
                    >
                      {manageEditSaving ? (
                        <ActivityIndicator color="#000" />
                      ) : (
                        <Text style={styles.manageCreateBtnText}>{t('common.save')}</Text>
                      )}
                    </TouchableOpacity>
                  </ScrollView>
                </View>
              </KeyboardAvoidingView>
            </Modal>
          </View>
        ) : null}

        {/* ===== TAB: USERS — search only, edit rank/ban/bank ===== */}
        {safeMainTab === 'users' ? (
          <View style={styles.tabBody}>
            {isOwner ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.usersStationBar}
                contentContainerStyle={styles.usersStationBarInner}
              >
                {STATION_IDS.map((st) => (
                  <Chip
                    key={st}
                    label={st.replace('RADIO', 'R')}
                    active={effectiveUsersStation === st}
                    color={ROLE_COLORS[st] || '#38bdf8'}
                    onPress={() => switchUsersStation(st)}
                  />
                ))}
              </ScrollView>
            ) : null}

            <View style={styles.usersSearchRow}>
              <DebouncedSearchInput
                key={usersSearchBarKey}
                placeholder={t('search.user')}
                onChangeDebounced={onUsersSearchChange}
                debounceMs={USERS_SEARCH_DEBOUNCE_MS}
                containerStyle={styles.usersSearchInner}
                inputStyle={styles.usersSearchInput}
              />
              <TouchableOpacity
                onPress={() => fetchStationUsers({ silent: false })}
                hitSlop={8}
                style={{ marginLeft: 6 }}
                accessibilityLabel={t('search.refresh')}
              >
                <Ionicons name="refresh" size={18} color="#94a3b8" />
              </TouchableOpacity>
            </View>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.usersFilterBar}
              contentContainerStyle={styles.usersFilterBarInner}
            >
              {USER_LIST_FILTER_DEFS.map((f) => (
                <Chip
                  key={f.id}
                  label={t(f.labelKey)}
                  active={usersFilter === f.id}
                  color={f.color}
                  onPress={() => setUsersFilter(f.id)}
                />
              ))}
            </ScrollView>

            <Text style={styles.usersCountLine}>
              {usersLoading
                ? t('users.loading')
                : usersSearching
                  ? `${t('users.searching')} ${filteredUsers.length} ${t('users.results')}`
                  : usersQuery.trim()
                    ? `${filteredUsers.length} ${t('users.results')}`
                    : usersFilter !== 'all'
                      ? `${filteredUsers.length} / ${usersList.length} ${t('users.count')}`
                      : `${usersList.length} ${t('users.count')}`}
            </Text>

            <FlatList
              style={styles.tabList}
              data={filteredUsers}
              keyExtractor={userKeyExtractor}
              extraData={`${effectiveUsersStation}-${usersFilter}-${usersSearching ? 1 : 0}`}
              {...listPerfProps}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              refreshControl={
                <RefreshControl
                  refreshing={usersLoading}
                  onRefresh={() => fetchStationUsers({ silent: false })}
                  tintColor="#a78bfa"
                  colors={['#a78bfa']}
                />
              }
              contentContainerStyle={[
                styles.tabListContent,
                { paddingBottom: tabPadBottom + 8 },
                filteredUsers.length === 0 && styles.tabListContentEmpty,
              ]}
              ListEmptyComponent={
                <View style={styles.emptyWrap}>
                  {usersLoading || usersSearching ? (
                    <ActivityIndicator color="#a78bfa" style={{ marginBottom: 12 }} />
                  ) : (
                    <Ionicons
                      name="search-outline"
                      size={36}
                      color="#475569"
                      style={{ marginBottom: 10 }}
                    />
                  )}
                  <Text style={styles.emptyText}>
                    {usersLoading
                      ? t('users.loadingList')
                      : usersSearching
                        ? t('users.searchingDb')
                        : usersQuery.trim()
                          ? t('users.emptySearch', {
                              q: usersQuery.trim(),
                              station: effectiveUsersStation,
                            })
                          : usersFilter !== 'all'
                            ? t('users.emptyFilter', { station: effectiveUsersStation })
                            : t('users.empty', { station: effectiveUsersStation })}
                  </Text>
                </View>
              }
              renderItem={renderUserItem}
            />
          </View>
        ) : null}

        {/* Fallback if no tab content matched (should never happen) */}
        {!['radios', 'users', 'chat', 'alerts', 'playlist', 'manage'].includes(safeMainTab) ? (
          <View style={[styles.tabBody, styles.emptyWrap]}>
            <Text style={styles.emptyText}>Onglet inconnu — retour Radios…</Text>
            <TouchableOpacity
              style={[styles.loginBtn, { marginTop: 16 }]}
              onPress={() => setMainTab('radios')}
            >
              <Text style={styles.loginBtnText}>Radios</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Bottom navigation — hidden inside an open chat thread so the typing bar is free */}
        {!(safeMainTab === 'chat' && activeChat) ? (
          <View style={[styles.bottomNav, { paddingBottom: Math.max(insets.bottom, 8) }]}>
            <BottomNavItem
              active={safeMainTab === 'radios'}
              icon="radio-outline"
              iconActive="radio"
              color="#38bdf8"
              label={t('nav.radios')}
              onPress={() => switchMainTab('radios')}
            />
            {canUsersTab ? (
              <BottomNavItem
                active={safeMainTab === 'users'}
                icon="people-outline"
                iconActive="people"
                color="#a78bfa"
                label={t('nav.users')}
                onPress={() => switchMainTab('users')}
              />
            ) : null}
            {canChat ? (
              <BottomNavItem
                active={safeMainTab === 'chat'}
                icon="chatbubbles-outline"
                iconActive="chatbubbles"
                color="#34d399"
                label={t('nav.chat')}
                badge={chatUnreadTotal}
                onPress={() => {
                  switchMainTab('chat');
                  fetchChatChannels();
                }}
              />
            ) : null}
            {canAlerts ? (
              <BottomNavItem
                active={safeMainTab === 'alerts'}
                icon="notifications-outline"
                iconActive="notifications"
                color="#f87171"
                label={t('nav.alerts')}
                badge={notifyUnread}
                onPress={() => {
                  switchMainTab('alerts');
                  fetchNotifications({ silent: false });
                }}
              />
            ) : null}
            {canPlaylist ? (
              <BottomNavItem
                active={safeMainTab === 'playlist'}
                icon="musical-notes-outline"
                iconActive="musical-notes"
                color="#f472b6"
                label={t('nav.playlist')}
                onPress={() => {
                  switchMainTab('playlist');
                  fetchPlaylist({ silent: true });
                }}
              />
            ) : null}
            {canManageAppUsers ? (
              <BottomNavItem
                active={safeMainTab === 'manage'}
                icon="shield-outline"
                iconActive="shield-checkmark"
                color="#fbbf24"
                label={t('nav.manage')}
                onPress={() => {
                  switchMainTab('manage');
                  fetchAppUsers({ silent: true });
                }}
              />
            ) : null}
          </View>
        ) : null}

        {/* ===== OWNER COMMAND CENTER ===== */}
        <Modal
          animationType="slide"
          transparent
          visible={cmdCenterVisible && isOwner}
          onRequestClose={() => setCmdCenterVisible(false)}
          statusBarTranslucent={IS_ANDROID}
          presentationStyle={IS_IOS ? 'overFullScreen' : undefined}
        >
          <KeyboardAvoidingView
            behavior={KAV_BEHAVIOR}
            keyboardVerticalOffset={KAV_OFFSET_MODAL}
            style={styles.modalContainer}
          >
            <TouchableOpacity
              style={styles.modalBackdrop}
              activeOpacity={1}
              onPress={() => setCmdCenterVisible(false)}
            />
            <View
              style={[
                styles.sheet,
                styles.cmdCenterSheet,
                { paddingBottom: Math.max(insets.bottom, 12) },
              ]}
            >
              <View style={styles.sheetHandle} />
              <View style={styles.terminalHeader}>
                <View style={styles.headerLeftRow}>
                  <Ionicons name="construct" size={18} color="#c084fc" style={{ marginRight: 8 }} />
                  <Text style={styles.terminalTitle}>Centre de commande</Text>
                </View>
                <TouchableOpacity onPress={() => setCmdCenterVisible(false)} hitSlop={10}>
                  <Ionicons name="close" size={24} color="#94a3b8" />
                </TouchableOpacity>
              </View>

              <ScrollView
                style={styles.flex}
                contentContainerStyle={{ padding: 14, paddingBottom: 40 }}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <Text style={styles.panelTitle}>Vue d’ensemble serveur</Text>
                <View style={styles.statsGrid}>
                  <View style={[styles.statBox, compact && styles.statBoxFull]}>
                    <Text style={styles.statVal}>{adminData?.sessions?.total ?? '—'}</Text>
                    <Text style={styles.statLbl}>Sessions</Text>
                  </View>
                  <View style={[styles.statBox, compact && styles.statBoxFull]}>
                    <Text style={styles.statVal}>{adminData?.devices?.total ?? '—'}</Text>
                    <Text style={styles.statLbl}>Appareils push</Text>
                  </View>
                  <View style={[styles.statBox, compact && styles.statBoxFull]}>
                    <Text style={styles.statVal}>
                      {adminData ? formatUptime(adminData.uptime_sec) : '—'}
                    </Text>
                    <Text style={styles.statLbl}>Uptime API</Text>
                  </View>
                  <View style={[styles.statBox, compact && styles.statBoxFull]}>
                    <Text style={styles.statVal}>
                      {adminData?.processes?.running ?? '—'}/
                      {adminData?.processes?.total ?? '—'}
                    </Text>
                    <Text style={styles.statLbl}>Processus</Text>
                  </View>
                </View>

                {adminData?.devices?.by_role ? (
                  <Text style={styles.metaLine}>
                    Push:{' '}
                    {Object.entries(adminData.devices.by_role)
                      .map(([r, n]) => `${r}:${n}`)
                      .join(' · ')}
                  </Text>
                ) : null}
                {adminData?.version ? (
                  <Text style={styles.metaLine}>API v{adminData.version}</Text>
                ) : null}
                {adminData?.chat ? (
                  <Text style={styles.metaLine}>
                    Chat: {adminData.chat.total_messages ?? 0} msg ·{' '}
                    {adminData.chat.channels ?? 0} salons ·{' '}
                    {adminData.chat.images ?? 0} photos
                  </Text>
                ) : null}
                {adminData?.feed_total != null ? (
                  <Text style={styles.metaLine}>
                    Alertes feed: {adminData.feed_total}
                  </Text>
                ) : null}

                {/* ===== CHAT ADMIN ===== */}
                <Text style={[styles.panelTitle, { marginTop: 18 }]}>💬 Admin chat</Text>
                <Text style={styles.metaLine}>
                  Diffuser un message dans le chat (sans push séparé)
                </Text>
                <TextInput
                  style={[styles.formInput, styles.formTextArea]}
                  placeholder="Message chat (public)…"
                  placeholderTextColor="#64748b"
                  value={chatBroadcastText}
                  onChangeText={setChatBroadcastText}
                  maxLength={1500}
                  multiline
                />
                <View style={styles.bulkRow}>
                  <TouchableOpacity
                    style={[styles.bulkBtn, { backgroundColor: '#0c4a6e' }]}
                    disabled={adminBusy || !chatBroadcastText.trim()}
                    onPress={async () => {
                      const t = chatBroadcastText.trim();
                      if (!t) return;
                      const data = await runAdminAction('chat_broadcast', {
                        text: t,
                        to_public: true,
                        to_dms: false,
                      });
                      if (data) {
                        setChatBroadcastText('');
                        Alert.alert('Chat', `Posté dans ${data.posted ?? 0} salon(s).`);
                      }
                    }}
                  >
                    <Text style={styles.bulkBtnText}>→ Général (public)</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.bulkBtn, { backgroundColor: '#4c1d95' }]}
                    disabled={adminBusy || !chatBroadcastText.trim()}
                    onPress={async () => {
                      const t = chatBroadcastText.trim();
                      if (!t) return;
                      const data = await runAdminAction('chat_broadcast', {
                        text: t,
                        to_public: false,
                        to_dms: true,
                      });
                      if (data) {
                        setChatBroadcastText('');
                        Alert.alert('Chat', `Posté dans ${data.posted ?? 0} DM(s).`);
                      }
                    }}
                  >
                    <Text style={styles.bulkBtnText}>→ Tous les DM privés</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.bulkBtn, { backgroundColor: '#065f46' }]}
                    disabled={adminBusy || !chatBroadcastText.trim()}
                    onPress={async () => {
                      const t = chatBroadcastText.trim();
                      if (!t) return;
                      const data = await runAdminAction('chat_broadcast', {
                        text: t,
                        to_public: true,
                        to_dms: true,
                      });
                      if (data) {
                        setChatBroadcastText('');
                        Alert.alert('Chat', `Posté partout (${data.posted ?? 0}).`);
                      }
                    }}
                  >
                    <Text style={styles.bulkBtnText}>→ Public + tous DM</Text>
                  </TouchableOpacity>
                </View>

                <Text style={[styles.metaLine, { marginTop: 10 }]}>Nettoyer le chat</Text>
                <View style={styles.adminChipRow}>
                  {[
                    { id: 'public', label: 'Vider Général' },
                    { id: 'dm_OWNER_RADIO1', label: 'Vider DM R1' },
                    { id: 'dm_OWNER_RADIO2', label: 'Vider DM R2' },
                    { id: 'dm_OWNER_RADIO3', label: 'Vider DM R3' },
                    { id: 'dm_OWNER_RADIO4', label: 'Vider DM R4' },
                    { id: 'dm_OWNER_RADIO5', label: 'Vider DM R5' },
                  ].map((c) => (
                    <TouchableOpacity
                      key={c.id}
                      style={styles.adminChip}
                      disabled={adminBusy}
                      onPress={() =>
                        runAdminAction(
                          'chat_clear',
                          { channel: c.id },
                          {
                            confirmTitle: 'Vider le salon',
                            confirmMsg: `Supprimer tous les messages de ${c.label} ?`,
                            destructive: true,
                          }
                        )
                      }
                    >
                      <Text style={styles.adminChipText}>{c.label}</Text>
                    </TouchableOpacity>
                  ))}
                  <TouchableOpacity
                    style={[styles.adminChip, styles.adminChipDanger]}
                    disabled={adminBusy}
                    onPress={() =>
                      runAdminAction(
                        'chat_clear',
                        { channel: 'all' },
                        {
                          confirmTitle: 'Tout le chat',
                          confirmMsg:
                            'Supprimer TOUS les messages (public + tous DM) ? Irréversible.',
                          destructive: true,
                        }
                      )
                    }
                  >
                    <Text style={styles.adminChipText}>🗑 Tout le chat</Text>
                  </TouchableOpacity>
                </View>

                {/* ===== MEGA ANNOUNCE ===== */}
                <Text style={[styles.panelTitle, { marginTop: 18 }]}>
                  📣 Super-annonce
                </Text>
                <Text style={styles.metaLine}>
                  Push à tous + message dans le chat public
                </Text>
                <TextInput
                  style={styles.formInput}
                  placeholder="Titre annonce"
                  placeholderTextColor="#64748b"
                  value={announceTitle}
                  onChangeText={setAnnounceTitle}
                  maxLength={80}
                />
                <TextInput
                  style={[styles.formInput, styles.formTextArea]}
                  placeholder="Corps du message…"
                  placeholderTextColor="#64748b"
                  value={announceBody}
                  onChangeText={setAnnounceBody}
                  maxLength={500}
                  multiline
                />
                <TouchableOpacity
                  style={[styles.sendNotifBtn, { backgroundColor: '#b45309' }, adminBusy && { opacity: 0.6 }]}
                  disabled={adminBusy || !announceBody.trim()}
                  onPress={async () => {
                    const title = announceTitle.trim() || '📢 Annonce';
                    const body = announceBody.trim();
                    if (!body) return;
                    const data = await runAdminAction(
                      'announce_all',
                      { title, body, to_dms: false },
                      {
                        confirmTitle: 'Super-annonce',
                        confirmMsg: 'Envoyer push ALL + chat public ?',
                      }
                    );
                    if (data) {
                      setAnnounceTitle('');
                      setAnnounceBody('');
                      Alert.alert(
                        'Annonce',
                        `Push: ${data.push_sent ?? 0} · Chat: ${data.chat_posted ?? 0}`
                      );
                    }
                  }}
                >
                  <Ionicons name="megaphone" size={18} color="#fff" />
                  <Text style={styles.sendNotifText}>Push + Chat public</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.bulkBtn, { backgroundColor: '#7c2d12', marginTop: 8 }]}
                  disabled={adminBusy || !announceBody.trim()}
                  onPress={async () => {
                    const title = announceTitle.trim() || '📢 Annonce';
                    const body = announceBody.trim();
                    if (!body) return;
                    const data = await runAdminAction(
                      'announce_all',
                      { title, body, to_dms: true },
                      {
                        confirmTitle: 'Annonce totale',
                        confirmMsg: 'Push ALL + chat public + TOUS les DM ?',
                        destructive: true,
                      }
                    );
                    if (data) {
                      setAnnounceTitle('');
                      setAnnounceBody('');
                      Alert.alert(
                        'Annonce',
                        `Push: ${data.push_sent ?? 0} · Chat: ${data.chat_posted ?? 0}`
                      );
                    }
                  }}
                >
                  <Text style={styles.bulkBtnText}>Push + Public + tous DM</Text>
                </TouchableOpacity>

                {/* ===== QUICK ADMIN ===== */}
                <Text style={[styles.panelTitle, { marginTop: 18 }]}>⚡ Actions rapides</Text>
                <View style={styles.bulkRow}>
                  <TouchableOpacity
                    style={[styles.bulkBtn, { backgroundColor: '#1e3a5f' }]}
                    disabled={adminBusy}
                    onPress={async () => {
                      const data = await runAdminAction('test_push', {
                        audience: 'OWNER',
                        title: '🔔 Test push',
                        body: 'Si tu vois ça, les notifs marchent.',
                      });
                      if (data) {
                        Alert.alert('Test push', `Envoyé à ${data.sent ?? 0} appareil(s).`);
                      }
                    }}
                  >
                    <Text style={styles.bulkBtnText}>Test push (moi)</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.bulkBtn, { backgroundColor: '#1e3a5f' }]}
                    disabled={adminBusy}
                    onPress={async () => {
                      const data = await runAdminAction('test_push', {
                        audience: 'ALL',
                        title: '🔔 Test push',
                        body: 'Test admin → tous les appareils.',
                      });
                      if (data) {
                        Alert.alert('Test push', `Envoyé à ${data.sent ?? 0} appareil(s).`);
                      }
                    }}
                  >
                    <Text style={styles.bulkBtnText}>Test push (tous)</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.bulkBtn, { backgroundColor: '#7f1d1d' }]}
                    disabled={adminBusy}
                    onPress={() =>
                      runAdminAction(
                        'feed_clear',
                        {},
                        {
                          confirmTitle: 'Vider alertes',
                          confirmMsg: 'Effacer tout l’historique Alertes (feed) ?',
                          destructive: true,
                        }
                      )
                    }
                  >
                    <Text style={styles.bulkBtnText}>Vider feed alertes</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.bulkBtn, { backgroundColor: '#7f1d1d' }]}
                    disabled={adminBusy}
                    onPress={() =>
                      runAdminAction(
                        'devices_clear',
                        {},
                        {
                          confirmTitle: 'Reset push',
                          confirmMsg:
                            'Supprimer tous les tokens Expo ? Les apps devront se reconnecter pour recevoir les push.',
                          destructive: true,
                        }
                      )
                    }
                  >
                    <Text style={styles.bulkBtnText}>Reset tokens push</Text>
                  </TouchableOpacity>
                </View>

                <Text style={[styles.metaLine, { marginTop: 10 }]}>
                  Kick sessions par rôle (vous restez connecté)
                </Text>
                <View style={styles.adminChipRow}>
                  {['RADIO1', 'RADIO2', 'RADIO3', 'RADIO4', 'RADIO5'].map((r) => (
                    <TouchableOpacity
                      key={r}
                      style={styles.adminChip}
                      disabled={adminBusy}
                      onPress={async () => {
                        const data = await runAdminAction(
                          'kick_sessions',
                          { role: r, include_self: false },
                          {
                            confirmTitle: `Kick ${r}`,
                            confirmMsg: `Déconnecter toutes les sessions ${r} ?`,
                            destructive: true,
                          }
                        );
                        if (data) {
                          Alert.alert('Sessions', `${data.cleared ?? 0} session(s) ${r} kick.`);
                        }
                      }}
                    >
                      <Text style={styles.adminChipText}>Kick {r}</Text>
                    </TouchableOpacity>
                  ))}
                  <TouchableOpacity
                    style={[styles.adminChip, styles.adminChipDanger]}
                    disabled={adminBusy}
                    onPress={async () => {
                      const data = await runAdminAction(
                        'kick_sessions',
                        { include_self: false },
                        {
                          confirmTitle: 'Kick tous sauf moi',
                          confirmMsg: 'Déconnecter tout le monde sauf cette session Owner ?',
                          destructive: true,
                        }
                      );
                      if (data) {
                        Alert.alert('Sessions', `${data.cleared ?? 0} session(s) kick.`);
                      }
                    }}
                  >
                    <Text style={styles.adminChipText}>Kick tous sauf moi</Text>
                  </TouchableOpacity>
                </View>

                <Text style={[styles.panelTitle, { marginTop: 18 }]}>
                  📢 Envoyer une notification
                </Text>
                <Text style={styles.metaLine}>Destinataires</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.chipRow}
                >
                  {NOTIFY_AUDIENCES.map((a) => (
                    <Chip
                      key={a}
                      label={a}
                      active={notifyAudience === a}
                      color="#c084fc"
                      onPress={() => setNotifyAudience(a)}
                    />
                  ))}
                </ScrollView>

                <Text style={styles.metaLine}>Presets</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.chipRow}
                >
                  {NOTIFY_PRESETS.map((p) => (
                    <TouchableOpacity
                      key={p.title}
                      style={styles.presetChip}
                      onPress={() => {
                        setNotifyTitle(p.title);
                        setNotifyBody(p.body);
                      }}
                    >
                      <Text style={styles.presetChipText}>{p.title}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>

                <TextInput
                  style={styles.formInput}
                  placeholder="Titre (max 80)"
                  placeholderTextColor="#64748b"
                  value={notifyTitle}
                  onChangeText={setNotifyTitle}
                  maxLength={80}
                />
                <TextInput
                  style={[styles.formInput, styles.formTextArea]}
                  placeholder="Message (max 500)"
                  placeholderTextColor="#64748b"
                  value={notifyBody}
                  onChangeText={setNotifyBody}
                  maxLength={500}
                  multiline
                />
                <TouchableOpacity
                  style={[styles.sendNotifBtn, sendingNotify && { opacity: 0.6 }]}
                  onPress={sendNotification}
                  disabled={sendingNotify}
                >
                  {sendingNotify ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <>
                      <Ionicons name="send" size={18} color="#fff" />
                      <Text style={styles.sendNotifText}>Envoyer à {notifyAudience}</Text>
                    </>
                  )}
                </TouchableOpacity>

                {adminData?.recent_notifications?.length > 0 ? (
                  <>
                    <Text style={[styles.panelTitle, { marginTop: 18 }]}>
                      Historique notifications
                    </Text>
                    {adminData.recent_notifications.slice(0, 8).map((n, i) => (
                      <View key={`${n.ts}-${i}`} style={styles.histRow}>
                        <Text style={styles.histTime}>{formatTime(n.ts)}</Text>
                        <Text style={styles.histMain} numberOfLines={2}>
                          [{n.audience}] {n.title} → {n.sent} app.
                        </Text>
                      </View>
                    ))}
                  </>
                ) : null}

                {adminData?.sessions?.list?.length > 0 ? (
                  <>
                    <Text style={[styles.panelTitle, { marginTop: 18 }]}>Sessions actives</Text>
                    {adminData.sessions.list.map((s, i) => (
                      <View key={`${s.token_suffix}-${i}`} style={styles.histRow}>
                        <Text style={styles.histMain}>
                          {s.role} · …{s.token_suffix} · {s.ip || '?'}
                        </Text>
                        <Text style={styles.histTime}>
                          vu {formatTime(s.last_seen)} · exp {formatTime(s.expires)}
                        </Text>
                      </View>
                    ))}
                    <TouchableOpacity
                      style={styles.dangerBtn}
                      onPress={clearAllSessions}
                      disabled={clearingSessions}
                    >
                      <Ionicons name="log-out" size={16} color="#fff" />
                      <Text style={styles.dangerBtnText}>
                        Révoquer toutes les sessions (moi inclus)
                      </Text>
                    </TouchableOpacity>
                  </>
                ) : null}

                <Text style={[styles.panelTitle, { marginTop: 18 }]}>Préférences</Text>
                <View style={styles.prefRow}>
                  <Text style={styles.prefLabel}>Alertes changement d’état</Text>
                  <Switch
                    value={statusAlerts}
                    onValueChange={toggleAlerts}
                    trackColor={{ false: '#334155', true: '#065f46' }}
                    thumbColor={statusAlerts ? '#10b981' : '#94a3b8'}
                  />
                </View>
                <View style={styles.prefRow}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={styles.prefLabel}>Biométrie au démarrage</Text>
                    {!biometricHardwareOk ? (
                      <Text style={styles.prefHint}>Non disponible sur cet appareil</Text>
                    ) : null}
                  </View>
                  <Switch
                    value={biometricEnabled && biometricHardwareOk}
                    onValueChange={toggleBiometricPref}
                    disabled={!biometricHardwareOk}
                    trackColor={{ false: '#334155', true: '#1e3a5f' }}
                    thumbColor={biometricEnabled ? '#38bdf8' : '#94a3b8'}
                  />
                </View>

                {actionLog.length > 0 ? (
                  <>
                    <Text style={[styles.panelTitle, { marginTop: 18 }]}>
                      Journal d’actions (local)
                    </Text>
                    {actionLog.slice(0, 12).map((line, i) => (
                      <Text key={`${i}-${line.slice(0, 20)}`} style={styles.actionLogLine}>
                        {line}
                      </Text>
                    ))}
                  </>
                ) : null}

                <Text style={[styles.panelTitle, { marginTop: 18 }]}>
                  Actions globales processus
                </Text>
                <View style={styles.bulkRow}>
                  <TouchableOpacity
                    style={[styles.bulkBtn, { backgroundColor: '#065f46' }]}
                    onPress={() => doGlobalAction('START')}
                  >
                    <Text style={styles.bulkBtnText}>START all stopped</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.bulkBtn, { backgroundColor: '#7f1d1d' }]}
                    onPress={() => doGlobalAction('KILL')}
                  >
                    <Text style={styles.bulkBtnText}>KILL all running</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.bulkBtn, { backgroundColor: '#0c4a6e' }]}
                    onPress={() => doGlobalAction('RESTART')}
                  >
                    <Text style={styles.bulkBtnText}>RESTART all running</Text>
                  </TouchableOpacity>
                </View>
              </ScrollView>
            </View>
          </KeyboardAvoidingView>
        </Modal>

        {/* ===== NOTIFICATION CHAT (Discord-style feed) ===== */}
        <Modal
          animationType="slide"
          transparent
          visible={notifyFeedVisible}
          onRequestClose={() => setNotifyFeedVisible(false)}
          statusBarTranslucent={IS_ANDROID}
          presentationStyle={IS_IOS ? 'overFullScreen' : undefined}
        >
          <KeyboardAvoidingView
            behavior={KAV_BEHAVIOR}
            keyboardVerticalOffset={KAV_OFFSET_MODAL}
            style={styles.modalContainer}
          >
            <TouchableOpacity
              style={styles.modalBackdrop}
              activeOpacity={1}
              onPress={() => setNotifyFeedVisible(false)}
            />
            <View
              style={[
                styles.sheet,
                styles.notifySheet,
                { paddingBottom: Math.max(insets.bottom, 10) },
              ]}
            >
              <View style={styles.sheetHandle} />
              <View style={styles.terminalHeader}>
                <View style={[styles.headerLeftRow, { flex: 1, marginRight: 8 }]}>
                  <Ionicons
                    name="chatbubbles"
                    size={18}
                    color="#f87171"
                    style={{ marginRight: 8 }}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.terminalTitle}>Notifications</Text>
                    <Text style={styles.terminalSub}>
                      Alertes · tips · admin · status
                    </Text>
                  </View>
                </View>
                <TouchableOpacity
                  onPress={() => fetchNotifications({ silent: false })}
                  style={{ marginRight: 10 }}
                  hitSlop={8}
                >
                  {notifyLoading ? (
                    <ActivityIndicator size="small" color="#94a3b8" />
                  ) : (
                    <Ionicons name="refresh" size={20} color="#94a3b8" />
                  )}
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setNotifyFeedVisible(false)} hitSlop={8}>
                  <Ionicons name="close" size={24} color="#94a3b8" />
                </TouchableOpacity>
              </View>

              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.notifyFilterRow}
                style={styles.notifyFilterScroll}
              >
                <Chip
                  label={t('alerts.all')}
                  color="#f87171"
                  active={notifyStation === 'ALL'}
                  onPress={() => setNotifyStation('ALL')}
                />
                {(isOwner
                  ? STATION_IDS
                  : STATION_IDS.includes(userRole)
                    ? [userRole]
                    : STATION_IDS
                ).map((st) => (
                  <Chip
                    key={`modal-${st}`}
                    label={st.replace('RADIO', 'R')}
                    color={ROLE_COLORS[st] || '#38bdf8'}
                    active={notifyStation === st}
                    onPress={() => setNotifyStation(st)}
                  />
                ))}
              </ScrollView>

              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.notifyFilterRow}
                style={styles.notifyFilterScroll}
              >
                {NOTIFY_CHAT_FILTER_DEFS.map((f) => (
                  <Chip
                    key={f.id}
                    label={t(f.labelKey)}
                    color={f.color}
                    active={notifyFilter === f.id}
                    onPress={() => setNotifyFilter(f.id)}
                  />
                ))}
              </ScrollView>

              <FlatList
                ref={notifyListRef}
                style={styles.notifyList}
                data={notifyFeed}
                keyExtractor={(item, index) => item.id || `n-${index}-${item.ts}`}
                extraData={`${notifyStation}-${notifyFilter}-${notifyFeed.length}`}
                contentContainerStyle={{ padding: 12, paddingBottom: 28 }}
                renderItem={({ item }) => (
                  <NotifyChatBubble
                    item={item}
                    unread={Number(item.ts) > (notifyLastReadTs || 0)}
                  />
                )}
                ListEmptyComponent={
                  <View style={styles.notifyEmpty}>
                    <Ionicons name="notifications-off-outline" size={40} color="#475569" />
                    <Text style={styles.emptyText}>
                      {notifyLoading
                        ? 'Chargement…'
                        : notifyStation !== 'ALL'
                          ? `Aucune alerte pour ${String(notifyStation).replace('RADIO', 'R')}.`
                          : 'Aucune notification pour le moment.\nLes alertes Discord, crashes et messages admin apparaissent ici.'}
                    </Text>
                  </View>
                }
                refreshControl={
                  <RefreshControl
                    refreshing={notifyLoading}
                    onRefresh={() => fetchNotifications({ silent: false })}
                    tintColor="#f87171"
                    colors={['#f87171']}
                  />
                }
              />
            </View>
          </KeyboardAvoidingView>
        </Modal>

        {/* ===== TERMINAL ===== */}
        <Modal
          animationType="slide"
          transparent
          visible={terminalVisible}
          onRequestClose={closeTerminal}
          statusBarTranslucent={IS_ANDROID}
          presentationStyle={IS_IOS ? 'overFullScreen' : undefined}
        >
          <KeyboardAvoidingView
            behavior={KAV_BEHAVIOR}
            keyboardVerticalOffset={KAV_OFFSET_MODAL}
            style={styles.modalContainer}
          >
            <TouchableOpacity
              style={styles.modalBackdrop}
              activeOpacity={1}
              onPress={closeTerminal}
            />
            <View
              style={[
                styles.sheet,
                styles.terminalSheet,
                { paddingBottom: Math.max(insets.bottom, 10) },
              ]}
            >
              <View style={styles.sheetHandle} />
              <View style={styles.terminalHeader}>
                <View style={[styles.headerLeftRow, { flex: 1, marginRight: 8 }]}>
                  <Ionicons name="terminal" size={18} color="#38bdf8" style={{ marginRight: 8 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.terminalTitle} numberOfLines={1}>
                      {selectedProcess?.name}
                    </Text>
                    <Text style={styles.terminalSub} numberOfLines={1}>
                      {selectedProcess?.id}
                      {selectedProcess?.pid ? ` · PID ${selectedProcess.pid}` : ''}
                    </Text>
                  </View>
                </View>
                <TouchableOpacity
                  onPress={() => selectedProcess && fetchLogs(selectedProcess.id)}
                  style={{ marginRight: 10 }}
                  hitSlop={8}
                >
                  <Ionicons name="refresh" size={20} color="#94a3b8" />
                </TouchableOpacity>
                <TouchableOpacity onPress={closeTerminal} hitSlop={8}>
                  <Ionicons name="close" size={24} color="#94a3b8" />
                </TouchableOpacity>
              </View>

              <View style={styles.consoleArea}>
                <FlatList
                  ref={flatListRef}
                  data={liveLogs}
                  keyExtractor={(item, index) => `log-${index}-${(item.text || '').length}`}
                  renderItem={renderLogItem}
                  {...listPerfProps}
                  initialNumToRender={20}
                  onContentSizeChange={() => {
                    try {
                      flatListRef.current?.scrollToEnd({ animated: false });
                    } catch {
                      /* ignore */
                    }
                  }}
                  ListEmptyComponent={
                    <Text style={styles.logText}>Chargement des logs...</Text>
                  }
                  keyboardShouldPersistTaps="handled"
                />
              </View>

              <View style={styles.commandBar}>
                <Text style={styles.promptChar}>{'>'}</Text>
                <TextInput
                  style={styles.commandInput}
                  placeholder="play titre | play2 url | skip | pause…"
                  {...darkInputProps}
                  value={commandInput}
                  onChangeText={setCommandInput}
                  onSubmitEditing={submitTypedCommand}
                  autoCapitalize="none"
                  editable={!sendingConsole}
                  returnKeyType="send"
                  enablesReturnKeyAutomatically
                />
                <TouchableOpacity
                  style={[styles.sendButton, sendingConsole && { opacity: 0.5 }]}
                  onPress={submitTypedCommand}
                  disabled={sendingConsole}
                  hitSlop={HIT_SLOP_SM}
                  accessibilityRole="button"
                  accessibilityLabel="Send command"
                >
                  <Ionicons name="send" size={16} color="white" />
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>

        {/* ===== BOT ROOM / API KEY (card buttons, edits .bat) ===== */}
        <Modal
          animationType="fade"
          transparent
          visible={!!botConfigModal}
          onRequestClose={closeBotConfigEditor}
          statusBarTranslucent={IS_ANDROID}
          presentationStyle={IS_IOS ? 'overFullScreen' : undefined}
        >
          <KeyboardAvoidingView
            behavior={KAV_BEHAVIOR}
            keyboardVerticalOffset={KAV_OFFSET_MODAL}
            style={styles.modalContainer}
          >
            <TouchableOpacity
              style={styles.modalBackdrop}
              activeOpacity={1}
              onPress={closeBotConfigEditor}
            />
            <View
              style={[
                styles.sheet,
                styles.botConfigSheet,
                { paddingBottom: Math.max(insets.bottom, 16) },
              ]}
            >
              <View style={styles.sheetHandle} />
              <View style={styles.terminalHeader}>
                <View style={{ flex: 1, marginRight: 8 }}>
                  <Text style={styles.terminalTitle}>
                    {botConfigModal?.field === 'room' ? 'Room ID' : 'API key'}
                  </Text>
                  <Text style={styles.terminalSub} numberOfLines={1}>
                    {botConfigModal?.name} · {botConfigModal?.target}
                  </Text>
                </View>
                <TouchableOpacity onPress={closeBotConfigEditor} hitSlop={8}>
                  <Ionicons name="close" size={24} color="#94a3b8" />
                </TouchableOpacity>
              </View>

              <View style={styles.botConfigModalBody}>
                <Text style={styles.botConfigCurrentLabel}>Actuel</Text>
                <Text style={styles.botConfigCurrentValue} selectable numberOfLines={2}>
                  {botConfigModal?.field === 'room'
                    ? botConfigModal?.current || '—'
                    : botConfigModal?.current || '—'}
                </Text>

                <Text style={styles.botConfigCurrentLabel}>
                  {botConfigModal?.field === 'room'
                    ? 'Nouveau room id ou lien'
                    : 'Nouvelle API key'}
                </Text>
                <TextInput
                  style={styles.botConfigInput}
                  value={botConfigModal?.draft ?? ''}
                  onChangeText={(txt) =>
                    setBotConfigModal((m) => (m ? { ...m, draft: txt } : m))
                  }
                  placeholder={
                    botConfigModal?.field === 'room'
                      ? t('room.placeholder')
                      : t('key.placeholder')
                  }
                  {...darkInputProps}
                  autoCapitalize="none"
                  autoFocus
                  multiline={botConfigModal?.field === 'room'}
                  editable={!botConfigSaving}
                  textContentType="none"
                  autoComplete="off"
                />

                <View style={styles.botConfigActions}>
                  <TouchableOpacity
                    style={styles.botConfigCancelBtn}
                    onPress={closeBotConfigEditor}
                    disabled={botConfigSaving}
                  >
                    <Text style={styles.botConfigCancelText}>Annuler</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.botConfigSaveBtn,
                      botConfigSaving && { opacity: 0.6 },
                    ]}
                    onPress={saveBotConfig}
                    disabled={botConfigSaving}
                  >
                    {botConfigSaving ? (
                      <ActivityIndicator color="#000" />
                    ) : (
                      <Text style={styles.botConfigSaveText}>Enregistrer</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>

        {/* ===== STATION USER PROFILE (rank / ban / bank + !userinfo) ===== */}
        <Modal
          animationType="slide"
          transparent
          visible={!!selectedStationUser}
          onRequestClose={closeStationUser}
          statusBarTranslucent={IS_ANDROID}
          presentationStyle={IS_IOS ? 'overFullScreen' : undefined}
        >
          <KeyboardAvoidingView
            behavior={KAV_BEHAVIOR}
            keyboardVerticalOffset={KAV_OFFSET_MODAL}
            style={styles.modalContainer}
          >
            <TouchableOpacity
              style={styles.modalBackdrop}
              activeOpacity={1}
              onPress={closeStationUser}
            />
            <View
              style={[
                styles.sheet,
                styles.userProfileSheet,
                { paddingBottom: Math.max(insets.bottom, 14) },
              ]}
            >
              <View style={styles.sheetHandle} />
              <View style={styles.terminalHeader}>
                <View style={{ flex: 1, marginRight: 8 }}>
                  <Text style={styles.terminalTitle} numberOfLines={1}>
                    @{selectedStationUser?.username}
                  </Text>
                  <Text style={styles.terminalSub} numberOfLines={1}>
                    {selectedStationUser?.station}
                  </Text>
                </View>
                <TouchableOpacity onPress={closeStationUser} hitSlop={8}>
                  <Ionicons name="close" size={24} color="#94a3b8" />
                </TouchableOpacity>
              </View>

              <ScrollView
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={styles.userProfileBody}
              >
                <View style={styles.userInfoGrid}>
                  {[
                    ['Tips (gold)', selectedStationUser?.gold_tipped ?? 0],
                    ['Chansons', selectedStationUser?.songs_played ?? 0],
                    ['Temps en salle', selectedStationUser?.room_time || '0m'],
                    ['Crédit net', selectedStationUser?.net_credit ?? 0],
                    ['Skips', selectedStationUser?.songs_skipped ?? 0],
                    ['Annulations', selectedStationUser?.songs_cancelled ?? 0],
                  ].map(([label, val]) => (
                    <View key={label} style={styles.userInfoCell}>
                      <Text style={styles.userInfoCellLabel}>{label}</Text>
                      <Text style={styles.userInfoCellValue}>{String(val)}</Text>
                    </View>
                  ))}
                </View>

                <Text style={styles.userEditSection}>Rang</Text>
                <View style={styles.userRankGrid}>
                  {USER_RANKS.map((r) => {
                    const active = userEditRank === r;
                    const c = rankColor(r);
                    const locked = !isOwner && OWNER_ONLY_RANKS.has(r);
                    return (
                      <TouchableOpacity
                        key={r}
                        style={[
                          styles.userRankChip,
                          active && { backgroundColor: `${c}33`, borderColor: c },
                          locked && { opacity: 0.35 },
                        ]}
                        onPress={() => {
                          if (locked) {
                            Alert.alert(
                              'Permission',
                              'Seul le OWNER de l’app peut mettre owner ou dev.'
                            );
                            return;
                          }
                          setUserEditRank(r);
                        }}
                        disabled={userEditSaving}
                      >
                        <Text
                          style={[
                            styles.userRankChipText,
                            active && { color: c, fontWeight: '900' },
                          ]}
                        >
                          {RANK_LABELS_FR[r] || r}
                          {locked ? ' 🔒' : ''}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                {!isOwner ? (
                  <Text style={styles.userBanHint}>
                    Owner / Dev = réservé au OWNER de l’app mobile
                  </Text>
                ) : null}

                {(() => {
                  const targetLocked =
                    !isOwner &&
                    OWNER_ONLY_RANKS.has(
                      (selectedStationUser?.rank || '').toLowerCase()
                    );
                  return (
                    <>
                      <View style={styles.userBanRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.userEditSection}>Ban radio</Text>
                          <Text style={styles.userBanHint}>
                            Bloque l’usage radio sur cette station
                          </Text>
                        </View>
                        <Switch
                          value={userEditBanned}
                          onValueChange={setUserEditBanned}
                          disabled={userEditSaving || targetLocked}
                          trackColor={{ false: '#334155', true: '#7f1d1d' }}
                          thumbColor={userEditBanned ? '#f87171' : '#94a3b8'}
                        />
                      </View>

                      <Text style={styles.userEditSection}>Bank (gold)</Text>
                      <TextInput
                        style={styles.botConfigInput}
                        value={userEditBank}
                        onChangeText={setUserEditBank}
                        keyboardType="number-pad"
                        placeholder="0"
                        placeholderTextColor="#4b5563"
                        editable={!userEditSaving && !targetLocked}
                      />

                      {targetLocked ? (
                        <Text style={styles.userBanHint}>
                          Lecture seule : owner/dev — seul le OWNER de l’app peut
                          modifier.
                        </Text>
                      ) : null}

                      <TouchableOpacity
                        style={[
                          styles.userSaveBtn,
                          (userEditSaving || targetLocked) && { opacity: 0.6 },
                        ]}
                        onPress={saveStationUser}
                        disabled={userEditSaving || targetLocked}
                      >
                        {userEditSaving ? (
                          <ActivityIndicator color="#000" />
                        ) : (
                          <Text style={styles.userSaveBtnText}>
                            {targetLocked
                              ? 'Lecture seule'
                              : 'Enregistrer maintenant'}
                          </Text>
                        )}
                      </TouchableOpacity>
                    </>
                  );
                })()}
              </ScrollView>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      </SafeAreaView>
    </LinearGradient>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppInner />
    </SafeAreaProvider>
  );
}

const mono = Platform.OS === 'ios' ? 'Courier' : 'monospace';

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1 },
  /** Fills space between header and absolute bottom nav — prevents height-0 blank tabs */
  tabBody: {
    flex: 1,
    minHeight: 0,
    width: '100%',
  },
  tabList: {
    flex: 1,
    minHeight: 0,
  },
  tabListContent: {
    paddingHorizontal: 14,
  },
  tabListContentEmpty: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  emptyWrap: {
    paddingVertical: 36,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bootScreen: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  forceUpdateScreen: {
    flex: 1,
    backgroundColor: '#05070c',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 28,
  },
  forceUpdateTitle: {
    color: '#f8fafc',
    fontSize: 22,
    fontWeight: '700',
    marginTop: 18,
    textAlign: 'center',
  },
  forceUpdateBody: {
    color: '#94a3b8',
    fontSize: 15,
    lineHeight: 22,
    marginTop: 12,
    textAlign: 'center',
  },
  forceUpdateMeta: {
    color: '#64748b',
    fontSize: 12,
    marginTop: 16,
    textAlign: 'center',
  },
  forceUpdateBtn: {
    marginTop: 24,
    backgroundColor: '#f97316',
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 12,
  },
  forceUpdateBtnText: {
    color: '#0a0a0a',
    fontWeight: '800',
    fontSize: 16,
  },
  forceUpdateHint: {
    color: '#475569',
    fontSize: 11,
    marginTop: 16,
    textAlign: 'center',
  },
  lockScreen: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  lockBody: {
    width: '100%',
    alignItems: 'center',
  },
  langToggleWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 10,
  },
  langToggleLabel: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  langToggleRow: {
    flexDirection: 'row',
    gap: 10,
    backgroundColor: '#0f172a',
    borderRadius: 14,
    padding: 4,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  langChip: {
    minWidth: 56,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  langChipActive: {
    backgroundColor: '#38bdf8',
  },
  langChipText: {
    color: '#94a3b8',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  langChipTextActive: {
    color: '#000',
  },
  lockTitle: { color: 'white', fontSize: 24, fontWeight: '800', marginBottom: 28 },
  lockHint: { color: '#64748b', fontSize: 13, marginBottom: 28 },
  inputContainer: {
    width: '88%',
    maxWidth: 360,
    backgroundColor: '#111827',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#334155',
    paddingHorizontal: 15,
    marginBottom: 14,
  },
  passwordInput: {
    height: 50,
    color: '#f8fafc',
    fontSize: 16,
    fontFamily: mono,
    // Android: avoid odd underline / padding quirks
    paddingVertical: IS_ANDROID ? 8 : 0,
  },
  errorText: { color: '#ef4444', fontSize: 14, fontWeight: 'bold', marginBottom: 12 },
  loginBtn: {
    flexDirection: 'row',
    backgroundColor: '#38bdf8',
    paddingVertical: 14,
    paddingHorizontal: 30,
    borderRadius: 12,
    alignItems: 'center',
    minWidth: 170,
    justifyContent: 'center',
  },
  loginBtnDisabled: { opacity: 0.7 },
  loginBtnText: { color: '#000', fontSize: 16, fontWeight: '900', letterSpacing: 0.5 },
  bioBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 22,
    gap: 8,
    padding: 12,
  },
  bioBtnText: { color: '#38bdf8', fontWeight: '600', fontSize: 14 },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 8,
  },
  headerTextBlock: { flex: 1, marginRight: 10, minWidth: 0 },
  headerTitle: { color: '#38bdf8', fontSize: 22, fontWeight: '900', letterSpacing: -0.5 },
  headerBadgeRow: { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
  connDot: { width: 7, height: 7, borderRadius: 4, marginRight: 6 },
  headerSubtitle: { color: '#94a3b8', fontSize: 11, fontWeight: '600', flexShrink: 1 },
  globalActions: { flexDirection: 'row', gap: 8, flexShrink: 0 },
  globalBtn: {
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#ef4444',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
    borderWidth: 1.5,
    borderColor: '#000',
  },
  badgeText: { color: '#fff', fontSize: 9, fontWeight: '900' },
  headerLeftRow: { flexDirection: 'row', alignItems: 'center' },

  notifySheet: { height: '88%' },
  notifyFilterScroll: { maxHeight: 48, flexGrow: 0, borderBottomWidth: 1, borderBottomColor: '#1f2937' },
  notifyFilterRow: { gap: 8, paddingHorizontal: 12, paddingVertical: 8, alignItems: 'center' },
  notifyList: { flex: 1, backgroundColor: '#0a0a0a' },
  notifyEmpty: { alignItems: 'center', marginTop: 48, paddingHorizontal: 24 },
  notifyBubble: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#27272a',
    borderLeftWidth: 3,
    padding: 12,
    marginBottom: 10,
  },
  notifyBubbleUnread: {
    backgroundColor: 'rgba(248,113,113,0.08)',
    borderColor: 'rgba(248,113,113,0.35)',
  },
  notifyBubbleTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  notifyTypePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  notifyTypePillText: { fontSize: 10, fontWeight: '900', letterSpacing: 0.4 },
  notifyWhen: { color: '#64748b', fontSize: 11, fontWeight: '600' },
  notifyTitle: { color: '#f8fafc', fontSize: 15, fontWeight: '800', marginBottom: 4 },
  notifyBody: { color: '#cbd5e1', fontSize: 13, lineHeight: 19 },
  notifyMetaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8 },
  notifyMeta: { color: '#64748b', fontSize: 10, fontWeight: '600' },
  notifyTopRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  notifyDeleteBtn: {
    backgroundColor: '#b91c1c',
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  alertsHeaderBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1f2937',
    backgroundColor: 'rgba(248,113,113,0.06)',
  },
  alertsHeaderTitle: { color: '#f8fafc', fontSize: 16, fontWeight: '800' },
  alertsHeaderSub: { color: '#94a3b8', fontSize: 11, marginTop: 2 },
  alertsRefreshBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: 'rgba(248,113,113,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ownerAlertsPanel: {
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 4,
    padding: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(168,85,247,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(168,85,247,0.25)',
  },
  ownerAlertsPanelTitle: {
    color: '#c084fc',
    fontSize: 11,
    fontWeight: '800',
    marginBottom: 8,
    letterSpacing: 0.3,
  },
  ownerAlertsActions: { gap: 8, alignItems: 'center', paddingRight: 4 },

  bottomNav: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    backgroundColor: 'rgba(10,10,14,0.97)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#27272a',
    paddingTop: 6,
    paddingHorizontal: 4,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -4 },
        shadowOpacity: 0.35,
        shadowRadius: 8,
      },
      android: { elevation: 12 },
      default: {},
    }),
  },
  bottomNavItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingVertical: 6,
    borderRadius: 12,
  },
  bottomNavLabel: { color: '#64748b', fontSize: 10, fontWeight: '700', letterSpacing: 0.2 },
  bottomNavLabelActive: { color: '#38bdf8' },

  chatTab: { flex: 1, minHeight: 0 },
  channelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#27272a',
    padding: 12,
    marginBottom: 10,
    gap: 12,
  },
  channelIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  channelBody: { flex: 1, minWidth: 0 },
  channelTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  channelName: { color: '#f8fafc', fontSize: 16, fontWeight: '800', flex: 1 },
  channelTime: { color: '#64748b', fontSize: 11 },
  channelPreview: { color: '#94a3b8', fontSize: 13, marginTop: 3 },
  channelSub: { color: '#475569', fontSize: 11, marginTop: 2 },
  channelBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#10b981',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  channelBadgeText: { color: '#fff', fontSize: 11, fontWeight: '900' },

  chatThreadHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#27272a',
    gap: 6,
  },
  chatBackBtn: { padding: 4 },
  chatThreadTitle: { color: '#f8fafc', fontSize: 16, fontWeight: '800' },
  chatThreadSub: { color: '#64748b', fontSize: 11, marginTop: 1 },
  chatMessages: { flex: 1, backgroundColor: '#050505' },
  chatMsgRow: {
    flexDirection: 'row',
    marginBottom: 6,
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
    paddingHorizontal: 2,
  },
  chatMsgRowMine: { justifyContent: 'flex-end' },
  chatAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
    marginBottom: 2,
  },
  chatAvatarSpacer: { width: 34 },
  chatAvatarText: { fontSize: 12, fontWeight: '900' },
  chatBubble: {
    maxWidth: '78%',
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
  },
  chatBubbleMine: {
    backgroundColor: '#0ea5e9',
    borderColor: '#0284c7',
    borderBottomRightRadius: 5,
  },
  chatBubbleOther: {
    backgroundColor: '#1e293b',
    borderColor: '#334155',
    borderBottomLeftRadius: 5,
  },
  chatSender: { fontSize: 12, fontWeight: '900', marginBottom: 3, letterSpacing: 0.2 },
  chatSenderMine: { color: 'rgba(255,255,255,0.9)' },
  chatMsgText: { color: '#e2e8f0', fontSize: 15, lineHeight: 20 },
  chatMsgTextMine: { color: '#fff' },
  chatMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 3,
  },
  chatMetaRowMine: { justifyContent: 'flex-end' },
  chatMsgTime: { color: '#64748b', fontSize: 10 },
  chatMsgTimeMine: { color: 'rgba(255,255,255,0.75)' },
  chatReceipt: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    maxWidth: '70%',
  },
  chatReceiptText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 10,
    fontWeight: '700',
  },
  chatReceiptTextSeen: {
    color: '#bfdbfe',
  },
  chatComposer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 10,
    paddingTop: 6,
    backgroundColor: '#0a0a0c',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#1e293b',
    zIndex: 20,
    elevation: 12,
    minHeight: 48,
  },
  chatAttachBtn: {
    width: 38,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatInput: {
    flex: 1,
    minHeight: 38,
    maxHeight: 110,
    backgroundColor: '#0f172a',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#1e293b',
    color: '#f8fafc',
    paddingHorizontal: 14,
    paddingVertical: 8,
    fontSize: 16,
  },
  chatSendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#0ea5e9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatImage: {
    width: 200,
    height: 200,
    borderRadius: 12,
    marginBottom: 6,
    backgroundColor: '#0f172a',
  },
  chatBubbleDeleted: {
    backgroundColor: 'transparent',
    borderColor: '#334155',
    borderStyle: 'dashed',
  },
  chatDeletedText: {
    color: '#64748b',
    fontSize: 13,
    fontStyle: 'italic',
  },
  typingBar: {
    color: '#94a3b8',
    fontSize: 12,
    fontStyle: 'italic',
    paddingHorizontal: 14,
    paddingVertical: 3,
    backgroundColor: '#0a0a0a',
  },
  editBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: 'rgba(251,191,36,0.12)',
    borderTopWidth: 1,
    borderTopColor: '#78350f',
  },
  editBannerText: { flex: 1, color: '#fbbf24', fontSize: 13, fontWeight: '700' },
  pendingImageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#0f172a',
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
  },
  pendingImageThumb: { width: 44, height: 44, borderRadius: 8 },
  pendingImageLabel: { flex: 1, color: '#94a3b8', fontSize: 13 },

  playlistHeaderBlock: {
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#1f2937',
  },
  playlistTitle: {
    color: '#f472b6',
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: -0.3,
  },
  playlistSubtitle: {
    color: '#94a3b8',
    fontSize: 12,
    marginTop: 4,
    marginBottom: 10,
    lineHeight: 16,
  },
  playlistAddRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  playlistAddInput: {
    flex: 1,
    minHeight: 44,
    backgroundColor: '#111827',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#334155',
    color: '#f8fafc',
    paddingHorizontal: 12,
    fontSize: 15,
    paddingVertical: IS_ANDROID ? 8 : 10,
  },
  playlistAddBtn: {
    width: 46,
    height: 44,
    borderRadius: 12,
    backgroundColor: '#f472b6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playlistDlBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 8,
    padding: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(244,114,182,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(244,114,182,0.35)',
  },
  playlistDlText: { flex: 1, color: '#f9a8d4', fontSize: 12, fontWeight: '600' },
  playlistToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
    marginBottom: 6,
    gap: 8,
  },
  playlistCount: { color: '#94a3b8', fontSize: 12, fontWeight: '700', flex: 1 },
  playlistToolbarActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  playlistToolBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: 'rgba(148,163,184,0.12)',
  },
  playlistToolBtnDanger: {
    backgroundColor: 'rgba(248,113,113,0.12)',
  },
  playlistToolBtnText: { color: '#fca5a5', fontSize: 11, fontWeight: '800' },
  playlistSongRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#27272a',
    paddingVertical: 10,
    paddingHorizontal: 10,
    marginBottom: 8,
    gap: 10,
  },
  playlistSongIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: 'rgba(244,114,182,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playlistSongBody: { flex: 1, minWidth: 0 },
  playlistSongTitle: { color: '#f1f5f9', fontSize: 14, fontWeight: '700' },
  playlistSongMeta: { color: '#64748b', fontSize: 11, marginTop: 2 },
  playlistDeleteBtn: { padding: 4 },

  banner: {
    marginBottom: 10,
    backgroundColor: 'rgba(56,189,248,0.15)',
    borderColor: '#38bdf8',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  bannerWarn: { backgroundColor: 'rgba(245,158,11,0.15)', borderColor: '#f59e0b' },
  bannerOk: { backgroundColor: 'rgba(16,185,129,0.15)', borderColor: '#10b981' },
  bannerText: { color: '#e2e8f0', fontSize: 13, fontWeight: '600' },

  dashboard: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  dashCard: {
    flex: 1,
    minWidth: 0,
    backgroundColor: 'rgba(255,255,255,0.03)',
    paddingVertical: 10,
    paddingHorizontal: 2,
    borderRadius: 12,
    alignItems: 'center',
    borderBottomWidth: 3,
  },
  dashNumber: { color: 'white', fontSize: 17, fontWeight: 'bold' },
  dashLabel: {
    color: '#94a3b8',
    fontSize: 8,
    fontWeight: '800',
    marginTop: 2,
    letterSpacing: 0.4,
  },

  filterScroll: { marginBottom: 8, flexGrow: 0 },
  filterRow: { gap: 8, alignItems: 'center', paddingRight: 4 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#334155',
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  chipText: { color: '#94a3b8', fontSize: 12, fontWeight: '700' },
  chipRow: { gap: 8, paddingVertical: 8, alignItems: 'center' },

  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    paddingHorizontal: 12,
    borderRadius: 12,
    height: 42,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  searchIcon: { marginRight: 8 },
  searchInput: { flex: 1, color: 'white', fontSize: 15, height: '100%', padding: 0 },

  ownerBar: { marginBottom: 6, flexGrow: 0 },
  ownerBarContent: { gap: 8, paddingRight: 4, alignItems: 'center' },
  ownerBarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 10,
    minWidth: 78,
  },
  ownerBarText: { fontSize: 12, fontWeight: '800' },

  sectionHeader: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: 'bold',
    letterSpacing: 2,
    marginTop: 10,
    marginBottom: 8,
    marginLeft: 2,
  },
  emptyText: {
    color: '#64748b',
    textAlign: 'center',
    marginTop: 12,
    fontSize: 15,
    fontStyle: 'italic',
    lineHeight: 22,
    paddingHorizontal: 8,
  },

  card: {
    borderRadius: 16,
    marginBottom: 12,
    borderWidth: 1,
    overflow: 'hidden',
    flexDirection: 'row',
    // Subtle depth without LinearGradient cost
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
      },
      android: { elevation: 2 },
      default: {},
    }),
  },
  cardRunning: { borderColor: '#059669' },
  cardStopped: { borderColor: '#27272a' },
  cardError: { borderColor: '#ea580c' },
  glowBar: { width: 4 },
  cardContent: { flex: 1, padding: 12, paddingLeft: 10, minWidth: 0 },
  cardInfoPressable: { marginBottom: 10 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 5 },
  cardTitle: { color: '#f8fafc', fontSize: 17, fontWeight: '800', flexShrink: 1, minWidth: 0 },
  autoBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: 'rgba(251,191,36,0.15)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  autoBadgeText: { color: '#fbbf24', fontSize: 9, fontWeight: '900' },
  statusBadge: { flexDirection: 'row', alignItems: 'flex-start' },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6, marginTop: 3 },
  statusText: { fontSize: 11, fontFamily: mono, fontWeight: '700', flex: 1, flexShrink: 1 },
  cardHint: { color: '#475569', fontSize: 10, marginTop: 6 },
  actionRow: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 10 },
  iconButton: {
    // ≥44pt touch targets (Apple HIG) / comfortable Android targets
    minWidth: 44,
    minHeight: 44,
    width: 46,
    height: 46,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  botConfigPreview: {
    marginTop: 8,
    gap: 3,
    backgroundColor: 'rgba(0,0,0,0.28)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  botConfigLine: {
    color: '#cbd5e1',
    fontSize: 11,
    fontFamily: mono,
  },
  botConfigLabel: {
    color: '#94a3b8',
    fontWeight: '800',
    fontFamily: Platform.OS === 'ios' ? 'System' : 'sans-serif',
    fontSize: 10,
  },
  botConfigSheet: { maxHeight: '70%' },
  botConfigModalBody: { paddingHorizontal: 16, paddingTop: 8, gap: 8 },
  botConfigCurrentLabel: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  botConfigCurrentValue: {
    color: '#e2e8f0',
    fontSize: 13,
    fontFamily: mono,
    marginBottom: 4,
  },
  botConfigInput: {
    backgroundColor: '#0a0a0a',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    color: '#f8fafc',
    fontFamily: mono,
    fontSize: 13,
    paddingHorizontal: 12,
    paddingVertical: 12,
    minHeight: 48,
    textAlignVertical: 'top',
  },
  botConfigHint: { color: '#64748b', fontSize: 11, lineHeight: 16 },
  botConfigActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 12,
    marginBottom: 4,
  },
  botConfigCancelBtn: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  botConfigCancelText: { color: '#94a3b8', fontWeight: '700' },
  botConfigSaveBtn: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 10,
    backgroundColor: '#38bdf8',
    minWidth: 120,
    alignItems: 'center',
  },
  botConfigSaveText: { color: '#000', fontWeight: '900' },

  usersStationBar: { maxHeight: 48, flexGrow: 0, borderBottomWidth: 1, borderBottomColor: '#1f2937' },
  usersStationBarInner: { gap: 8, paddingHorizontal: 12, paddingVertical: 8, alignItems: 'center' },
  userStationPill: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  userStationPillText: { fontSize: 9, fontWeight: '900' },
  usersSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 12,
    marginTop: 10,
    paddingHorizontal: 10,
    height: 46,
    borderRadius: 14,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#334155',
  },
  usersSearchInner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    height: '100%',
    margin: 0,
    paddingHorizontal: 4,
    backgroundColor: 'transparent',
    borderWidth: 0,
  },
  usersSearchInput: {
    flex: 1,
    color: '#f8fafc',
    fontSize: 15,
    padding: 0,
    fontWeight: '500',
    minWidth: 0,
  },
  usersSearchClear: { paddingHorizontal: 4, justifyContent: 'center' },
  usersFilterBar: { maxHeight: 48, flexGrow: 0 },
  usersFilterBarInner: { gap: 8, paddingHorizontal: 12, paddingVertical: 8, alignItems: 'center' },
  usersCountLine: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 14,
    marginBottom: 6,
  },

  manageStationLock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1f2937',
    flexWrap: 'wrap',
  },
  manageStationLockText: { fontSize: 14, fontWeight: '900', letterSpacing: 0.4 },
  manageStationLockHint: { color: '#64748b', fontSize: 11, flex: 1, minWidth: 120 },
  manageCard: {
    backgroundColor: 'rgba(251,191,36,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.28)',
    borderRadius: 16,
    padding: 14,
    marginBottom: 16,
  },
  manageCardTitle: {
    color: '#fbbf24',
    fontSize: 14,
    fontWeight: '900',
    marginBottom: 10,
    letterSpacing: 0.3,
  },
  manageFieldLabel: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 6,
    marginTop: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  manageInput: {
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 12,
    color: '#f8fafc',
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 12,
    minHeight: 46,
  },
  manageRankWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  manageRankChip: {
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: 'rgba(15,23,42,0.8)',
  },
  manageRankChipText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  manageOwnerNote: {
    color: '#64748b',
    fontSize: 10,
    marginTop: 8,
    fontStyle: 'italic',
  },
  manageBanRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
    marginBottom: 4,
  },
  manageCreateBtn: {
    marginTop: 14,
    backgroundColor: '#fbbf24',
    borderRadius: 12,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  manageCreateBtnText: {
    color: '#000',
    fontSize: 15,
    fontWeight: '900',
  },
  manageStaffHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  manageUserRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: '#27272a',
    borderRadius: 14,
    padding: 12,
    marginBottom: 10,
  },
  manageUserName: { color: '#f8fafc', fontSize: 15, fontWeight: '800' },
  manageUserMeta: { color: '#94a3b8', fontSize: 11, marginTop: 2 },
  manageMiniBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  managePermGrid: { gap: 8, marginTop: 4, marginBottom: 4 },
  managePermRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1f2937',
    backgroundColor: 'rgba(15,23,42,0.6)',
  },
  managePermRowOn: {
    borderColor: 'rgba(251,191,36,0.45)',
    backgroundColor: 'rgba(251,191,36,0.08)',
  },
  managePermTitle: {
    color: '#94a3b8',
    fontSize: 13,
    fontWeight: '800',
  },
  managePermDesc: {
    color: '#64748b',
    fontSize: 10,
    marginTop: 2,
    lineHeight: 14,
  },

  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#27272a',
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 8,
    gap: 8,
  },
  userRowBanned: {
    borderColor: 'rgba(248,113,113,0.45)',
    backgroundColor: 'rgba(127,29,29,0.25)',
  },
  userRowTop: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  userRowName: { color: '#f8fafc', fontSize: 15, fontWeight: '800', flexShrink: 1 },
  userRankPill: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  userRankPillText: { fontSize: 9, fontWeight: '900', letterSpacing: 0.3 },
  userBanPill: {
    backgroundColor: '#7f1d1d',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  userBanPillText: { color: '#fecaca', fontSize: 9, fontWeight: '900' },
  userRowMeta: { color: '#94a3b8', fontSize: 11, fontFamily: mono },
  userProfileSheet: { height: '82%' },
  userProfileBody: { paddingHorizontal: 16, paddingBottom: 24, gap: 6 },
  userInfoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  userInfoCell: {
    width: '48%',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#27272a',
    padding: 10,
  },
  userInfoCellLabel: { color: '#64748b', fontSize: 10, fontWeight: '700', marginBottom: 4 },
  userInfoCellValue: { color: '#f1f5f9', fontSize: 15, fontWeight: '800' },
  userEditSection: {
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: '800',
    marginTop: 10,
    marginBottom: 6,
  },
  userRankGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  userRankChip: {
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  userRankChipText: { color: '#94a3b8', fontSize: 12, fontWeight: '700' },
  userBanRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    gap: 12,
  },
  userBanHint: { color: '#64748b', fontSize: 11, marginTop: 2 },
  userSaveBtn: {
    marginTop: 16,
    backgroundColor: '#a78bfa',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  userSaveBtnText: { color: '#000', fontWeight: '900', fontSize: 14 },

  modalContainer: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.62)',
  },
  sheet: {
    backgroundColor: '#111111',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: '#27272a',
    overflow: 'hidden',
  },
  terminalSheet: { height: '72%' },
  cmdCenterSheet: { height: '90%' },
  // notifySheet defined above near badge styles
  sheetHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#3f3f46',
    marginTop: 8,
    marginBottom: 2,
  },
  terminalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#27272a',
  },
  terminalTitle: { color: '#f8fafc', fontSize: 16, fontWeight: 'bold' },
  terminalSub: { color: '#64748b', fontSize: 11, marginTop: 2 },
  consoleArea: { flex: 1, backgroundColor: '#050505', padding: 10 },
  logText: { fontFamily: mono, fontSize: 12, marginBottom: 4 },
  commandBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#18181b',
    borderTopWidth: 1,
    borderTopColor: '#27272a',
  },
  promptChar: { color: '#10b981', marginRight: 5, fontWeight: 'bold' },
  commandInput: {
    flex: 1,
    color: '#10b981',
    fontFamily: mono,
    fontSize: 14,
    height: 40,
    padding: 0,
  },
  sendButton: {
    backgroundColor: '#38bdf8',
    width: 40,
    height: 40,
    borderRadius: 8,
    marginLeft: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },

  panelTitle: { color: '#e2e8f0', fontSize: 15, fontWeight: '800', marginBottom: 8 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  statBox: {
    width: '48%',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#27272a',
  },
  statBoxFull: { width: '48%' },
  statVal: { color: '#f8fafc', fontSize: 18, fontWeight: '800' },
  statLbl: { color: '#64748b', fontSize: 11, marginTop: 4, fontWeight: '600' },
  metaLine: { color: '#94a3b8', fontSize: 11, marginTop: 6 },

  formInput: {
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    color: '#f8fafc',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    marginBottom: 8,
  },
  formTextArea: { minHeight: 84, textAlignVertical: 'top' },
  presetChip: {
    backgroundColor: 'rgba(192,132,252,0.12)',
    borderColor: '#7c3aed',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  presetChipText: { color: '#c084fc', fontSize: 12, fontWeight: '700' },
  sendNotifBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#7c3aed',
    paddingVertical: 14,
    borderRadius: 12,
    marginTop: 4,
  },
  sendNotifText: { color: '#fff', fontWeight: '800', fontSize: 15 },

  histRow: {
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1f2937',
  },
  histTime: { color: '#64748b', fontSize: 10 },
  histMain: { color: '#cbd5e1', fontSize: 12, marginTop: 2 },

  dangerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#b45309',
    paddingVertical: 12,
    borderRadius: 10,
    marginTop: 12,
  },
  dangerBtnText: { color: '#fff', fontWeight: '800', fontSize: 13, flexShrink: 1 },

  prefRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1f2937',
  },
  prefLabel: { color: '#e2e8f0', fontSize: 14 },
  prefHint: { color: '#64748b', fontSize: 11, marginTop: 2 },

  actionLogLine: {
    color: '#94a3b8',
    fontSize: 11,
    fontFamily: mono,
    marginBottom: 3,
  },

  bulkRow: { gap: 8, marginTop: 4 },
  bulkBtn: {
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  bulkBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },

  adminChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  adminChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(56,189,248,0.12)',
    borderColor: '#0ea5e9',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  adminChipDanger: {
    backgroundColor: 'rgba(239,68,68,0.15)',
    borderColor: '#ef4444',
  },
  adminChipText: { color: '#e2e8f0', fontSize: 12, fontWeight: '700' },
});
