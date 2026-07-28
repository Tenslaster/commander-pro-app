#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Crew downloads — https://crew.kingdom.forum/downloads

  /downloads                 → HTML hub (Commander PRO + WithYou)
  /downloads/apk             → CommanderPro.apk
  /downloads/ipa             → CommanderPro.ipa
  /downloads/withyou         → WithYou download page
  /downloads/withyou/apk     → WithYou.apk
  /downloads/withyou/ipa     → WithYou.ipa (Sideloadly)

Local: http://0.0.0.0:8787/downloads
Cloudflare: path /downloads → :8787
"""

from __future__ import annotations

import html
import json
import mimetypes
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

HOST = os.environ.get("DOWNLOAD_HOST", "0.0.0.0")
PORT = int(os.environ.get("DOWNLOAD_PORT", "8787"))
PUBLIC_BASE = (
    os.environ.get("DOWNLOAD_PUBLIC_URL") or "https://crew.kingdom.forum/downloads"
).rstrip("/")

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
APK_NAME = "CommanderPro.apk"
IPA_NAME = "CommanderPro.ipa"
APK_PATH = (DIST / "apk" / APK_NAME).resolve()
IPA_PATH = (DIST / "ipa" / IPA_NAME).resolve()
APP_JSON = ROOT / "app.json"
VERSIONS_JSON = DIST / "versions.json"

# WithYou lives next to AppIPhone under RADIOS/
WITHYOU_DIST = (ROOT.parent.parent / "WithYou" / "dist").resolve()
WITHYOU_APK = (WITHYOU_DIST / "WithYou.apk").resolve()
WITHYOU_IPA = (WITHYOU_DIST / "WithYou.ipa").resolve()
# also accept Sideloadly filename if WithYou.ipa missing
WITHYOU_IPA_ALT = (WITHYOU_DIST / "WithYou-Sideloadly.ipa").resolve()

PREFIX = "/downloads"
CHUNK = 64 * 1024  # smaller chunks = better mobile / Cloudflare stream

mimetypes.add_type("application/vnd.android.package-archive", ".apk")
mimetypes.add_type("application/octet-stream", ".ipa")


def _app_version_fallback() -> str:
    env = (os.environ.get("APP_VERSION") or "").strip()
    if env:
        return env
    try:
        raw = APP_JSON.read_text(encoding="utf-8-sig")
        data = json.loads(raw)
        v = (data.get("expo") or {}).get("version") or data.get("version")
        if v:
            return str(v).strip()
    except Exception:
        pass
    return "—"


def _platform_versions() -> dict[str, str]:
    android = (os.environ.get("APK_VERSION") or "").strip()
    ios = (os.environ.get("IPA_VERSION") or "").strip()
    try:
        if VERSIONS_JSON.is_file():
            data = json.loads(VERSIONS_JSON.read_text(encoding="utf-8-sig"))
            if isinstance(data, dict):
                android = android or str(
                    data.get("android") or data.get("apk") or ""
                ).strip()
                ios = ios or str(data.get("ios") or data.get("ipa") or "").strip()
    except Exception:
        pass
    fallback = _app_version_fallback()
    return {
        "android": android or fallback,
        "ios": ios or fallback,
    }


def _size_label(path: Path) -> str:
    if not path.is_file():
        return "missing"
    n = path.stat().st_size
    if n >= 1024 * 1024:
        return f"{n / (1024 * 1024):.1f} MB"
    if n >= 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n} B"


def _safe_file(path: Path, *roots: Path) -> bool:
    try:
        if not path.is_file():
            return False
        real = path.resolve()
        for root in roots:
            dist_root = root.resolve()
            if str(real).startswith(str(dist_root) + os.sep) or real.parent == dist_root:
                return True
        return False
    except OSError:
        return False


def _withyou_ipa() -> Path:
    if WITHYOU_IPA.is_file():
        return WITHYOU_IPA
    return WITHYOU_IPA_ALT


def _card(
    platform: str, label: str, ok: bool, size: str, href: str, version: str, note: str = ""
) -> str:
    size_txt = html.escape(size) if ok else "Unavailable"
    ver_badge = html.escape(version) if version and version != "—" else "—"
    note_html = f'<p class="note">{html.escape(note)}</p>' if note else ""
    btn = (
        f'<a class="btn" href="{html.escape(href)}" download>{html.escape(label)}</a>'
        if ok
        else '<span class="btn off">Unavailable</span>'
    )
    return f"""
    <div class="card">
      <div class="row">
        <div>
          <h2>{html.escape(platform)} <span class="ver">v{ver_badge}</span></h2>
          <p class="meta">{size_txt}</p>
          {note_html}
        </div>
        {btn}
      </div>
    </div>
    """


def _styles() -> str:
    return """
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #05070c; color: #e2e8f0; padding: 32px 16px;
    }
    .wrap { width: 100%; max-width: 460px; }
    header { text-align: center; margin-bottom: 22px; }
    h1 { margin: 0; font-size: 1.5rem; font-weight: 700; letter-spacing: -0.02em; color: #f8fafc; }
    .brand {
      display: inline-block; margin-bottom: 10px; font-size: 0.72rem; font-weight: 600;
      letter-spacing: 0.14em; text-transform: uppercase; color: #38bdf8;
    }
    .brand.pink { color: #f472b6; }
    .version-pill {
      display: inline-block; margin-top: 12px; padding: 5px 12px; border-radius: 999px;
      font-size: 0.8rem; font-weight: 600; color: #7dd3fc;
      background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.28);
    }
    .section {
      margin: 18px 0 8px; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.08em;
      text-transform: uppercase; color: #64748b;
    }
    .card {
      background: #0b1220; border: 1px solid #1e293b; border-radius: 14px;
      padding: 18px 20px; margin-bottom: 12px;
    }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    h2 { margin: 0 0 4px; font-size: 1rem; font-weight: 600; color: #f1f5f9; }
    .ver { font-size: 0.78rem; font-weight: 600; color: #38bdf8; margin-left: 4px; }
    .meta { margin: 0; color: #64748b; font-size: 0.82rem; }
    .note { margin: 6px 0 0; color: #94a3b8; font-size: 0.75rem; line-height: 1.35; }
    a.btn, .btn.off {
      flex-shrink: 0; display: inline-block; text-decoration: none; font-size: 0.88rem;
      font-weight: 600; padding: 10px 16px; border-radius: 10px; white-space: nowrap;
    }
    a.btn { background: #38bdf8; color: #041016; }
    a.btn:hover { background: #7dd3fc; }
    a.btn.pink { background: #f472b6; color: #0f0a12; }
    a.btn.pink:hover { background: #f9a8d4; }
    .btn.off { background: #1e293b; color: #64748b; }
    .links { text-align: center; margin-top: 18px; font-size: 0.8rem; }
    .links a { color: #94a3b8; margin: 0 8px; }
    .links a:hover { color: #f8fafc; }
    """


def _hub_page() -> bytes:
    """Commander PRO only — WithYou lives at /downloads/withyou."""
    versions = _platform_versions()
    v_android = versions["android"]
    v_ios = versions["ios"]
    pill = (
        f"Android {v_android} · iPhone {v_ios}"
        if v_android != v_ios
        else f"Version {v_android}"
    )
    apk_ok = _safe_file(APK_PATH, DIST)
    ipa_ok = _safe_file(IPA_PATH, DIST)

    body = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>Commander PRO</title>
  <style>{_styles()}</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="brand">Commander PRO</div>
      <h1>Downloads</h1>
      <div class="version-pill">{html.escape(pill)}</div>
    </header>
    {_card("Android", "Download APK", apk_ok, _size_label(APK_PATH), f"{PREFIX}/apk", v_android)}
    {_card("iPhone", "Download IPA", ipa_ok, _size_label(IPA_PATH), f"{PREFIX}/ipa", v_ios, "Install with Sideloadly + free Apple ID")}
  </div>
</body>
</html>
"""
    return body.encode("utf-8")


def _withyou_page() -> bytes:
    wy_apk = _safe_file(WITHYOU_APK, WITHYOU_DIST)
    wy_ipa_path = _withyou_ipa()
    wy_ipa = _safe_file(wy_ipa_path, WITHYOU_DIST)
    # Absolute public URLs — more reliable than relative on mobile Chrome
    apk_href = f"{PUBLIC_BASE}/withyou/apk"
    ipa_href = f"{PUBLIC_BASE}/withyou/ipa"
    # Also point to main WithYou install host (same files via API tunnel)
    apk_href_main = "https://crew.kingdom.forum/withyou/install/apk"
    ipa_href_main = "https://crew.kingdom.forum/withyou/install/ipa"
    apk_size = _size_label(WITHYOU_APK)
    ipa_size = _size_label(wy_ipa_path)
    ver = "1.2.0"

    apk_btn = (
        f'<a class="btn pink big" href="{html.escape(apk_href)}" '
        f'download="WithYou.apk" type="application/vnd.android.package-archive">'
        f"Download APK ({html.escape(apk_size)})</a>"
        if wy_apk
        else '<span class="btn off big">APK missing on server</span>'
    )
    ipa_btn = (
        f'<a class="btn pink big" href="{html.escape(ipa_href)}" download="WithYou.ipa">'
        f"Download IPA ({html.escape(ipa_size)})</a>"
        if wy_ipa
        else '<span class="btn off big">IPA missing on server</span>'
    )

    body = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="robots" content="noindex,nofollow" />
  <meta name="theme-color" content="#0b0810" />
  <meta name="description" content="WithYou — private couple app. Download Android APK or iPhone IPA." />
  <title>WithYou · Install v{html.escape(ver)}</title>
  <style>
    {_styles()}
    body {{
      background: radial-gradient(1100px 560px at 50% -12%, #1a1024 0%, #0b0810 55%);
      padding: 24px 16px 48px;
    }}
    .wrap {{ max-width: 460px; }}
    .logo {{
      width: 64px; height: 64px; border-radius: 20px; display: flex; align-items: center;
      justify-content: center; font-size: 1.75rem; margin-bottom: 12px;
      background: linear-gradient(135deg, #fbcfe8, #f472b6 50%, #db2777);
      box-shadow: 0 10px 28px rgba(244,114,182,.35);
    }}
    header h1 {{ font-size: 2rem; letter-spacing: -0.03em; font-weight: 900; }}
    .tag {{ color: #a8b0c0; line-height: 1.55; margin: 10px 0 18px; font-size: 0.95rem; }}
    .feats {{ display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 18px; }}
    .feat {{
      background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.07);
      border-radius: 999px; padding: 6px 11px; font-size: 0.72rem; font-weight: 700; color: #cbd5e1;
    }}
    .card {{
      background: #16121f; border: 1px solid rgba(255,255,255,.07); border-radius: 20px;
      padding: 18px; margin-bottom: 14px; box-shadow: 0 12px 32px rgba(0,0,0,.28);
      flex-direction: column; align-items: stretch; gap: 0;
    }}
    .card h2 {{ margin: 0 0 4px; font-size: 1.08rem; }}
    .big {{
      width: 100%; text-align: center; margin-top: 4px; padding: 15px 16px !important;
      font-size: 0.98rem !important; border-radius: 14px !important;
      background: linear-gradient(135deg, #fb8ec4, #f472b6 50%, #e85a9e) !important;
      color: #1a0a12 !important; box-shadow: 0 8px 24px rgba(244,114,182,.28);
    }}
    .btn.off.big {{ background: #24182e !important; color: #64748b !important; box-shadow: none; }}
    .steps {{ color: #a8b0c0; font-size: 0.84rem; line-height: 1.55; margin: 14px 0 0; padding-left: 1.15rem; }}
    .steps li {{ margin-bottom: 5px; }}
    .warn {{ color: #fbbf24; font-size: 0.78rem; margin-top: 12px; line-height: 1.45; }}
    .note {{ color: #6b7289; font-size: 0.78rem; margin-top: 10px; line-height: 1.45; }}
    .url {{ word-break: break-all; color: #4b5163; font-size: 0.7rem; margin-top: 8px; }}
    .pair {{ border-left: 3px solid #f472b6; padding-left: 14px; }}
    .pair p {{ margin: 0; color: #a8b0c0; font-size: 0.88rem; line-height: 1.55; }}
    .pair strong {{ color: #f8fafc; }}
    .foot {{ text-align: center; margin-top: 22px; color: #4b5163; font-size: 0.72rem; line-height: 1.55; }}
    .alt a {{ color: #94a3b8; font-size: 0.8rem; }}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="logo">💕</div>
    <header>
      <div class="brand pink">WithYou</div>
      <h1>Install</h1>
      <div class="version-pill" style="color:#f9a8d4;background:rgba(244,114,182,0.12);border-color:rgba(244,114,182,0.28)">
        v{html.escape(ver)} · native only · APK + IPA
      </div>
      <p class="tag">Private couple presence for <strong>two phones</strong>. Live place, battery, care notes, SOS — no public web app.</p>
    </header>

    <div class="feats">
      <span class="feat">📍 Live place</span>
      <span class="feat">🔋 Battery</span>
      <span class="feat">💗 Care + SOS</span>
      <span class="feat">📊 Partner intel</span>
      <span class="feat">🔐 Your server</span>
    </div>

    <div class="card">
      <h2>Android APK</h2>
      <p class="meta">{html.escape(apk_size) if wy_apk else "Unavailable"} · com.withyou.pair · v{html.escape(ver)}</p>
      {apk_btn}
      <p class="url">{html.escape(apk_href)}</p>
      <ol class="steps">
        <li>Open this page in <strong>Chrome</strong> on Android</li>
        <li><strong>Uninstall</strong> any old WithYou first</li>
        <li>Tap <strong>Download APK</strong> (~70 MB — wait for it)</li>
        <li>Allow <strong>Install unknown apps</strong> for Chrome if asked</li>
        <li>Open the file → Install → open WithYou</li>
      </ol>
      <p class="note">Android uses a stable location card (opens Google Maps). In-app map is off to prevent crashes.</p>
      <p class="warn">Stuck download? Use Wi‑Fi. Mirror: {html.escape(apk_href_main)}</p>
    </div>

    <div class="card">
      <h2>iPhone IPA</h2>
      <p class="meta">{html.escape(ipa_size) if wy_ipa else "Unavailable"} · Sideloadly + free Apple ID · v{html.escape(ver)}</p>
      {ipa_btn}
      <p class="url">{html.escape(ipa_href)}</p>
      <ol class="steps">
        <li>Download IPA on a <strong>Windows PC</strong></li>
        <li>Open <strong>Sideloadly</strong> → drop IPA → free Apple ID</li>
        <li>Connect iPhone by USB → install</li>
        <li>iPhone: Settings → General → VPN &amp; Device Management → Trust</li>
        <li>iOS 16+: enable <strong>Developer Mode</strong> if asked</li>
        <li>Re-sign about every <strong>7 days</strong> (free cert)</li>
      </ol>
      <p class="note">Mirror: {html.escape(ipa_href_main)}</p>
    </div>

    <div class="card pair">
      <h2>How to pair</h2>
      <p>
        Phone A: <strong>Create pair</strong> → share the 6-character code.<br />
        Phone B: paste <strong>code only</strong> → <strong>Join pair</strong> (name optional).<br />
        Only one phone creates. Max 2 devices.
      </p>
    </div>

    <p class="foot">
      WithYou v{html.escape(ver)} · native apps only · no browser version<br />
      <span class="alt"><a href="https://crew.kingdom.forum/withyou">crew.kingdom.forum/withyou</a></span>
    </p>
  </div>
</body>
</html>
"""
    return body.encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "CrewDownloads/2.0"
    sys_version = ""

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _security_headers(self, *, for_file: bool = False) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Permissions-Policy",
            "geolocation=(), microphone=(), camera=(), payment=(), usb=()",
        )
        # APK/IPA must be downloadable from phone browsers; CORP same-site
        # has broken installs on some Android Chrome + Cloudflare combos.
        if for_file:
            self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
        else:
            self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'none'; style-src 'unsafe-inline'; "
                "img-src 'self' data:; font-src 'none'; connect-src 'none'; "
                "script-src 'none'; object-src 'none'; base-uri 'none'; "
                "form-action 'none'; frame-ancestors 'none'",
            )
        self.send_header(
            "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
        )

    def _normalize_path(self) -> str:
        raw = unquote(urlparse(self.path).path or "/")
        if ".." in raw or "\\" in raw:
            return "/__bad__"
        path = raw.rstrip("/") if raw not in (PREFIX, PREFIX + "/") else PREFIX
        if path == "":
            path = "/"
        return path

    def do_HEAD(self) -> None:  # noqa: N802
        self._handle(body=False)

    def do_GET(self) -> None:  # noqa: N802
        self._handle(body=True)

    def _handle(self, body: bool) -> None:
        path = self._normalize_path()
        if path == "/__bad__":
            self.send_error(400, "Bad path")
            return

        if path in ("/", PREFIX):
            data = _hub_page()
            self._send_html(data, body)
            return

        if path in (f"{PREFIX}/withyou", "/withyou"):
            data = _withyou_page()
            self._send_html(data, body)
            return

        if path in (f"{PREFIX}/apk", "/apk", f"/download/apk"):
            self._send_file(APK_PATH, APK_NAME, "application/vnd.android.package-archive", body, DIST)
            return

        if path in (f"{PREFIX}/ipa", "/ipa", f"/download/ipa"):
            self._send_file(IPA_PATH, IPA_NAME, "application/octet-stream", body, DIST)
            return

        if path in (f"{PREFIX}/withyou/apk", "/withyou/apk"):
            self._send_file(
                WITHYOU_APK, "WithYou.apk", "application/vnd.android.package-archive", body, WITHYOU_DIST
            )
            return

        if path in (f"{PREFIX}/withyou/ipa", "/withyou/ipa"):
            ipa = _withyou_ipa()
            self._send_file(ipa, "WithYou.ipa", "application/octet-stream", body, WITHYOU_DIST)
            return

        self.send_error(404, "Not found — use /downloads")

    def _send_html(self, data: bytes, body: bool) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self._security_headers(for_file=False)
        self.end_headers()
        if body:
            self.wfile.write(data)

    def _parse_range(self, size: int) -> tuple[int, int] | None:
        """Return (start, end) inclusive or None for full file."""
        raw = (self.headers.get("Range") or "").strip()
        if not raw.lower().startswith("bytes="):
            return None
        spec = raw.split("=", 1)[1].strip()
        if "," in spec:
            return None  # multi-range not supported
        if "-" not in spec:
            return None
        start_s, end_s = spec.split("-", 1)
        try:
            if start_s == "":
                # suffix: last N bytes
                n = int(end_s)
                if n <= 0:
                    return None
                start = max(0, size - n)
                end = size - 1
            else:
                start = int(start_s)
                end = int(end_s) if end_s else size - 1
            if start < 0 or start >= size or end < start:
                return None
            end = min(end, size - 1)
            return start, end
        except ValueError:
            return None

    def _send_file(
        self,
        file_path: Path,
        download_name: str,
        content_type: str,
        body: bool,
        root: Path,
    ) -> None:
        if not _safe_file(file_path, root):
            self.send_error(404, f"Missing file: {download_name}")
            return
        try:
            size = file_path.stat().st_size
        except OSError:
            self.send_error(404, f"Missing file: {download_name}")
            return

        safe_name = "".join(c for c in download_name if c.isalnum() or c in "._-")
        rng = self._parse_range(size)
        if rng is not None:
            start, end = rng
            length = end - start + 1
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Content-Length", str(length))
        else:
            start, end, length = 0, size - 1, size
            self.send_response(200)
            self.send_header("Content-Length", str(size))

        self.send_header("Content-Type", content_type)
        # filename* for Unicode-safe mobile clients
        self.send_header(
            "Content-Disposition",
            f'attachment; filename="{safe_name}"; filename*=UTF-8\'\'{safe_name}',
        )
        self.send_header("Accept-Ranges", "bytes")
        # public short cache helps flaky mobile networks re-request ranges
        self.send_header("Cache-Control", "public, max-age=300")
        self._security_headers(for_file=True)
        self.end_headers()
        if not body:
            return
        try:
            with open(file_path, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(CHUNK, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (OSError, BrokenPipeError, ConnectionResetError):
            pass


def main() -> int:
    print("=" * 52)
    print(" Downloads server")
    print("   /downloads          = Commander PRO only")
    print("   /downloads/withyou  = WithYou only")
    print("=" * 52)
    print(f" Commander APK: {'OK' if _safe_file(APK_PATH, DIST) else 'MISSING'}  {APK_PATH}")
    print(f" Commander IPA: {'OK' if _safe_file(IPA_PATH, DIST) else 'MISSING'}  {IPA_PATH}")
    print(f" WithYou APK:   {'OK' if _safe_file(WITHYOU_APK, WITHYOU_DIST) else 'MISSING'}  {WITHYOU_APK}")
    ipa = _withyou_ipa()
    print(f" WithYou IPA:   {'OK' if _safe_file(ipa, WITHYOU_DIST) else 'MISSING'}  {ipa}")
    print(f" Listen: http://{HOST}:{PORT}{PREFIX}")
    print()
    print(" Public:")
    print(f"   {PUBLIC_BASE}              (Commander)")
    print(f"   {PUBLIC_BASE}/withyou      (WithYou page)")
    print(f"   {PUBLIC_BASE}/withyou/apk")
    print(f"   {PUBLIC_BASE}/withyou/ipa")
    print("=" * 52)

    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
