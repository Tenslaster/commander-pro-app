#!/usr/bin/env python3
import json
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
APK = DIST / "apk" / "CommanderPro.apk"
IPA = DIST / "ipa" / "CommanderPro.ipa"


def apk_version(path: Path) -> str:
    if not path.is_file():
        return "1.4.1"
    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            if "app.config" in n:
                t = z.read(n).decode("utf-8", "replace")
                m = re.search(r'"version"\s*:\s*"([^"]+)"', t)
                if m:
                    return m.group(1)
    return "1.4.1"


def main() -> None:
    ver = apk_version(APK)
    v = {
        "android": ver,
        "ios": ver,
        "apk": {
            "version": ver,
            "file": "CommanderPro.apk",
            "size": APK.stat().st_size if APK.is_file() else 0,
        },
        "ipa": {
            "version": ver,
            "file": "CommanderPro.ipa",
            "size": IPA.stat().st_size if IPA.is_file() else 0,
        },
    }
    (DIST / "versions.json").write_text(
        json.dumps(v, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(v, indent=2))


if __name__ == "__main__":
    main()
