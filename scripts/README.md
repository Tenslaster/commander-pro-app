# Commander PRO — scripts

## Builds
| Script | Purpose |
|--------|---------|
| `build-apk.bat` | EAS Android APK → `dist/apk/CommanderPro.apk` |
| `build-ipa.bat` | GitHub Actions IPA → `dist/ipa/CommanderPro.ipa` |
| `publish-to-downloads.bat` | Refresh dist from EAS + GitHub |

## Downloads
| Script | Purpose |
|--------|---------|
| `start-download-server.bat` | Serve `dist` on `:8787` (`/downloads`) |
| `restart-download-server.bat` | Kill port 8787 + restart |

## FCM (Android push)
| Script | Purpose |
|--------|---------|
| `upload_fcm_to_eas.py` | Upload FCM V1 service account to Expo EAS |
| `apply-fcm.bat` / `auto-setup-fcm.bat` | Guided FCM setup |

**Never commit** `credentials/fcm-service-account.json`.

## Quality / maintenance
| Script | Purpose |
|--------|---------|
| `smoke_test.py` | Local health checks API + downloads |
| `repack_ipa_js.py` | Inject new JS into IPA when GH/EAS unavailable |

```bat
python scripts\smoke_test.py
```

## Fixed Expo Go URL
See `../EXPO-GO-URL.txt` — always:

```
exp://commanderpro.ngrok.io:80
```
