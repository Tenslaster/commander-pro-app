// Polyfill crypto.getRandomValues BEFORE any security/nonce code loads
import 'react-native-get-random-values';

// Background task must be defined before the app component tree loads
import './notificationBackground';

import { registerRootComponent } from 'expo';
import { warmSecureRandom } from './apiSecurity';
import App from './App';

// Prefill secure nonce pool (expo-crypto / WebCrypto) so POSTs never fail
warmSecureRandom().catch(() => {});

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
