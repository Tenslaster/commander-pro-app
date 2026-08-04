#!/usr/bin/env python3
"""Rebuild iOS IPA JS layer on Windows by injecting a fresh Hermes bundle.

Native shell comes from last GitHub no-codesign IPA (Sideloadly re-signs).
Use when GitHub Actions / EAS iOS credentials are unavailable.
"""
from __future__ import annotations

import json
import plistlib
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC_IPA = ROOT / "dist" / "ipa" / "CommanderPro.ipa"
EXPORT = ROOT / "dist-ios-export"
OUT_IPA = ROOT / "dist" / "ipa" / "CommanderPro.ipa"
BACKUP = ROOT / "dist" / "ipa" / "CommanderPro-pre-repack-backup.ipa"
WORK = ROOT / "dist-ipa-work"
VERSION = "1.5.0"


def main() -> int:
    hbc_dir = EXPORT / "_expo" / "static" / "js" / "ios"
    hbcs = list(hbc_dir.glob("*.hbc"))
    if not hbcs:
        print("ERROR: no .hbc from expo export — run: npx expo export --platform ios --output-dir dist-ios-export")
        return 1
    hbc = hbcs[0]
    if not SRC_IPA.is_file():
        print("ERROR: missing base IPA", SRC_IPA)
        return 1

    print("bundle", hbc, "size", hbc.stat().st_size)
    if WORK.exists():
        shutil.rmtree(WORK)
    WORK.mkdir(parents=True)

    with zipfile.ZipFile(SRC_IPA, "r") as z:
        z.extractall(WORK)

    app = WORK / "Payload" / "CommanderPRO.app"
    if not app.is_dir():
        # tolerate alternate casing
        payload = WORK / "Payload"
        apps = [p for p in payload.iterdir() if p.suffix == ".app"] if payload.is_dir() else []
        if not apps:
            print("ERROR: no .app in Payload")
            return 1
        app = apps[0]
    print("app", app.name)

    bundle_dst = app / "main.jsbundle"
    old = bundle_dst.stat().st_size if bundle_dst.is_file() else 0
    shutil.copy2(hbc, bundle_dst)
    print("main.jsbundle", old, "->", bundle_dst.stat().st_size)

    info_path = app / "Info.plist"
    with open(info_path, "rb") as f:
        info = plistlib.load(f)
    print("old version", info.get("CFBundleShortVersionString"), info.get("CFBundleVersion"))
    # Keep marketing version stable (user request); only bump build if missing
    info["CFBundleShortVersionString"] = VERSION
    bv = str(info.get("CFBundleVersion") or "150")
    # Keep same build family for 1.4.9 (149) — do not auto-increment on local repack
    if not bv.isdigit():
        info["CFBundleVersion"] = "150"
    else:
        info["CFBundleVersion"] = bv if int(bv) >= 150 else "150"
    with open(info_path, "wb") as f:
        plistlib.dump(info, f, fmt=plistlib.FMT_BINARY)
    print("new version", info["CFBundleShortVersionString"], "build", info["CFBundleVersion"])

    cfg = app / "EXConstants.bundle" / "app.config"
    if cfg.is_file():
        raw = cfg.read_text(encoding="utf-8")
        try:
            data = json.loads(raw)
            if isinstance(data, dict):
                data["version"] = VERSION
                if isinstance(data.get("expo"), dict):
                    data["expo"]["version"] = VERSION
                cfg.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
                print("updated EXConstants app.config")
        except Exception:
            if "1.3.4" in raw:
                cfg.write_text(raw.replace("1.3.4", VERSION), encoding="utf-8")
                print("patched app.config text")

    if not BACKUP.exists():
        shutil.copy2(SRC_IPA, BACKUP)
        print("backup", BACKUP)

    if OUT_IPA.exists():
        OUT_IPA.unlink()
    with zipfile.ZipFile(OUT_IPA, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for path in WORK.rglob("*"):
            if path.is_file():
                z.write(path, arcname=path.relative_to(WORK).as_posix())

    print("wrote", OUT_IPA, OUT_IPA.stat().st_size)
    with zipfile.ZipFile(OUT_IPA) as z:
        names = z.namelist()
        app_prefix = next(
            (n for n in names if n.endswith(".app/main.jsbundle")),
            "Payload/CommanderPRO.app/main.jsbundle",
        )
        app_root = app_prefix[: -len("main.jsbundle")]
        pl = z.read(app_root + "Info.plist")
        jb = z.read(app_prefix)
        print("verify version 1.5.0 in bundle", b"1.5.0" in jb)
        print("verify cacheInit / sqlite", b"cacheInit" in jb or b"commander_pro_cache" in jb)
        print("bundle magic", jb[:4])
    print("DONE — install with Sideloadly (re-signs). Version stays", VERSION)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
