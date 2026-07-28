from pathlib import Path

app = Path(__file__).resolve().parents[1] / "App.js"
i18n = Path(__file__).resolve().parents[1] / "i18n.js"
t = app.read_text(encoding="utf-8")
i = i18n.read_text(encoding="utf-8")

fallback = t[t.find("Fallback if no tab") : t.find("Fallback if no tab") + 400]
safe = t[t.find("const safeMainTab") : t.find("const safeMainTab") + 250]

checks = {
    "fallback_has_stats": "'stats'" in fallback,
    "safeMainTab_has_stats": "'stats'" in safe,
    "guard_stats": "mainTab === 'stats'" in t,
    "statsFetchGen": "statsFetchGenRef" in t,
    "logout_clears_stats": "setStatsPayload(null)" in t,
    "station_race_guard": "payload.station !== station" in t,
    "no_hardcoded_unknown": "Onglet inconnu" not in t,
    "appCache_import": "from './appCache'" in t,
    "version_141": "APP_VERSION = '1.4.1'" in t,
    "nav_stats_fr_en": i.count("'nav.stats'") >= 2,
    "tab_stats_fr_en": i.count("'tab.stats'") >= 2,
    "compare_day": i.count("'stats.compare.day'") >= 2,
    "life_tips": i.count("'stats.life.tips'") >= 2,
}

ok = True
for k, v in checks.items():
    print(("OK  " if v else "FAIL"), k)
    ok = ok and v

# bot matrix
root = Path(r"C:\Users\cedri\OneDrive\Bureau\RADIOS")
for n in range(1, 11):
    bot = (root / f"RADIO{n}" / f"HighriseRadio{n}.py").read_text(encoding="utf-8")
    need = [
        "handle_transfert_command",
        "from station_activity import",
        "Gold transferred out",
        "songs=1",
    ]
    missing = [x for x in need if x not in bot]
    if missing:
        print("FAIL R%d" % n, missing)
        ok = False
    else:
        print("OK   R%d bot" % n)

print("RESULT", "PASS" if ok else "FAIL")
