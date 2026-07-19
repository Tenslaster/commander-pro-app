# Commander PRO — scripts

| Script | What it does |
|--------|----------------|
| `build-apk.bat` | EAS cloud Android APK → `dist/apk/CommanderPro.apk` |
| `build-ipa.bat` | GitHub Actions iOS IPA → `dist/ipa/CommanderPro.ipa` |
| `start-download-server.bat` | Serve downloads on port **8787** (`/downloads`) |
| `publish-to-downloads.bat` | Pull latest finished APK+IPA into `dist/` without rebuilding |

Root wrappers (`Build-APK.bat`, `Ios-Builder.bat`, `Start-Download-Server.bat`) call these scripts.

## After a build
1. Run `start-download-server.bat` (or Batch Manager → CommanderDownloads)
2. Cloudflare tunnel must route `/downloads` → `localhost:8787`
3. Public page: https://crew.kingdom.forum/downloads

## Notifications (APK / IPA)
1. Install build **≥ min_app_version** (see `Batch_Manager/app_version_policy.json`)
2. Log out → log in, allow notifications
3. Admin → **Test push (moi)** — check `Devices: 1+`
4. If `Devices: 0`, push token was not registered
5. iOS remote push needs APNs on the Expo project; without it, local OS notifs still fire from the in-app feed while the app is open
