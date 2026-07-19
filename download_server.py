#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Commander PRO — downloads at https://crew.kingdom.forum/downloads

  /downloads          → HTML page
  /downloads/apk      → CommanderPro.apk
  /downloads/ipa      → CommanderPro.ipa

Local default: http://0.0.0.0:8787/downloads
Cloudflare Tunnel should send path /downloads* to this server.
"""

from __future__ import annotations

import html
import json
import mimetypes
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

HOST = os.environ.get("DOWNLOAD_HOST", "0.0.0.0")
PORT = int(os.environ.get("DOWNLOAD_PORT", "8787"))
# Public base people use (must end with /downloads)
PUBLIC_BASE = (
    os.environ.get("DOWNLOAD_PUBLIC_URL") or "https://crew.kingdom.forum/downloads"
).rstrip("/")

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
APK_NAME = "CommanderPro.apk"
IPA_NAME = "CommanderPro.ipa"
APK_PATH = DIST / "apk" / APK_NAME
IPA_PATH = DIST / "ipa" / IPA_NAME
APP_JSON = ROOT / "app.json"

PREFIX = "/downloads"

mimetypes.add_type("application/vnd.android.package-archive", ".apk")
mimetypes.add_type("application/octet-stream", ".ipa")


def _app_version() -> str:
    """Read version from app.json (same as Expo builds)."""
    env = (os.environ.get("APP_VERSION") or "").strip()
    if env:
        return env
    try:
        data = json.loads(APP_JSON.read_text(encoding="utf-8"))
        v = (data.get("expo") or {}).get("version") or data.get("version")
        if v:
            return str(v).strip()
    except Exception:
        pass
    return "—"


def _size_label(path: Path) -> str:
    if not path.is_file():
        return "missing"
    n = path.stat().st_size
    if n >= 1024 * 1024:
        return f"{n / (1024 * 1024):.1f} MB"
    if n >= 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n} B"


def _page() -> bytes:
    apk_ok = APK_PATH.is_file()
    ipa_ok = IPA_PATH.is_file()
    version = _app_version()

    def card(platform: str, label: str, ok: bool, size: str, href: str) -> str:
        size_txt = html.escape(size) if ok else "Unavailable"
        ver_badge = html.escape(version) if version and version != "—" else "—"
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
            </div>
            {btn}
          </div>
        </div>
        """

    body = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Commander PRO</title>
  <style>
    :root {{ color-scheme: dark; }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #05070c;
      color: #e2e8f0;
      padding: 32px 16px;
    }}
    .wrap {{ width: 100%; max-width: 440px; }}
    header {{ text-align: center; margin-bottom: 28px; }}
    h1 {{
      margin: 0;
      font-size: 1.5rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: #f8fafc;
    }}
    .brand {{
      display: inline-block;
      margin-bottom: 10px;
      font-size: 0.72rem;
      font-weight: 600;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #38bdf8;
    }}
    .version-pill {{
      display: inline-block;
      margin-top: 12px;
      padding: 5px 12px;
      border-radius: 999px;
      font-size: 0.8rem;
      font-weight: 600;
      color: #7dd3fc;
      background: rgba(56, 189, 248, 0.12);
      border: 1px solid rgba(56, 189, 248, 0.28);
    }}
    .card {{
      background: #0b1220;
      border: 1px solid #1e293b;
      border-radius: 14px;
      padding: 18px 20px;
      margin-bottom: 12px;
    }}
    .row {{
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }}
    h2 {{
      margin: 0 0 4px;
      font-size: 1rem;
      font-weight: 600;
      color: #f1f5f9;
    }}
    .ver {{
      font-size: 0.78rem;
      font-weight: 600;
      color: #38bdf8;
      margin-left: 4px;
    }}
    .meta {{
      margin: 0;
      color: #64748b;
      font-size: 0.82rem;
    }}
    a.btn, .btn.off {{
      flex-shrink: 0;
      display: inline-block;
      text-decoration: none;
      font-size: 0.88rem;
      font-weight: 600;
      padding: 10px 16px;
      border-radius: 10px;
      white-space: nowrap;
    }}
    a.btn {{
      background: #38bdf8;
      color: #041016;
    }}
    a.btn:hover {{ background: #7dd3fc; }}
    .btn.off {{
      background: #1e293b;
      color: #64748b;
    }}
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="brand">Commander PRO</div>
      <h1>Downloads</h1>
      <div class="version-pill">Version {html.escape(version)}</div>
    </header>
    {card("Android", "Download APK", apk_ok, _size_label(APK_PATH), f"{PREFIX}/apk")}
    {card("iPhone", "Download IPA", ipa_ok, _size_label(IPA_PATH), f"{PREFIX}/ipa")}
  </div>
</body>
</html>
"""
    return body.encode("utf-8")


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def do_GET(self) -> None:  # noqa: N802
        raw = unquote(urlparse(self.path).path or "/")
        # Normalize trailing slash (except root of prefix)
        path = raw.rstrip("/") if raw != PREFIX and raw != PREFIX + "/" else raw.rstrip("/") or PREFIX
        if path == "":
            path = "/"

        # Accept both /downloads and /downloads/
        if path in ("/", PREFIX):
            data = _page()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return

        if path in (f"{PREFIX}/apk", "/apk", f"/download/apk"):
            self._send_file(APK_PATH, APK_NAME, "application/vnd.android.package-archive")
            return

        if path in (f"{PREFIX}/ipa", "/ipa", f"/download/ipa"):
            self._send_file(IPA_PATH, IPA_NAME, "application/octet-stream")
            return

        self.send_error(404, "Not found — use /downloads /downloads/apk /downloads/ipa")

    def _send_file(self, file_path: Path, download_name: str, content_type: str) -> None:
        if not file_path.is_file():
            self.send_error(404, f"Missing file: {download_name}")
            return
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header(
            "Content-Disposition",
            f'attachment; filename="{download_name}"',
        )
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def main() -> int:
    if not DIST.is_dir():
        print(f"ERROR: dist folder not found: {DIST}")
        return 1

    print("=" * 52)
    print(" Commander PRO — downloads")
    print("=" * 52)
    print(f" APK: {'OK' if APK_PATH.is_file() else 'MISSING'}  {APK_PATH}")
    print(f" IPA: {'OK' if IPA_PATH.is_file() else 'MISSING'}  {IPA_PATH}")
    print(f" Listen: http://{HOST}:{PORT}{PREFIX}")
    print()
    print(" Public URLs (via Cloudflare Tunnel):")
    print(f"   {PUBLIC_BASE}")
    print(f"   {PUBLIC_BASE}/apk")
    print(f"   {PUBLIC_BASE}/ipa")
    print("=" * 52)
    print(" Cloudflare: path /downloads* → http://127.0.0.1:%s" % PORT)
    print(" Ctrl+C to stop.")
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
