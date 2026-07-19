# FCM setup for Commander PRO (Android background push)

**I cannot create a Firebase project without your Google account.**  
Once you drop 2 files, the rest is automated.

## One-time (you, ~5 min)

1. Open https://console.firebase.google.com (use `tenslaster@gmail.com` if that is your Expo account)
2. **Add project** → name e.g. `commander-pro`
3. **Add Android app**
   - Package name: `com.commanderpro.radios` (must match app.json)
   - Download **`google-services.json`**
4. Project settings → **Service accounts** → **Generate new private key**
   - Download the JSON (name like `*-firebase-adminsdk-*.json`)
5. Put both files here:

```
iphone-batch-manager/
  google-services.json          ← from Firebase (public-ish, OK in repo)
  credentials/
    fcm-service-account.json    ← private key (DO NOT commit)
```

6. Run:

```bat
scripts\apply-fcm.bat
```

That script will:
- wire `googleServicesFile` in app.json
- tell you the exact `eas credentials` upload steps
- rebuild APK if you confirm

## Without FCM (current bypass in 1.3.2)

Android uses **background polling + local notifications** (no Google project needed):
- Works while the process is alive / OS allows BackgroundFetch
- Not as instant as FCM (OS may delay ~minutes)
- Disable battery optimization for Commander PRO for best results
