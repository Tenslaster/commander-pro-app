/**
 * Background notification poll without remote push credentials.
 * TaskManager.defineTask MUST load before App mounts (import from index.js).
 *
 * How it works:
 * - OS wakes the app periodically (BackgroundFetch; often ~15 min, iOS more aggressive)
 * - We pull /api/notifications with the saved session token
 * - New items → local OS notifications
 *
 * Instant remote push still needs:
 *   Android: FCM on EAS  |  iOS: Apple Developer + APNs key on EAS
 * This path is the fallback when those are missing (e.g. no Apple Dev account).
 */
import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { APP_VERSION, DEFAULT_API_URL } from './appConfig';

export const BG_NOTIFY_TASK = 'COMMANDER_PRO_BG_NOTIFY';
const SESSION_TOKEN_KEY = 'session_token';
const BG_LAST_TS_KEY = 'bg_notify_last_ts';
const API_URL = (process.env.EXPO_PUBLIC_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
const CHANNEL = 'commander-pro';
let _bgInflight = null;

async function ensureAndroidChannel() {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync(CHANNEL, {
      name: 'Commander PRO',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#f97316',
      sound: 'default',
      enableVibrate: true,
      showBadge: true,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  } catch {
    /* ignore */
  }
}

async function fetchAndNotify() {
  if (_bgInflight) return _bgInflight;
  _bgInflight = _fetchAndNotifyOnce().finally(() => {
    _bgInflight = null;
  });
  return _bgInflight;
}

async function _fetchAndNotifyOnce() {
  const token = await SecureStore.getItemAsync(SESSION_TOKEN_KEY);
  if (!token) {
    return BackgroundFetch.BackgroundFetchResult.NoData;
  }

  const lastRaw = (await SecureStore.getItemAsync(BG_LAST_TS_KEY)) || '0';
  const lastTs = parseFloat(lastRaw) || 0;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer =
    controller &&
    setTimeout(() => {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    }, 12000);
  let res;
  try {
    res = await fetch(`${API_URL}/notifications?limit=20`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: token,
        'X-App-Version': APP_VERSION,
        'User-Agent': `CommanderPRO/${APP_VERSION} (BackgroundFetch; ${Platform.OS})`,
      },
      signal: controller?.signal,
    });
  } catch {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!res || !res.ok || res.status === 401 || res.status === 426) {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }

  const data = await res.json();
  const items = Array.isArray(data?.items) ? data.items : [];
  if (items.length === 0) {
    return BackgroundFetch.BackgroundFetchResult.NoData;
  }

  // items usually newest-first
  const fresh = items
    .filter((it) => it && Number(it.ts) > lastTs)
    .sort((a, b) => Number(a.ts) - Number(b.ts));

  if (fresh.length === 0) {
    const quietMax = Math.max(lastTs, ...items.map((it) => Number(it.ts) || 0));
    if (quietMax > lastTs) {
      await SecureStore.setItemAsync(BG_LAST_TS_KEY, String(quietMax));
    }
    return BackgroundFetch.BackgroundFetchResult.NoData;
  }

  await ensureAndroidChannel();
  const batch = fresh.slice(-8);
  for (const it of batch) {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: String(it.title || 'Commander PRO').slice(0, 80),
        body: String(it.body || it.title || '').slice(0, 240),
        sound: true,
        data: {
          id: it.id,
          kind: it.type || 'alert',
          source: 'background-fetch',
        },
        ...(Platform.OS === 'android' ? { channelId: CHANNEL } : {}),
      },
      trigger: null,
    });
  }

  const maxTs = Math.max(
    lastTs,
    ...batch.map((it) => Number(it.ts) || 0)
  );
  await SecureStore.setItemAsync(BG_LAST_TS_KEY, String(maxTs));

  return BackgroundFetch.BackgroundFetchResult.NewData;
}

// Define once at module load (required by TaskManager)
if (!TaskManager.isTaskDefined(BG_NOTIFY_TASK)) {
  TaskManager.defineTask(BG_NOTIFY_TASK, async () => {
    try {
      return await fetchAndNotify();
    } catch (e) {
      console.warn('BG notify task error', e?.message || e);
      return BackgroundFetch.BackgroundFetchResult.Failed;
    }
  });
}

/**
 * Register periodic background poll (Android + iOS).
 * iOS requires "Background App Refresh" enabled for the app; OS still throttles hard.
 */
export async function startBackgroundNotifyFetch() {
  try {
    await ensureAndroidChannel();
    // 1.3.4: request sensible wakeups; OS still throttles (often 15+ min)
    const minInterval = Platform.OS === 'ios' ? 120 : 180;
    await BackgroundFetch.setMinimumIntervalAsync(minInterval);

    const status = await BackgroundFetch.getStatusAsync();
    if (
      status === BackgroundFetch.BackgroundFetchStatus.Restricted ||
      status === BackgroundFetch.BackgroundFetchStatus.Denied
    ) {
      console.warn('BackgroundFetch restricted/denied', status);
      return false;
    }

    const isRegistered = await TaskManager.isTaskRegisteredAsync(BG_NOTIFY_TASK);
    if (!isRegistered) {
      await BackgroundFetch.registerTaskAsync(BG_NOTIFY_TASK, {
        minimumInterval: minInterval,
        stopOnTerminate: false,
        startOnBoot: true,
      });
    }
    return true;
  } catch (e) {
    console.warn('startBackgroundNotifyFetch failed', e?.message || e);
    return false;
  }
}

export async function stopBackgroundNotifyFetch() {
  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(BG_NOTIFY_TASK);
    if (isRegistered) {
      await BackgroundFetch.unregisterTaskAsync(BG_NOTIFY_TASK);
    }
  } catch (e) {
    console.warn('stopBackgroundNotifyFetch failed', e?.message || e);
  }
}

/** Call once when leaving foreground to catch alerts while process still alive */
export async function pollNotifyOnceInBackground() {
  try {
    return await fetchAndNotify();
  } catch {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
}
