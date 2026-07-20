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


def _app_version() -> str:
    try:
        return str(
            json.loads((ROOT / "app.json").read_text(encoding="utf-8-sig"))
            .get("expo", {})
            .get("version")
            or "1.3.5"
        )
    except Exception:
        return "1.3.5"


APP_VER = _app_version()


def _headers(extra: dict | None = None) -> dict:
    h = {
        "User-Agent": f"CommanderSmoke/{APP_VER}",
        "Accept": "application/json, text/html, */*",
        "X-App-Version": APP_VER,
        "X-App-Platform": "smoke",
    }
    if extra:
        h.update(extra)
    return h


def get(url: str, headers: dict | None = None, timeout: int = 12):
    req = urllib.request.Request(url, headers=_headers(headers))
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, dict(r.headers), r.read()


def post(url: str, data: dict, headers: dict | None = None, timeout: int = 12):
    raw = json.dumps(data).encode("utf-8")
    h = _headers({"Content-Type": "application/json"})
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

    print(f"=== Smoke (app {APP_VER}) ===")
    print("=== Files ===")
    apk = DIST / "apk" / "CommanderPro.apk"
    ipa = DIST / "ipa" / "CommanderPro.ipa"
    app_json = ROOT / "app.json"
    ok("app.json exists", app_json.is_file())
    ok(f"app version readable ({APP_VER})", bool(APP_VER and APP_VER != "—"))
    ok("APK present", apk.is_file(), f"{apk.stat().st_size if apk.is_file() else 0} bytes")
    ok("IPA present", ipa.is_file(), f"{ipa.stat().st_size if ipa.is_file() else 0} bytes")
    # Note: dist may still hold previous build until publish finishes
    if apk.is_file() and apk.stat().st_size < 1_000_000:
        ok("APK size sane", False, "too small")
    else:
        ok("APK size sane", True)
    if ipa.is_file() and ipa.stat().st_size < 1_000_000:
        ok("IPA size sane", False, "too small")
    else:
        ok("IPA size sane", True)

    print("\n=== Download server :8787 ===")
    try:
        st, hdrs, body = get(f"{DL}/downloads")
        html = body.decode("utf-8", errors="replace")
        ok("GET /downloads", st == 200)
        nosniff = str(hdrs.get("X-Content-Type-Options") or hdrs.get("x-content-type-options") or "")
        ok("security nosniff", "nosniff" in nosniff.lower(), nosniff or "missing")
        # page may still show previous version until dist binaries updated
        ok("has APK button", "Download APK" in html or "/downloads/apk" in html)
        ok("has IPA button", "Download IPA" in html or "/downloads/ipa" in html)
        try:
            get(f"{DL}/downloads/../../../etc/passwd")
            ok("path traversal blocked", False, "unexpected 200")
        except urllib.error.HTTPError as e:
            ok("path traversal blocked", e.code in (400, 404), str(e.code))
        except Exception as e:
            ok("path traversal blocked", True, type(e).__name__)
        # HEAD apk
        try:
            req = urllib.request.Request(
                f"{DL}/downloads/apk", headers=_headers(), method="HEAD"
            )
            with urllib.request.urlopen(req, timeout=12) as r:
                cl = r.headers.get("Content-Length")
                ok("HEAD /downloads/apk", r.status == 200 and cl and int(cl) > 1000, cl)
        except Exception as e:
            ok("HEAD /downloads/apk", False, str(e))
    except Exception as e:
        ok("GET /downloads", False, str(e))

    print("\n=== API :9601 ===")
    try:
        st, hdrs, body = get(f"{API}/api/health")
        health = json.loads(body.decode())
        ok("GET /api/health", st == 200 and health.get("ok") is True)
        ok("api has min_app_version", bool(health.get("min_app_version")))
        ok("api has latest", bool(health.get("latest_app_version")))
        nosniff = str(hdrs.get("X-Content-Type-Options") or hdrs.get("x-content-type-options") or "")
        ok("API security nosniff", "nosniff" in nosniff.lower(), nosniff or "missing")
        # force-update fields for soft prompt
        ok(
            "latest android/ios fields",
            bool(health.get("latest_app_version_android") or health.get("latest_app_version")),
        )

        code, payload = post(
            f"{API}/api/login",
            {"password": "definitely-wrong-password-xxx"},
        )
        ok(
            "bad login 401",
            code == 401 and payload.get("code") != "FORCE_UPDATE",
            f"{code} {payload.get('error') or payload.get('code')}",
        )

        code2, payload2 = post(f"{API}/api/login", {"password": "x" * 5000})
        ok(
            "oversize password rejected",
            code2 in (400, 401, 429) and payload2.get("code") != "FORCE_UPDATE",
            str(code2),
        )

        # Missing app version should force-update (426) on protected routes
        code3, payload3 = post(
            f"{API}/api/login",
            {"password": "x"},
            headers={
                "X-App-Version": "",  # overridden below
                "Content-Type": "application/json",
                "User-Agent": "CommanderSmoke/none",
            },
        )
        # Our post() always sets X-App-Version — test raw request without it
        raw = json.dumps({"password": "x"}).encode()
        req = urllib.request.Request(
            f"{API}/api/login",
            data=raw,
            headers={
                "Content-Type": "application/json",
                "User-Agent": "CommanderSmoke/none",
            },
            method="POST",
        )
        try:
            urllib.request.urlopen(req, timeout=12)
            ok("missing version → 426", False, "got 200")
        except urllib.error.HTTPError as e:
            ok("missing version → 426", e.code == 426, str(e.code))
    except Exception as e:
        ok("API checks", False, str(e))

    print("\n=== App source sanity ===")
    app_js = (ROOT / "App.js").read_text(encoding="utf-8")
    ok("IS_DEV defined", "const IS_DEV" in app_js)
    ok("GET dedupe", "_inflightGet" in app_js)
    ok("SoftUpdateModal", "function SoftUpdateModal" in app_js)
    ok("no raw token console.log", "String(pushToken).slice" not in app_js)
    ok("password min 8 client", "password.length < 8" in app_js)
    bg = (ROOT / "notificationBackground.js").read_text(encoding="utf-8")
    ok("bg version matches", f"APP_VERSION = '{APP_VER}'" in bg, APP_VER)

    print("\n=== Result ===")
    if failed:
        print(f"FAILED: {failed} check(s)")
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
