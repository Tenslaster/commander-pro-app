# Commander PRO (mobile app)

Expo / React Native app — **standalone APK + IPA only**.

Backend / Batch Manager / radio bots live **outside** this repo. This repo is
build-only source for GitHub Actions.

## What’s in this repo (build essentials)

| Path | Purpose |
|------|---------|
| `App.js`, `i18n.js`, `*.js` helpers | App source |
| `app.json`, `eas.json`, `package.json` | Expo config |
| `assets/` | Icons & splash |
| `google-services.json` | Android FCM |
| `.github/workflows/` | **Android APK** + **iOS Build** CI |
| `scripts/ci-patch-android-signing.py` | CI release signing patch |

Everything else (local `dist/`, download server, repack scripts, credentials)
is **gitignored** and must not be committed.

## Build on GitHub

| Workflow | Trigger | Artifact |
|----------|---------|----------|
| **Android APK** | push to `main` or manual | `CommanderPro.apk` |
| **iOS Build** | push to `main` or manual | unsigned `.ipa` |

```bash
# After push to main, both APK and IPA build automatically.
# Manual iOS (example):
gh workflow run "iOS Build" -f build_id=CommanderPro-157 -f configuration=Release
```

Download artifacts from the Actions run page.

## Local (optional)

```bash
npm ci
npx expo start --go
```

API URL is baked at build time via `EXPO_PUBLIC_API_URL`  
(default production: `https://kingdom.lifestyle/api`).
