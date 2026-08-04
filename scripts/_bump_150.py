#!/usr/bin/env python3
"""Bump Commander PRO to 1.5.0 (rank SQL fix + users tab save + radios 1-5)."""
from __future__ import annotations

import json
import re
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
BM = Path(r"C:\Users\cedri\OneDrive\Bureau\RADIOS\Batch_Manager")
VER = "1.5.0"
VC = 150


def main() -> None:
    d = json.loads((APP / "app.json").read_text(encoding="utf-8-sig"))
    d["expo"]["version"] = VER
    d["expo"]["android"]["versionCode"] = VC
    (APP / "app.json").write_text(
        json.dumps(d, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    p = json.loads((APP / "package.json").read_text(encoding="utf-8-sig"))
    p["version"] = VER
    (APP / "package.json").write_text(
        json.dumps(p, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    for name in ("App.js", "notificationBackground.js"):
        path = APP / name
        if not path.is_file():
            continue
        t = path.read_text(encoding="utf-8")
        t = re.sub(r"APP_VERSION = '[^']+'", f"APP_VERSION = '{VER}'", t)
        path.write_text(t, encoding="utf-8")

    # Repack scripts embed VERSION constant
    for name in ("repack_apk_js.py", "repack_ipa_js.py", "publish_apk_meta.py"):
        path = APP / "scripts" / name
        if not path.is_file():
            continue
        t = path.read_text(encoding="utf-8")
        t = re.sub(r'VERSION = "[^"]+"', f'VERSION = "{VER}"', t)
        t = re.sub(r'FALLBACK = "[^"]+"', f'FALLBACK = "{VER}"', t)
        t = re.sub(r'verify version 1\.\d+\.\d+', f"verify version {VER}", t)
        t = re.sub(r'b"1\.\d+\.\d+"', f'b"{VER}"', t)
        # IPA build number family
        t = re.sub(
            r'info\["CFBundleVersion"\] = "\d+"',
            f'info["CFBundleVersion"] = "{VC}"',
            t,
        )
        t = re.sub(r'or "149"', f'or "{VC}"', t)
        t = re.sub(r">= 149", f">= {VC}", t)
        t = re.sub(r'else "149"', f'else "{VC}"', t)
        path.write_text(t, encoding="utf-8")

    pol_path = BM / "app_version_policy.json"
    if pol_path.is_file():
        pol = json.loads(pol_path.read_text(encoding="utf-8-sig"))
        pol["min_app_version"] = "1.4.9"
        pol["latest_app_version"] = VER
        pol["latest_app_version_android"] = VER
        pol["latest_app_version_ios"] = VER
        pol["force_update"] = True
        pol["message_fr"] = (
            f"Mettez a jour vers {VER} (rangs SQL + sauvegarde utilisateurs)."
        )
        pol["message_en"] = (
            f"Please update to {VER} (SQL ranks + user save fix)."
        )
        pol["soft_message_fr"] = (
            f"Commander PRO {VER}: rangs et bank se sauvegardent correctement."
        )
        pol["soft_message_en"] = (
            f"Commander PRO {VER}: ranks and bank save correctly."
        )
        pol_path.write_text(json.dumps(pol, indent=2) + "\n", encoding="utf-8")

    print(f"OK {VER} versionCode={VC}")


if __name__ == "__main__":
    main()
