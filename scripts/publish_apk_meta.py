#!/usr/bin/env python3
"""Update dist/versions.json from built APK/IPA after publish."""
from __future__ import annotations

import json
import os
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APK = ROOT / "dist" / "apk" / "CommanderPro.apk"
IPA = ROOT / "dist" / "ipa" / "CommanderPro.ipa"
VERSIONS = ROOT / "dist" / "versions.json"
FALLBACK = "1.4.2"


def read_app_json_version() -> str:
    try:
        data = json.loads((ROOT / "app.json").read_text(encoding="utf-8-sig"))
        return str(data.get("expo", {}).get("version") or FALLBACK)
    except Exception:
        return FALLBACK


def apk_version(path: Path) -> str:
    if not path.is_file():
        return read_app_json_version()
    try:
        with zipfile.ZipFile(path) as z:
            for n in z.namelist():
                if "app.config" in n:
                    t = z.read(n).decode("utf-8", "replace")
                    m = re.search(r'"version"\s*:\s*"([^"]+)"', t)
                    if m:
                        return m.group(1)
    except Exception as e:
        print("config read warn:", e)
    return read_app_json_version()


def main() -> int:
    ver = apk_version(APK)
    ios_ver = ver
    # Prefer matching app.json if IPA is present
    app_ver = read_app_json_version()
    if IPA.is_file():
        ios_ver = app_ver
    data = {
        "android": ver,
        "ios": ios_ver,
        "note": f"{app_ver} Commander PRO — perf + dual platform",
        "apk": {
            "version": ver,
            "file": "CommanderPro.apk",
            "size": APK.stat().st_size if APK.is_file() else 0,
            "method": "eas",
        },
        "ipa": {
            "version": ios_ver,
            "file": "CommanderPro.ipa",
            "size": IPA.stat().st_size if IPA.is_file() else 0,
            "method": "github-actions",
        },
    }
    VERSIONS.parent.mkdir(parents=True, exist_ok=True)
    VERSIONS.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(data, indent=2))
    print("wrote", VERSIONS)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
