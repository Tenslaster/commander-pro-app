#!/usr/bin/env python3
"""Inject fresh Expo Android JS bundle into existing APK + re-sign (debug).

Use when EAS free Android quota is exhausted. Sideload update may require
uninstall if previous APK was signed with a different keystore.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC_APK = ROOT / "dist" / "apk" / "CommanderPro.apk"
OUT_APK = ROOT / "dist" / "apk" / "CommanderPro.apk"
BACKUP = ROOT / "dist" / "apk" / "CommanderPro-pre-repack-backup.apk"
EXPORT = ROOT / "dist-android-export"
WORK = ROOT / "dist-apk-work"
UNSIGNED = WORK / "unsigned.apk"
VERSION = "1.5.0"
DEBUG_KS = Path.home() / ".android" / "debug.keystore"
KEYTOOL = Path(r"C:\Program Files\Eclipse Adoptium\jre-21.0.5.11-hotspot\bin\keytool.exe")


def find_jarsigner() -> Path | None:
    candidates = [
        Path(r"C:\Program Files\Eclipse Adoptium\jdk-21.0.5.11-hotspot\bin\jarsigner.exe"),
        Path(r"C:\Program Files\Eclipse Adoptium\jre-21.0.5.11-hotspot\bin\jarsigner.exe"),
    ]
    for p in candidates:
        if p.is_file():
            return p
    # search sibling jdk folders
    base = Path(r"C:\Program Files\Eclipse Adoptium")
    if base.is_dir():
        for p in base.glob("*/bin/jarsigner.exe"):
            return p
    return None


def main() -> int:
    # Prefer expo export bundle
    bundle = None
    for cand in (
        EXPORT / "assets" / "index.android.bundle",
        EXPORT / "_expo" / "static" / "js" / "android",
    ):
        if cand.is_file():
            bundle = cand
            break
        if cand.is_dir():
            hbcs = list(cand.glob("*.hbc")) + list(cand.glob("*.js"))
            if hbcs:
                bundle = hbcs[0]
                break
    if bundle is None:
        # also check nested
        if EXPORT.is_dir():
            for p in EXPORT.rglob("index.android.bundle"):
                bundle = p
                break
            if bundle is None:
                for p in EXPORT.rglob("*.hbc"):
                    if "android" in str(p).lower() or "index" in p.name:
                        bundle = p
                        break
    if bundle is None or not bundle.is_file():
        print(
            "ERROR: no android bundle — run:\n"
            "  npx expo export --platform android --output-dir dist-android-export"
        )
        return 1
    if not SRC_APK.is_file():
        print("ERROR: missing base APK", SRC_APK)
        return 1

    print("bundle", bundle, "size", bundle.stat().st_size)
    if WORK.exists():
        shutil.rmtree(WORK)
    WORK.mkdir(parents=True)

    if not BACKUP.exists():
        shutil.copy2(SRC_APK, BACKUP)
        print("backup", BACKUP)

    # Copy zip entries except old signature + old bundle/config
    skip_prefixes = ("META-INF/",)
    replace = {
        "assets/index.android.bundle": bundle.read_bytes(),
    }
    # app.config from app.json
    app_json = json.loads((ROOT / "app.json").read_text(encoding="utf-8-sig"))
    expo = app_json.get("expo") or {}
    expo = dict(expo)
    expo["version"] = VERSION
    # Keep compact config like expo embeds
    try:
        with zipfile.ZipFile(SRC_APK) as z:
            old_cfg = z.read("assets/app.config").decode("utf-8", "replace")
            data = json.loads(old_cfg)
            if isinstance(data, dict):
                data["version"] = VERSION
                if "android" in data and isinstance(data["android"], dict):
                    data["android"]["versionCode"] = int(
                        (expo.get("android") or {}).get("versionCode") or 143
                    )
                replace["assets/app.config"] = json.dumps(
                    data, separators=(",", ":")
                ).encode("utf-8")
            else:
                replace["assets/app.config"] = re.sub(
                    r'"version"\s*:\s*"[^"]+"',
                    f'"version":"{VERSION}"',
                    old_cfg,
                ).encode("utf-8")
    except Exception as e:
        print("app.config patch warn", e)
        replace["assets/app.config"] = json.dumps(
            {"name": expo.get("name"), "slug": expo.get("slug"), "version": VERSION},
            separators=(",", ":"),
        ).encode("utf-8")

    with zipfile.ZipFile(SRC_APK, "r") as zin, zipfile.ZipFile(
        UNSIGNED, "w", compression=zipfile.ZIP_DEFLATED
    ) as zout:
        written = set()
        for info in zin.infolist():
            name = info.filename
            if name.startswith(skip_prefixes):
                continue
            if name in replace:
                zout.writestr(name, replace[name])
                written.add(name)
                continue
            zout.writestr(info, zin.read(name))
        for name, data in replace.items():
            if name not in written:
                zout.writestr(name, data)

    print("unsigned", UNSIGNED, UNSIGNED.stat().st_size)

    # Sign with debug keystore (standard Android debug credentials)
    jarsigner = find_jarsigner()
    if jarsigner is None:
        print("ERROR: jarsigner not found (need full JDK, not only JRE)")
        print("unsigned APK left at", UNSIGNED)
        return 1
    if not DEBUG_KS.is_file():
        # create standard debug keystore
        DEBUG_KS.parent.mkdir(parents=True, exist_ok=True)
        subprocess.check_call(
            [
                str(KEYTOOL if KEYTOOL.is_file() else "keytool"),
                "-genkeypair",
                "-v",
                "-keystore",
                str(DEBUG_KS),
                "-storepass",
                "android",
                "-alias",
                "androiddebugkey",
                "-keypass",
                "android",
                "-keyalg",
                "RSA",
                "-keysize",
                "2048",
                "-validity",
                "10000",
                "-dname",
                "CN=Android Debug,O=Android,C=US",
            ]
        )

    signed = WORK / "signed.apk"
    shutil.copy2(UNSIGNED, signed)
    subprocess.check_call(
        [
            str(jarsigner),
            "-verbose",
            "-sigalg",
            "SHA256withRSA",
            "-digestalg",
            "SHA-256",
            "-keystore",
            str(DEBUG_KS),
            "-storepass",
            "android",
            "-keypass",
            "android",
            str(signed),
            "androiddebugkey",
        ]
    )
    OUT_APK.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(signed, OUT_APK)
    print("wrote", OUT_APK, OUT_APK.stat().st_size)
    with zipfile.ZipFile(OUT_APK) as z:
        cfg = z.read("assets/app.config").decode("utf-8", "replace")
        m = re.search(r'"version"\s*:\s*"([^"]+)"', cfg)
        print("embedded version", m.group(1) if m else "?")
        print("bundle size", z.getinfo("assets/index.android.bundle").file_size)
    print("NOTE: debug-signed — if install fails, uninstall previous APK first")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
