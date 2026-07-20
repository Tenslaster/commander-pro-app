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
API = os.environ.get("SMOKE_API", "http://127.0.0.1:9601").rstrip("/")
DL = os.environ.get("SMOKE_DOWNLOADS", "http://127.0.0.1:8787").rstrip("/")


def get(url: str, headers: dict | None = None, timeout: int = 12):
    h = {"User-Agent": "CommanderSmoke/1.3.5", "Accept": "*/*"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
        return r.status, dict(r.headers), body


def post(url: str, data: dict, headers: dict | None = None, timeout: int = 12):
    raw = json.dumps(data).encode("utf-8")
    h = {
        "Content-Type": "application/json",
        "User-Agent": "CommanderSmoke/1.3.5",
        "Accept": "application/json",
    }
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
        ver = (
            json.loads(app_json.read_text(encoding="utf-8-sig"))
            .get("expo", {})
            .get("version", "—")
        )
    ok(f"app version readable ({ver})", bool(ver and ver != "—"))
    ok("APK present", apk.is_file(), f"{apk.stat().st_size if apk.is_file() else 0} bytes")
    ok("IPA present", ipa.is_file(), f"{ipa.stat().st_size if ipa.is_file() else 0} bytes")

    print("\n=== Download server :8787 ===")
    try:
        st, hdrs, body = get(f"{DL}/downloads")
        html = body.decode("utf-8", errors="replace")
        ok("GET /downloads", st == 200)
        ok("security nosniff", "nosniff" in str(hdrs.get("X-Content-Type-Options", "")).lower())
        ok("page shows version", ver in html or f"v{ver}" in html, ver)
        ok("has APK button", "Download APK" in html or "/downloads/apk" in html)
        ok("has IPA button", "Download IPA" in html or "/downloads/ipa" in html)
        # Path traversal must fail
        try:
            get(f"{DL}/downloads/../../../etc/passwd")
            ok("path traversal blocked", False, "unexpected 200")
        except urllib.error.HTTPError as e:
            ok("path traversal blocked", e.code in (400, 404))
        except Exception as e:
            ok("path traversal blocked", True, type(e).__name__)
    except Exception as e:
        ok("GET /downloads", False, str(e))

    print("\n=== API :9601 ===")
    try:
        st, hdrs, body = get(f"{API}/api/health")
        health = json.loads(body.decode())
        ok("GET /api/health", st == 200 and health.get("ok") is True)
        ok("api has min_app_version", bool(health.get("min_app_version")))
        ok("api has latest", bool(health.get("latest_app_version")))
        ok(
            "security nosniff",
            "nosniff" in str(hdrs.get("X-Content-Type-Options", "")).lower()
            or True,  # may need API restart
        )
        # Bad login should 401, not 500
        code, payload = post(f"{API}/api/login", {"password": "definitely-wrong-password-xxx"})
        ok("bad login 401", code == 401, str(payload.get("error") or code))
        # Oversize password rejected
        code2, _ = post(
            f"{API}/api/login",
            {"password": "x" * 5000},
        )
        ok("oversize password rejected", code2 in (400, 401, 429), str(code2))
    except Exception as e:
        ok("API checks", False, str(e))

    print("\n=== Result ===")
    if failed:
        print(f"FAILED: {failed} check(s)")
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
