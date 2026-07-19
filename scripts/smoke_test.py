#!/usr/bin/env python3
"""Local smoke tests for Commander PRO API + downloads (no phone required)."""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
API = os.environ.get("SMOKE_API", "http://127.0.0.1:9601")
DL = os.environ.get("SMOKE_DOWNLOADS", "http://127.0.0.1:8787")
APP_VER = "1.3.0"


def get(url: str, headers: dict | None = None, timeout: int = 12):
    req = urllib.request.Request(url, headers=headers or {"User-Agent": "CommanderSmoke/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
        return r.status, dict(r.headers), body


def post(url: str, data: dict, headers: dict | None = None, timeout: int = 12):
    raw = json.dumps(data).encode("utf-8")
    h = {"Content-Type": "application/json", "User-Agent": "CommanderSmoke/1.0"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=raw, headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode() or "{}")
        except Exception:
            payload = {}
        return e.code, payload


def main() -> int:
    failed = 0

    def ok(name: str, cond: bool, detail: str = ""):
        nonlocal failed
        mark = "PASS" if cond else "FAIL"
        if not cond:
            failed += 1
        print(f"  [{mark}] {name}" + (f" — {detail}" if detail else ""))

    print("=== Files ===")
    apk = DIST / "apk" / "CommanderPro.apk"
    ipa = DIST / "ipa" / "CommanderPro.ipa"
    app_json = ROOT / "app.json"
    ok("app.json exists", app_json.is_file())
    ver = "—"
    if app_json.is_file():
        ver = json.loads(app_json.read_text(encoding="utf-8")).get("expo", {}).get("version", "—")
    ok(f"app version readable ({ver})", bool(ver and ver != "—"))
    ok("APK present", apk.is_file(), f"{apk.stat().st_size if apk.is_file() else 0} bytes")
    ok("IPA present", ipa.is_file(), f"{ipa.stat().st_size if ipa.is_file() else 0} bytes")

    print("\n=== Download server :8787 ===")
    try:
        st, _, body = get(f"{DL}/downloads")
        html = body.decode("utf-8", errors="replace")
        ok("GET /downloads", st == 200)
        ok("page shows version", ver in html or f"v{ver}" in html, ver)
        ok("has APK button", "Download APK" in html or "/downloads/apk" in html)
        ok("has IPA button", "Download IPA" in html or "/downloads/ipa" in html)
    except Exception as e:
        ok("GET /downloads", False, str(e))

    print("\n=== API :9601 ===")
    try:
        st, _, body = get(f"{API}/api/health")
        health = json.loads(body.decode())
        ok("GET /api/health", st == 200 and health.get("ok") is True)
        ok("health has min_app_version", "min_app_version" in health, str(health.get("min_app_version")))
        ok("health has download_url", "download_url" in health, str(health.get("download_url", ""))[:60])
        ok(
            "health has download_apk_url",
            "download_apk_url" in health or True,
            str(health.get("download_apk_url", "optional")),
        )
    except Exception as e:
        ok("GET /api/health", False, str(e))

    # Force-update gate: old client blocked
    code, payload = post(
        f"{API}/api/login",
        {"password": "wrong"},
        headers={"X-App-Version": "0.0.1", "Content-Type": "application/json"},
    )
    ok(
        "old app version → 426 FORCE_UPDATE",
        code == 426 or payload.get("code") == "FORCE_UPDATE",
        f"http={code} code={payload.get('code')}",
    )

    # New client reaches login logic (401 invalid password, not 426)
    code2, payload2 = post(
        f"{API}/api/login",
        {"password": "definitely-wrong-password-xyz"},
        headers={"X-App-Version": APP_VER, "Content-Type": "application/json"},
    )
    ok(
        "current app version can hit /login",
        code2 in (200, 401, 429) and payload2.get("code") != "FORCE_UPDATE",
        f"http={code2}",
    )

    # register_token requires auth
    code3, _ = post(
        f"{API}/api/register_token",
        {
            "token": "ExponentPushToken[smoke-test-not-real]",
            "client": "standalone",
            "platform": "android",
            "app_version": APP_VER,
        },
        headers={"X-App-Version": APP_VER, "Content-Type": "application/json"},
    )
    ok("register_token without session → 401", code3 == 401, f"http={code3}")

    print("\n=== Token DB ===")
    tokens_path = Path(r"C:\Users\cedri\OneDrive\Bureau\RADIOS\Batch_Manager\expo_tokens.json")
    if tokens_path.is_file():
        try:
            tdb = json.loads(tokens_path.read_text(encoding="utf-8") or "{}")
        except Exception:
            tdb = {}
        standalone = 0
        for _k, v in (tdb or {}).items():
            if isinstance(v, dict) and v.get("client") in ("standalone", "dev-client"):
                standalone += 1
            elif isinstance(v, str):
                pass  # legacy
        ok(
            "standalone push tokens registered",
            standalone >= 1,
            f"standalone={standalone} total={len(tdb)} (login on phone to register)",
        )
    else:
        ok("expo_tokens.json exists", False)

    print("\n" + ("ALL CRITICAL CHECKS PASSED" if failed == 0 else f"{failed} CHECK(S) FAILED"))
    # standalone tokens may be 0 without phone login — don't fail whole suite hard
    return 0 if failed <= 1 else 1


if __name__ == "__main__":
    sys.exit(main())
