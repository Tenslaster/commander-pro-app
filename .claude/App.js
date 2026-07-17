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
} from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Notifications from 'expo-notifications';
import * as LocalAuthentication from 'expo-local-authentication';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

const API_URL = (process.env.EXPO_PUBLIC_API_URL || '').replace(/\/+$/, '');

const SESSION_TOKEN_KEY = 'session_token';
const SESSION_ROLE_KEY = 'session_role';
const BIOMETRIC_KEY = 'biometric_enabled';
const ALERTS_KEY = 'status_alerts_enabled';

const POLL_STATUS_MS = 3000;
const POLL_LOGS_MS = 2000;
const POLL_ADMIN_MS = 10000;
const COMMAND_REFRESH_MS = 1000;
const LOG_REFRESH_AFTER_CMD_MS = 500;

const NOTIFY_AUDIENCES = ['ALL', 'OWNER', 'RADIO1', 'RADIO2', 'RADIO3', 'RADIO4', 'RADIO5'];
const STATUS_FILTERS = [
  { id: 'ALL', label: 'Tous' },
  { id: 'RUNNING', label: 'En ligne' },
  { id: 'STOPPED', label: 'Hors ligne' },
  { id: 'BOTS', label: 'Bots' },
  { id: 'MAINS', label: 'Radios' },
];

const NOTIFY_PRESETS = [
  { title: '🛠️ Maintenance', body: 'Maintenance en cours. Merci de patienter.' },
  { title: '⚠️ Alerte système', body: 'Incident détecté — intervention en cours.' },
  { title: '✅ Système OK', body: 'Tous les services sont rétablis.' },
  { title: '🔄 Redémarrage', body: 'Redémarrage planifié dans quelques minutes.' },
  { title: '📢 Annonce', body: "Message important de l'administrateur." },
];

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

async function apiFetch(path, { method = 'GET', token, body, signal } = {}) {
  if (!API_URL) {
    const err = new Error('API_URL manquant (EXPO_PUBLIC_API_URL).');
    err.code = 'CONFIG';
    throw err;
  }

  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (networkErr) {
    const err = new Error('Serveur injoignable');
    err.code = 'NETWORK';
    err.cause = networkErr;
    throw err;
  }

  if (response.status === 401) {
    const err = new Error('Session expirée');
    err.code = 'UNAUTHORIZED';
    throw err;
  }
  if (response.status === 403) {
    const err = new Error('Action non autorisée');
    err.code = 'FORBIDDEN';
    throw err;
  }
  if (response.status === 429) {
    const err = new Error('Trop de tentatives');
    err.code = 'RATE_LIMIT';
    throw err;
  }

  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    const detail =
      parsed && typeof parsed === 'object' && parsed.error ? ` — ${parsed.error}` : '';
    const err = new Error(`Erreur réseau (${response.status})${detail}`);
    err.code = 'HTTP';
    err.status = response.status;
    throw err;
  }

  return parsed;
}

// --- SUB-COMPONENTS ---

const Chip = React.memo(({ label, active, onPress, color = '#38bdf8' }) => (
  <TouchableOpacity
    onPress={onPress}
    activeOpacity={0.75}
    style={[styles.chip, active && { backgroundColor: `${color}33`, borderColor: color }]}
    hitSlop={{ top: 4, bottom: 4, left: 2, right: 2 }}
  >
    <Text style={[styles.chipText, active && { color }]} numberOfLines={1}>
      {label}
    </Text>
  </TouchableOpacity>
));

