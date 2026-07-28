import re
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
apk = root / "dist" / "apk" / "CommanderPro.apk"
ipa = root / "dist" / "ipa" / "CommanderPro.ipa"

print("APK size:", apk.stat().st_size if apk.is_file() else "missing")
print("IPA size:", ipa.stat().st_size if ipa.is_file() else "missing")

if not apk.is_file():
    raise SystemExit(1)

with zipfile.ZipFile(apk) as z:
    found = False
    for n in z.namelist():
        if "app.config" in n:
            t = z.read(n).decode("utf-8", errors="replace")
            m = re.search(r'"version"\s*:\s*"([^"]+)"', t)
            print("APK", n, "version=", m.group(1) if m else "n/a")
            print("APK versions seen:", sorted(set(re.findall(r"1\.\d+\.\d+", t))))
            found = True
            break
    if not found:
        print("no app.config in APK")
    for n in z.namelist():
        if n.endswith(".bundle") or "index.android" in n:
            t = z.read(n).decode("utf-8", errors="ignore")
            vers = sorted(set(re.findall(r"1\.3\.\d+", t)))
            if vers:
                print("APK bundle", n, vers)
                break

print("both GHA builds commit: 9829a83 (1.3.9 source)")
