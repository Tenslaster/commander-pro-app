#!/usr/bin/env python3
"""Bump Commander PRO to 1.4.3 (IPv4 security + geo HTTPS)."""
from __future__ import annotations

import json
import re
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
BM = Path(r"C:\Users\cedri\OneDrive\Bureau\RADIOS\Batch_Manager")
VER = "1.4.3"
VC = 143


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
        t = (APP / name).read_text(encoding="utf-8")
        t = re.sub(r"APP_VERSION = '[^']+'", f"APP_VERSION = '{VER}'", t)
        (APP / name).write_text(t, encoding="utf-8")

    # During build: latest=1.4.3 but min stays 1.4.2 so old apps still open downloads.
    # After publish we set min to 1.4.3 for force-update.
    pol_path = BM / "app_version_policy.json"
    pol = json.loads(pol_path.read_text(encoding="utf-8-sig"))
    pol["min_app_version"] = "1.4.2"
    pol["latest_app_version"] = VER
    pol["latest_app_version_android"] = VER
    pol["latest_app_version_ios"] = VER
    pol["force_update"] = True
    pol["message_fr"] = f"Mettez a jour vers {VER} (securite IPv4 + geo)."
    pol["message_en"] = f"Please update to {VER} (IPv4 security + geo)."
    pol["soft_message_fr"] = f"Commander PRO {VER}: IPv4 + geo HTTPS."
    pol["soft_message_en"] = f"Commander PRO {VER}: IPv4 + geo HTTPS."
    pol_path.write_text(json.dumps(pol, indent=2) + "\n", encoding="utf-8")

    envp = BM / "api_server.env"
    if envp.is_file():
        env = envp.read_text(encoding="utf-8")
        if re.search(r"(?m)^LATEST_APP_VERSION=", env):
            env = re.sub(
                r"(?m)^LATEST_APP_VERSION=.*", f"LATEST_APP_VERSION={VER}", env
            )
        else:
            env = env.rstrip() + f"\nLATEST_APP_VERSION={VER}\n"
        if re.search(r"(?m)^APP_VERSION=", env):
            env = re.sub(r"(?m)^APP_VERSION=.*", f"APP_VERSION={VER}", env)
        envp.write_text(env, encoding="utf-8")

    # Fallback note in versions.json (sizes updated after real builds)
    dist_v = APP / "dist" / "versions.json"
    dist_v.parent.mkdir(parents=True, exist_ok=True)
    note = f"{VER} Commander PRO — IPv4 security + geo HTTPS"
    cur = {}
    if dist_v.is_file():
        try:
            cur = json.loads(dist_v.read_text(encoding="utf-8-sig"))
        except Exception:
            cur = {}
    cur.update(
        {
            "android": VER,
            "ios": VER,
            "note": note,
        }
    )
    dist_v.write_text(json.dumps(cur, indent=2) + "\n", encoding="utf-8")

    print(f"OK {VER} versionCode={VC}")
    print(
        "App.js",
        re.search(
            r"APP_VERSION = '([^']+)'",
            (APP / "App.js").read_text(encoding="utf-8"),
        ).group(1),
    )


if __name__ == "__main__":
    main()
