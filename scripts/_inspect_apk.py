#!/usr/bin/env python3
import re
import zipfile
from pathlib import Path

apk = Path(__file__).resolve().parents[1] / "dist" / "apk" / "CommanderPro.apk"
with zipfile.ZipFile(apk) as z:
    names = z.namelist()
    print("count", len(names), "size", apk.stat().st_size)
    for n in names:
        low = n.lower()
        if any(
            x in low
            for x in (
                "bundle",
                "hbc",
                "app.config",
                "manifest",
                "assets/index",
                "hermes",
                ".js",
            )
        ):
            info = z.getinfo(n)
            print(f"{info.file_size:10d}  {n}")
    for n in names:
        if "app.config" in n:
            t = z.read(n).decode("utf-8", "replace")
            m = re.search(r'"version"\s*:\s*"([^"]+)"', t)
            print("VERSION", m.group(1) if m else "?", "from", n)
            print(t[:300])
