# Commander PRO

**Shipping product:** standalone **APK** + **IPA** (users install from downloads).  
**Expo Go:** personal testing only (`npm run start:go`) — not the production app.

## Folder map

| Path | What |
|------|------|
| `App.js` / `i18n.js` / `notificationBackground.js` | App source |
| `app.json` / `eas.json` / `package.json` | Expo config (prebuild → native) |
| `google-services.json` | Firebase Android (FCM) |
| `credentials/` | **Private** FCM service account (not for git) |
| `assets/` | Icons, splash |
| `dist/apk` `dist/ipa` | Installers for the downloads page |
| `scripts/` | Build, FCM, smoke tests |
| `download_server.py` | Serves `dist` on port **8787** |

## Production builds

```bat
scripts\build-apk.bat
scripts\build-ipa.bat
scripts\publish-to-downloads.bat
Start-Download-Server.bat
python scripts\smoke_test.py
```

Or GitHub Actions: **Android APK** / **iOS Build** workflows → download artifacts into `dist/`.

Public downloads: https://crew.kingdom.forum/downloads

## Personal testing (Expo Go only)

```bat
npm run start:go
```

See `EXPO-GO-URL.txt` if you use the tunnel.
