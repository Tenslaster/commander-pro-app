import json
import re
from pathlib import Path

app = Path(r"C:\Users\cedri\OneDrive\Bureau\RADIOS\AppIPhone\iphone-batch-manager")
bm = Path(r"C:\Users\cedri\OneDrive\Bureau\RADIOS\Batch_Manager")

d = json.loads((app / "app.json").read_text(encoding="utf-8-sig"))
d["expo"]["version"] = "1.3.7"
(app / "app.json").write_text(
    json.dumps(d, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
)

t = (app / "App.js").read_text(encoding="utf-8")
t = t.replace("'1.3.6'", "'1.3.7'")
(app / "App.js").write_text(t, encoding="utf-8")

t = (app / "notificationBackground.js").read_text(encoding="utf-8")
t = re.sub(r"APP_VERSION = '[^']+'", "APP_VERSION = '1.3.7'", t)
(app / "notificationBackground.js").write_text(t, encoding="utf-8")

p = json.loads((bm / "app_version_policy.json").read_text(encoding="utf-8-sig"))
p["latest_app_version"] = "1.3.7"
p["latest_app_version_android"] = "1.3.7"
p["latest_app_version_ios"] = "1.3.7"
p["min_app_version"] = "1.3.1"
p["soft_message_fr"] = (
    "Commander PRO 1.3.7: 10 radios, filtre Admin, securite renforcee."
)
p["soft_message_en"] = (
    "Commander PRO 1.3.7: 10 radios, Admin filter, stronger security."
)
(bm / "app_version_policy.json").write_text(
    json.dumps(p, indent=2) + "\n", encoding="utf-8"
)

(app / "dist" / "versions.json").write_text(
    json.dumps(
        {"android": "1.3.7", "ios": "1.3.7", "note": "10 radios security admin"},
        indent=2,
    )
    + "\n",
    encoding="utf-8",
)

env = (bm / "api_server.env").read_text(encoding="utf-8")
env = re.sub(r"LATEST_APP_VERSION=.*", "LATEST_APP_VERSION=1.3.7", env)
env = re.sub(r"(?m)^APP_VERSION=.*", "APP_VERSION=1.3.7", env)
(bm / "api_server.env").write_text(env, encoding="utf-8")

print("OK 1.3.7")
