#!/usr/bin/env python3
"""Bump Commander PRO to 1.4.8 (RADIO1 users load fix + UX)."""
from __future__ import annotations

import json
import re
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
BM = Path(r"C:\Users\cedri\OneDrive\Bureau\RADIOS\Batch_Manager")
VER = "1.4.8"
VC = 148


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

    pol_path = BM / "app_version_policy.json"
    if pol_path.is_file():
        pol = json.loads(pol_path.read_text(encoding="utf-8-sig"))
        pol["min_app_version"] = "1.4.7"
        pol["latest_app_version"] = VER
        pol["latest_app_version_android"] = VER
        pol["latest_app_version_ios"] = VER
        pol["force_update"] = True
        pol["message_fr"] = f"Mettez a jour vers {VER} (utilisateurs RADIO1)."
        pol["message_en"] = f"Please update to {VER} (RADIO1 users fix)."
        pol["soft_message_fr"] = f"Commander PRO {VER}: chargement utilisateurs corrige."
        pol["soft_message_en"] = f"Commander PRO {VER}: users list load fixed."
        pol_path.write_text(json.dumps(pol, indent=2) + "\n", encoding="utf-8")

    print(f"OK {VER} versionCode={VC}")


if __name__ == "__main__":
    main()
