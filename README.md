# Commander PRO (Expo app)

## Folder map

| Path | What |
|------|------|
| `App.js` / `i18n.js` / `notificationBackground.js` | App source |
| `app.json` / `eas.json` / `package.json` | Expo / EAS config |
| `google-services.json` | Firebase Android (FCM) |
| `credentials/` | **Private** FCM service account (not for git) |
| `assets/` | Icons, splash |
| `dist/apk` `dist/ipa` | Published installers for downloads page |
| `scripts/` | Build, FCM, smoke tests, IPA repack |
| `download_server.py` | Serves `dist` on port **8787** |
| `start.bat` | Expo Go tunnel (fixed URL in `EXPO-GO-URL.txt`) |

## Quick commands

```bat
start.bat
Start-Download-Server.bat
scripts\build-apk.bat
scripts\build-ipa.bat
python scripts\smoke_test.py
```

Public downloads: https://crew.kingdom.forum/downloads  
Expo Go: see `EXPO-GO-URL.txt`