const LockScreen = ({
  passwordInput,
  setPasswordInput,
  loginError,
  handleLogin,
  isLoggingIn,
  showBiometric,
  onBiometric,
}) => {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.lockScreen, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 20 }]}>
      <StatusBar barStyle="light-content" />
      <Ionicons
        name="lock-closed"
        size={56}
        color={loginError ? '#ef4444' : '#38bdf8'}
        style={{ marginBottom: 16 }}
      />
      <Text style={styles.lockTitle}>Accès Sécurisé</Text>
      <Text style={styles.lockHint}>Commander PRO</Text>

      <View style={styles.inputContainer}>
        <TextInput
          style={styles.passwordInput}
          placeholder="Mot de passe système..."
          placeholderTextColor="#64748b"
          secureTextEntry
          value={passwordInput}
          onChangeText={setPasswordInput}
          onSubmitEditing={handleLogin}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isLoggingIn}
          returnKeyType="go"
          textContentType="password"
        />
      </View>

      {loginError ? <Text style={styles.errorText}>Accès refusé.</Text> : null}

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
            <Text style={styles.loginBtnText}>Connexion</Text>
            <Ionicons name="arrow-forward" size={18} color="#000000" style={{ marginLeft: 8 }} />
          </>
        )}
      </TouchableOpacity>

      {showBiometric ? (
        <TouchableOpacity style={styles.bioBtn} onPress={onBiometric} activeOpacity={0.8}>
          <Ionicons name="finger-print" size={22} color="#38bdf8" />
          <Text style={styles.bioBtnText}>Déverrouiller (biométrie)</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
};

/** Action buttons are OUTSIDE the card press target so taps never open terminal by mistake. */
const ProcessCard = React.memo(({ item, onOpenTerminal, onSendCommand, onLongPress }) => {
  const isRunning = item.status === 'RUNNING';
  const isError = item.status === 'ERROR';
  // ERROR / STOPPED → can start; RUNNING / ERROR → can restart; RUNNING only → kill
  const canStart = !isRunning;
  const canKill = isRunning;
  const canRestart = isRunning || isError;

  const statusColor = isRunning ? '#34d399' : isError ? '#fb923c' : '#f87171';
  const statusLabel = isRunning ? 'En ligne' : isError ? 'Erreur' : 'Hors ligne';

  return (
    <LinearGradient
      colors={
        isRunning
          ? ['#064e3b', '#022c22']
          : isError
            ? ['#450a0a', '#1c1917']
            : ['#18181b', '#09090b']
      }
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[
        styles.card,
        isRunning ? styles.cardRunning : isError ? styles.cardError : styles.cardStopped,
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
          onPress={() => onOpenTerminal(item)}
          onLongPress={() => onLongPress?.(item)}
          delayLongPress={380}
          style={styles.cardInfoPressable}
        >
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardTitle} numberOfLines={1}>
              {item.name}
            </Text>
            {item.auto_restart ? (
              <View style={styles.autoBadge}>
                <Ionicons name="flash" size={10} color="#fbbf24" />
                <Text style={styles.autoBadgeText}>AUTO</Text>
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
          <Text style={styles.cardHint}>Toucher = terminal · Appui long = menu</Text>
        </TouchableOpacity>

        <View style={styles.actionRow}>
          <TouchableOpacity
            style={[styles.iconButton, { backgroundColor: canStart ? '#10b981' : 'rgba(255,255,255,0.06)' }]}
            disabled={!canStart}
            onPress={() => onSendCommand(item.id, 'START')}
            accessibilityLabel={`Démarrer ${item.name}`}
            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
          >
            <Ionicons name="play" size={20} color={canStart ? '#fff' : '#4b5563'} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.iconButton, { backgroundColor: canKill ? '#ef4444' : 'rgba(255,255,255,0.06)' }]}
            disabled={!canKill}
            onPress={() => onSendCommand(item.id, 'KILL')}
            accessibilityLabel={`Arrêter ${item.name}`}
            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
          >
            <Ionicons name="square" size={18} color={canKill ? '#fff' : '#4b5563'} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.iconButton, { backgroundColor: canRestart ? '#0ea5e9' : 'rgba(255,255,255,0.06)' }]}
            disabled={!canRestart}
            onPress={() => onSendCommand(item.id, 'RESTART')}
            accessibilityLabel={`Redémarrer ${item.name}`}
            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
          >
            <Ionicons name="refresh" size={20} color={canRestart ? '#fff' : '#4b5563'} />
          </TouchableOpacity>
        </View>
      </View>
    </LinearGradient>
  );
});

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

  const [passwordInput, setPasswordInput] = useState('');
  const [loginError, setLoginError] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [userRole, setUserRole] = useState(null);
  const [authToken, setAuthToken] = useState(null);
  const [isReady, setIsReady] = useState(false);
  const [biometricGate, setBiometricGate] = useState(false);
  const [biometricHardwareOk, setBiometricHardwareOk] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);

  const [processes, setProcesses] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [clearingSessions, setClearingSessions] = useState(false);

  const [connectionOk, setConnectionOk] = useState(true);
  const [latencyMs, setLatencyMs] = useState(null);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [statusAlerts, setStatusAlerts] = useState(true);
  const [banner, setBanner] = useState(null);

  const [terminalVisible, setTerminalVisible] = useState(false);
  const [selectedProcess, setSelectedProcess] = useState(null);
  const [liveLogs, setLiveLogs] = useState([]);
  const [commandInput, setCommandInput] = useState('');
  const [sendingConsole, setSendingConsole] = useState(false);

  const [cmdCenterVisible, setCmdCenterVisible] = useState(false);
  const [adminData, setAdminData] = useState(null);
  const [notifyAudience, setNotifyAudience] = useState('ALL');
  const [notifyTitle, setNotifyTitle] = useState('');
  const [notifyBody, setNotifyBody] = useState('');
  const [sendingNotify, setSendingNotify] = useState(false);
  const [actionLog, setActionLog] = useState([]);

  const flatListRef = useRef(null);
  const authTokenRef = useRef(null);
  const userRoleRef = useRef(null);
  const mountedRef = useRef(true);
  const prevStatusRef = useRef({});
  const prevStatusReadyRef = useRef(false);
  const pendingSessionRef = useRef(null);
  const statusAlertsRef = useRef(true);
  const bannerTimerRef = useRef(null);
  const commandTimersRef = useRef([]);

  useEffect(() => {
    authTokenRef.current = authToken;
  }, [authToken]);

  useEffect(() => {
    userRoleRef.current = userRole;
  }, [userRole]);

  useEffect(() => {
    statusAlertsRef.current = statusAlerts;
  }, [statusAlerts]);

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
    const id = setTimeout(fn, ms);
    commandTimersRef.current.push(id);
    return id;
  }, []);

  // --- SESSION ---

  const handleLogout = useCallback(async () => {
    try {
      await SecureStore.deleteItemAsync(SESSION_TOKEN_KEY);
      await SecureStore.deleteItemAsync(SESSION_ROLE_KEY);
    } catch (e) {
      console.warn('Failed to clear secure session', e);
    }
    if (!mountedRef.current) return;
    setAuthToken(null);
    setUserRole(null);
    setProcesses([]);
    setTerminalVisible(false);
    setCmdCenterVisible(false);
    setSelectedProcess(null);
    setLiveLogs([]);
    setSearchQuery('');
    setStatusFilter('ALL');
    setAdminData(null);
    setBiometricGate(false);
    setBanner(null);
    pendingSessionRef.current = null;
    prevStatusRef.current = {};
    prevStatusReadyRef.current = false;
  }, []);

  const registerForPushNotificationsAsync = useCallback(async (validToken) => {
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
      console.warn('Failed to register push token:', error);
    }
  }, [handleLogout]);

  const unlockWithSession = useCallback(
    (token, role, { registerPush = true } = {}) => {
      setAuthToken(token);
      setUserRole(role);
      setBiometricGate(false);
      pendingSessionRef.current = null;
      prevStatusReadyRef.current = false;
      if (registerPush) registerForPushNotificationsAsync(token);
    },
    [registerForPushNotificationsAsync]
  );

  const tryBiometric = useCallback(async () => {
    const pending = pendingSessionRef.current;
    if (!pending?.token) return false;
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Déverrouiller Commander PRO',
        cancelLabel: 'Annuler',
        disableDeviceFallback: false,
      });
      if (result.success && mountedRef.current) {
        unlockWithSession(pending.token, pending.role);
        return true;
      }
    } catch (e) {
      console.warn('Biometric failed', e);
    }
    return false;
  }, [unlockWithSession]);

  useEffect(() => {
    async function boot() {
      try {
        const [hw, bioFlag, alertFlag, storedToken, storedRole] = await Promise.all([
          LocalAuthentication.hasHardwareAsync().catch(() => false),
          SecureStore.getItemAsync(BIOMETRIC_KEY),
          SecureStore.getItemAsync(ALERTS_KEY),
          SecureStore.getItemAsync(SESSION_TOKEN_KEY),
          SecureStore.getItemAsync(SESSION_ROLE_KEY),
        ]);
        const enrolled = hw ? await LocalAuthentication.isEnrolledAsync().catch(() => false) : false;
        // Opt-in: only enabled when user set it to '1'
        const bioOn = bioFlag === '1';
        setBiometricHardwareOk(!!(hw && enrolled));
        setBiometricEnabled(bioOn);
        if (alertFlag === '0') setStatusAlerts(false);

        if (storedToken && storedRole) {
          if (hw && enrolled && bioOn) {
            pendingSessionRef.current = { token: storedToken, role: storedRole };
            setUserRole(storedRole);
            setBiometricGate(true);
            setTimeout(() => {
              if (!mountedRef.current || !pendingSessionRef.current) return;
              LocalAuthentication.authenticateAsync({
                promptMessage: 'Déverrouiller Commander PRO',
                cancelLabel: 'Mot de passe',
              })
                .then((result) => {
                  if (result.success && mountedRef.current && pendingSessionRef.current) {
                    unlockWithSession(storedToken, storedRole);
                  }
                })
                .catch(() => {});
            }, 350);
          } else {
            unlockWithSession(storedToken, storedRole);
          }
        }
      } catch (e) {
        console.error('Boot error', e);
      } finally {
        if (mountedRef.current) setIsReady(true);
      }
    }
    boot();
  }, [unlockWithSession]);

  const handleLogin = useCallback(async () => {
    setLoginError(false);
    if (!passwordInput.trim() || isLoggingIn) return;

    if (!API_URL) {
      Alert.alert('Configuration', 'API_URL manquant (EXPO_PUBLIC_API_URL).');
      return;
    }

    setIsLoggingIn(true);
    try {
      const data = await apiFetch('/login', {
        method: 'POST',
        body: { password: passwordInput },
      });

      if (!data?.token || !data?.role) throw new Error('Réponse invalide');

      await SecureStore.setItemAsync(SESSION_TOKEN_KEY, data.token);
      await SecureStore.setItemAsync(SESSION_ROLE_KEY, data.role);

      if (!mountedRef.current) return;

      unlockWithSession(data.token, data.role);
      setPasswordInput('');
      pushActionLog(`Connexion ${data.role}`);
    } catch (error) {
      Vibration.vibrate();
      if (error.code === 'RATE_LIMIT') {
        Alert.alert('Sécurité', 'Trop de tentatives. Patientez 5 minutes.');
      } else if (error.code === 'CONFIG') {
        Alert.alert('Configuration', error.message);
      } else if (error.code === 'UNAUTHORIZED' || error.code === 'HTTP') {
        setLoginError(true);
      } else {
        Alert.alert('Erreur', error.message || 'Serveur injoignable.');
      }
    } finally {
      if (mountedRef.current) setIsLoggingIn(false);
    }
  }, [passwordInput, isLoggingIn, unlockWithSession, pushActionLog]);

  // --- API ---

  const fetchStatus = useCallback(
    async (isManualRefresh = false) => {
      const token = authTokenRef.current;
      if (!token) return;

      const t0 = Date.now();
      try {
        if (isManualRefresh && mountedRef.current) setRefreshing(true);

        const data = await apiFetch('/status', { token });
        if (!data || typeof data !== 'object' || Array.isArray(data) || !mountedRef.current) return;

        const procArray = Object.keys(data).map((key) => ({
          id: key,
          name: data[key]?.name ?? key,
          status: data[key]?.status ?? 'STOPPED',
          pid: data[key]?.pid ?? null,
          auto_restart: !!data[key]?.auto_restart,
        }));

        // Skip alerts on first successful snapshot after login
        if (statusAlertsRef.current && prevStatusReadyRef.current) {
          const prev = prevStatusRef.current;
          const drops = [];
          const ups = [];
          procArray.forEach((p) => {
            if (prev[p.id] === 'RUNNING' && p.status !== 'RUNNING') drops.push(p.name);
            else if (prev[p.id] && prev[p.id] !== 'RUNNING' && p.status === 'RUNNING') ups.push(p.name);
          });
          if (drops.length === 1) {
            showBanner(`${drops[0]} est hors ligne`, 'warn');
            Vibration.vibrate(80);
          } else if (drops.length > 1) {
            showBanner(`${drops.length} processus hors ligne`, 'warn');
            Vibration.vibrate(80);
          } else if (ups.length === 1) {
            showBanner(`${ups[0]} est en ligne`, 'ok');
          } else if (ups.length > 1) {
            showBanner(`${ups.length} processus en ligne`, 'ok');
          }
        }
        prevStatusRef.current = Object.fromEntries(procArray.map((p) => [p.id, p.status]));
        prevStatusReadyRef.current = true;

        if (isManualRefresh) animateLayout();
        setProcesses(procArray);
        setConnectionOk(true);
        setLatencyMs(Date.now() - t0);
        setLastSyncAt(Date.now());
      } catch (error) {
        if (error.code === 'UNAUTHORIZED') {
          Alert.alert('Sécurité', 'Votre session a expiré.');
          handleLogout();
          return;
        }
        setConnectionOk(false);
        console.error('Fetch Status Error', error.message);
      } finally {
        if (isManualRefresh && mountedRef.current) setRefreshing(false);
      }
    },
    [handleLogout, showBanner]
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

  const sendCommand = useCallback(
    async (target, command) => {
      const token = authTokenRef.current;
      if (!token) return;

      Vibration.vibrate(30);
      animateLayout();
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
    [fetchStatus, handleLogout, pushActionLog, scheduleRefresh]
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
      Vibration.vibrate(30);
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

  // --- TERMINAL ---

  const fetchLogs = useCallback(
    async (processId) => {
      const token = authTokenRef.current;
      if (!token || !processId) return;
      try {
        const data = await apiFetch(
          `/logs?target=${encodeURIComponent(processId)}&limit=100`,
          { token }
        );
        if (!mountedRef.current) return;
        setLiveLogs(Array.isArray(data) ? data : []);
      } catch (error) {
        if (error.code === 'UNAUTHORIZED') handleLogout();
      }
    },
    [handleLogout]
  );

  const openTerminal = useCallback(
    (process) => {
      setSelectedProcess(process);
      setLiveLogs([]);
      setCommandInput('');
      setTerminalVisible(true);
      fetchLogs(process.id);
    },
    [fetchLogs]
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
      const textToSend = String(rawText || '').trim();
      if (!textToSend || !selectedProcess || !token || sendingConsole) return;

      if (clearInput) setCommandInput('');
      setSendingConsole(true);
      setLiveLogs((prev) => [...prev, { text: `📱 [ENVOYÉ] : ${textToSend}`, type: 'admin' }]);
      pushActionLog(`Console ${selectedProcess.id}: ${textToSend}`);

      const processId = selectedProcess.id;
      try {
        await apiFetch('/smart_command', {
          method: 'POST',
          token,
          body: { target: processId, text: textToSend },
        });
        scheduleRefresh(() => fetchLogs(processId), LOG_REFRESH_AFTER_CMD_MS);
      } catch (error) {
        if (error.code === 'UNAUTHORIZED') {
          handleLogout();
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

  const onProcessLongPress = useCallback(
    (item) => {
      const buttons = [
        { text: 'Terminal', onPress: () => openTerminal(item) },
        { text: 'START', onPress: () => sendCommand(item.id, 'START') },
        { text: 'KILL', style: 'destructive', onPress: () => sendCommand(item.id, 'KILL') },
        { text: 'RESTART', onPress: () => sendCommand(item.id, 'RESTART') },
      ];
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
      buttons.push({ text: 'Annuler', style: 'cancel' });
      Alert.alert(item.name, `ID: ${item.id}`, buttons);
    },
    [openTerminal, sendCommand, isOwner]
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

  useEffect(() => {
    if (!isUnlocked) return undefined;
    fetchStatus(true);
    const interval = setInterval(() => fetchStatus(false), POLL_STATUS_MS);
    return () => clearInterval(interval);
  }, [isUnlocked, fetchStatus]);

  useEffect(() => {
    if (!isUnlocked || !isOwner) return undefined;
    fetchAdmin();
    const interval = setInterval(fetchAdmin, POLL_ADMIN_MS);
    return () => clearInterval(interval);
  }, [isUnlocked, isOwner, fetchAdmin]);

  useEffect(() => {
    if (!terminalVisible || !selectedProcess?.id) return undefined;
    const id = selectedProcess.id;
    const logInterval = setInterval(() => fetchLogs(id), POLL_LOGS_MS);
    return () => clearInterval(logInterval);
  }, [terminalVisible, selectedProcess?.id, fetchLogs]);

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
    const isBot = (p) =>
      p.id.toUpperCase().includes('BOT') || (p.name || '').toUpperCase().includes('BOT');

    let filtered = visibleProcesses.filter(
      (p) =>
        !q ||
        (p.name || '').toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q)
    );

    if (statusFilter === 'RUNNING') filtered = filtered.filter((p) => p.status === 'RUNNING');
    else if (statusFilter === 'STOPPED')
      filtered = filtered.filter((p) => p.status !== 'RUNNING');
    else if (statusFilter === 'BOTS') filtered = filtered.filter(isBot);
    else if (statusFilter === 'MAINS') filtered = filtered.filter((p) => !isBot(p));

    const bots = filtered.filter(isBot);
    const mains = filtered.filter((p) => !isBot(p));

    const sections = [];
    if (bots.length > 0) sections.push({ title: '🤖 BOTS', data: bots });
    if (mains.length > 0) sections.push({ title: '📻 SYSTÈMES', data: mains });
    return sections;
  }, [visibleProcesses, searchQuery, statusFilter]);

  const renderLogItem = useCallback(({ item }) => {
    let color = '#e2e8f0';
    if (item.type === 'error') color = '#ef4444';
    if (item.type === 'warning') color = '#f59e0b';
    if (item.type === 'success') color = '#10b981';
    if (item.type === 'info') color = '#38bdf8';
    if (item.type === 'admin') color = '#c084fc';
    return (
      <Text style={[styles.logText, { color }]} selectable>
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
      />
    ),
    [openTerminal, sendCommand, onProcessLongPress]
  );

  const renderSectionHeader = useCallback(
    ({ section: { title } }) => <Text style={styles.sectionHeader}>{title}</Text>,
    []
  );

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
            <Text style={styles.dashLabel}>ACTIFS</Text>
          </View>
          <View style={[styles.dashCard, { borderBottomColor: '#ef4444' }]}>
            <Text style={styles.dashNumber}>{offlineCount}</Text>
            <Text style={styles.dashLabel}>ARRÊTÉS</Text>
          </View>
          <View style={[styles.dashCard, { borderBottomColor: '#f59e0b' }]}>
            <Text style={styles.dashNumber}>{errorCount}</Text>
            <Text style={styles.dashLabel}>ERREURS</Text>
          </View>
          {isOwner ? (
            <View style={[styles.dashCard, { borderBottomColor: '#a78bfa' }]}>
              <Text style={styles.dashNumber}>{adminData?.sessions?.total ?? '—'}</Text>
              <Text style={styles.dashLabel}>SESSIONS</Text>
            </View>
          ) : null}
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
          style={styles.filterScroll}
        >
          {STATUS_FILTERS.map((f) => (
            <Chip
              key={f.id}
              label={f.label}
              active={statusFilter === f.id}
              onPress={() => {
                animateLayout();
                setStatusFilter(f.id);
              }}
            />
          ))}
        </ScrollView>

        <View style={styles.searchContainer}>
          <Ionicons name="search" size={18} color="#94a3b8" style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            placeholder="Rechercher id / nom..."
            placeholderTextColor="#64748b"
            value={searchQuery}
            onChangeText={(text) => setSearchQuery(text)}
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
          />
          {searchQuery.length > 0 && Platform.OS === 'android' ? (
            <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={8}>
              <Ionicons name="close-circle" size={18} color="#94a3b8" />
            </TouchableOpacity>
          ) : null}
        </View>

        {isOwner ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.ownerBarContent}
            style={styles.ownerBar}
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
      searchQuery,
      doGlobalAction,
      fetchAdmin,
      clearAllSessions,
      clearingSessions,
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

  if (!isUnlocked) {
    return (
      <LockScreen
        passwordInput={passwordInput}
        setPasswordInput={setPasswordInput}
        loginError={loginError}
        handleLogin={handleLogin}
        isLoggingIn={isLoggingIn}
        showBiometric={showBioOnLock}
        onBiometric={tryBiometric}
      />
    );
  }

  return (
    <LinearGradient colors={['#000000', '#0a0a0a', '#111827']} style={styles.container}>
      <SafeAreaView style={styles.flex} edges={['top', 'left', 'right']}>
        <StatusBar barStyle="light-content" backgroundColor="#000000" />

        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerTextBlock}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              Commander<Text style={{ color: '#f8fafc' }}> PRO</Text>
            </Text>
            <View style={styles.headerBadgeRow}>
              <View
                style={[
                  styles.connDot,
                  { backgroundColor: connectionOk ? '#10b981' : '#ef4444' },
                ]}
              />
              <Text style={styles.headerSubtitle} numberOfLines={1}>
                {isOwner ? 'OWNER' : userRole}
                {latencyMs != null ? ` · ${latencyMs}ms` : ''}
                {!connectionOk ? ' · hors ligne' : ''}
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
                accessibilityLabel="Centre de commande"
                hitSlop={6}
              >
                <Ionicons name="construct" size={18} color="#c084fc" />
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={[styles.globalBtn, { backgroundColor: 'rgba(148, 163, 184, 0.2)' }]}
              onPress={handleLogout}
              accessibilityLabel="Déconnexion"
              hitSlop={6}
            >
              <Ionicons name="log-out" size={18} color="#94a3b8" />
            </TouchableOpacity>
          </View>
        </View>

        <SectionList
          sections={groupedData}
          keyExtractor={(item) => item.id}
          renderItem={renderProcessItem}
          renderSectionHeader={renderSectionHeader}
          ListHeaderComponent={listHeader}
          stickySectionHeadersEnabled={false}
          keyboardShouldPersistTaps="handled"
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
          contentContainerStyle={{
            paddingHorizontal: 14,
            paddingBottom: Math.max(insets.bottom, 16) + 24,
          }}
          ListEmptyComponent={
            <Text style={styles.emptyText}>
              {searchQuery || statusFilter !== 'ALL'
                ? 'Aucun résultat pour ce filtre.'
                : 'Aucun processus autorisé trouvé.'}
            </Text>
          }
        />

        {/* ===== OWNER COMMAND CENTER ===== */}
        <Modal
          animationType="slide"
          transparent
          visible={cmdCenterVisible && isOwner}
          onRequestClose={() => setCmdCenterVisible(false)}
        >
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
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

        {/* ===== TERMINAL ===== */}
        <Modal
          animationType="slide"
          transparent
          visible={terminalVisible}
          onRequestClose={closeTerminal}
        >
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
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
                  keyExtractor={(item, index) => `${index}-${(item.text || '').slice(0, 20)}`}
                  renderItem={renderLogItem}
                  onContentSizeChange={() => {
                    try {
                      flatListRef.current?.scrollToEnd({ animated: true });
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
                  placeholder="Commande console..."
                  placeholderTextColor="#4b5563"
                  value={commandInput}
                  onChangeText={setCommandInput}
                  onSubmitEditing={submitTypedCommand}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!sendingConsole}
                  returnKeyType="send"
                />
                <TouchableOpacity
                  style={[styles.sendButton, sendingConsole && { opacity: 0.5 }]}
                  onPress={submitTypedCommand}
                  disabled={sendingConsole}
                >
                  <Ionicons name="send" size={16} color="white" />
                </TouchableOpacity>
              </View>
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
  bootScreen: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  lockScreen: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  lockTitle: { color: 'white', fontSize: 24, fontWeight: '800', marginBottom: 6 },
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
  headerLeftRow: { flexDirection: 'row', alignItems: 'center' },

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
    marginTop: 36,
    fontSize: 15,
    fontStyle: 'italic',
  },

  card: {
    borderRadius: 16,
    marginBottom: 12,
    borderWidth: 1,
    overflow: 'hidden',
    flexDirection: 'row',
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
  actionRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  iconButton: {
    width: 46,
    height: 46,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },

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
});
