#!/usr/bin/env python3
"""CI helper: ensure release buildType signs with app/debug.keystore."""
from __future__ import annotations

import re
from pathlib import Path


RELEASE_CFG = """
        release {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
"""


def main() -> int:
    p = Path("app/build.gradle")
    if not p.is_file():
        print("No app/build.gradle")
        return 1

    text = p.read_text(encoding="utf-8")

    # Strip any previous broken references we may have injected
    text = re.sub(
        r"\n[ \t]*signingConfig signingConfigs\.release[ \t]*\n",
        "\n",
        text,
    )

    # 1) Ensure signingConfigs { ... release { ... } ... }
    if re.search(r"signingConfigs\s*\{[^}]*release\s*\{", text, re.S):
        print("signingConfigs.release already present")
    elif re.search(r"signingConfigs\s*\{", text):
        # Insert release config inside existing signingConfigs block
        text = re.sub(
            r"(signingConfigs\s*\{)",
            r"\1" + RELEASE_CFG,
            text,
            count=1,
        )
        print("Inserted release into existing signingConfigs")
    else:
        text = text.replace(
            "android {",
            "android {\n    signingConfigs {" + RELEASE_CFG + "\n    }\n",
            1,
        )
        print("Created signingConfigs with release")

    # 2) Point buildTypes.release at signingConfigs.release
    # Match buildTypes { ... release { ... } carefully
    m = re.search(r"buildTypes\s*\{", text)
    if not m:
        print("WARNING: no buildTypes block")
    else:
        # Find the release { inside buildTypes — first "release {" after buildTypes
        start = m.end()
        sub = text[start:]
        rm = re.search(r"\brelease\s*\{", sub)
        if not rm:
            print("WARNING: no release buildType")
        else:
            abs_i = start + rm.end()
            # insert right after "release {"
            insert = "\n            signingConfig signingConfigs.release"
            # only if not already there in next ~400 chars
            window = text[abs_i : abs_i + 400]
            if "signingConfig signingConfigs.release" not in window:
                text = text[:abs_i] + insert + text[abs_i:]
                print("Added signingConfig to buildTypes.release")
            else:
                print("buildTypes.release already has signingConfig")

    p.write_text(text, encoding="utf-8")
    print("Wrote", p.resolve())
    for i, line in enumerate(text.splitlines(), 1):
        if any(
            k in line
            for k in (
                "signingConfig",
                "signingConfigs",
                "storeFile",
                "debug.keystore",
            )
        ):
            print(f"  L{i}: {line.rstrip()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
