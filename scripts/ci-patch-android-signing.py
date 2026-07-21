#!/usr/bin/env python3
"""CI helper: make Gradle release builds use app/debug.keystore."""
from __future__ import annotations

import re
from pathlib import Path


def main() -> int:
    p = Path("app/build.gradle")
    if not p.is_file():
        p = Path("app/build.gradle.kts")
    if not p.is_file():
        print("No app/build.gradle found")
        return 1
    if p.suffix == ".kts":
        print("Kotlin DSL not supported by this patcher")
        return 1

    text = p.read_text(encoding="utf-8")
    if "signingConfigs" not in text:
        text = text.replace(
            "android {",
            """android {
    signingConfigs {
        release {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
""",
            1,
        )
    if "signingConfig signingConfigs.release" not in text:
        text = re.sub(
            r"(release\s*\{)",
            r"\1\n            signingConfig signingConfigs.release",
            text,
            count=1,
        )
    p.write_text(text, encoding="utf-8")
    print("Patched", p.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
