import json
import re
import pathlib

root = pathlib.Path(__file__).resolve().parents[1]
app = json.loads((root / "app.json").read_text(encoding="utf-8-sig"))
print("source app.json:", app["expo"]["version"], "versionCode", app["expo"]["android"]["versionCode"])
print("App.js:", re.search(r"APP_VERSION = '([^']+)'", (root / "App.js").read_text(encoding="utf-8")).group(1))
print("bg:", re.search(r"APP_VERSION = '([^']+)'", (root / "notificationBackground.js").read_text(encoding="utf-8")).group(1))

ipa_cfg = pathlib.Path(r"C:/Users/cedri/AppData/Local/Temp/ipa-inspect-139/Payload/CommanderPRO.app/EXConstants.bundle/app.config")
if ipa_cfg.is_file():
    t = ipa_cfg.read_text(encoding="utf-8", errors="replace")
    m = re.search(r'"version"\s*:\s*"([^"]+)"', t)
    print("IPA embedded version:", m.group(1) if m else "not found")
    print("IPA versions seen:", sorted(set(re.findall(r"1\.\d+\.\d+", t))))
else:
    print("IPA config missing")

apk = root / "dist" / "apk" / "CommanderPro.apk"
ipa = root / "dist" / "ipa" / "CommanderPro.ipa"
for p in (apk, ipa):
    if p.is_file():
        st = p.stat()
        print(f"local {p.name}: {st.st_size} bytes mtime={st.st_mtime}")
    else:
        print(f"local {p.name}: missing")
