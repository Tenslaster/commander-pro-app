/**
 * Android background notification poll (no FCM required).
 * TaskManager.defineTask MUST load before App mounts (import from index.js).
 *
 * How it works:
 * - OS wakes the app periodically (BackgroundFetch, often ~15 min on Android)
 * - We pull /api/notifications with the saved session token
 * - New items → local OS notifications (works in background without FCM)
 *
 * True instant push still needs FCM on EAS; this is the practical bypass.
 */
import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

export const BG_NOTIFY_TASK = 'COMMANDER_PRO_BG_NOTIFY';
const SESSION_TOKEN_KEY = 'session_token';
const BG_LAST_TS_KEY = 'bg_notify_last_ts';
const API_URL = (
  process.env.EXPO_PUBLIC_API_URL || 'https://crew.kingdom.forum/api'
).replace(/\/+$/, '');
const APP_VERSION = '1.3.2';
const CHANNEL = 'commander-pro';

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
  const token = await SecureStore.getItemAsync(SESSION_TOKEN_KEY);
  if (!token) {
    return BackgroundFetch.BackgroundFetchResult.NoData;
  }

  const lastRaw = (await SecureStore.getItemAsync(BG_LAST_TS_KEY)) || '0';
  const lastTs = parseFloat(lastRaw) || 0;

  const res = await fetch(`${API_URL}/notifications?limit=30`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: token,
      'X-App-Version': APP_VERSION,
      'User-Agent': `CommanderPRO/${APP_VERSION} (BackgroundFetch; ${Platform.OS})`,
    },
  });

  if (res.status === 401 || res.status === 426) {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
  if (!res.ok) {
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

  const maxTs = Math.max(
    lastTs,
    ...items.map((it) => Number(it.ts) || 0)
  );
  await SecureStore.setItemAsync(BG_LAST_TS_KEY, String(maxTs));

  if (fresh.length === 0) {
    return BackgroundFetch.BackgroundFetchResult.NoData;
  }

  await ensureAndroidChannel();
  // Cap to avoid spam if many queued
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
 * Register periodic background poll (Android APK mainly; iOS is more limited).
 */
export async function startBackgroundNotifyFetch() {
  try {
    await ensureAndroidChannel();
    // Prefer ~2 min minimum request; OS may throttle (often ~15 min)
    await BackgroundFetch.setMinimumIntervalAsync(120);

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
        minimumInterval: 120,
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
