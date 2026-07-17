#!/usr/bin/env python3
import pathlib, re, os

paths = [
    "/usr/local/bin/builder",
    "/tmp/bldr",
]
for p in paths:
    path = pathlib.Path(p)
    if not path.exists():
        print("missing", p)
        continue
    try:
        d = path.read_bytes()
    except Exception as e:
        print("read fail", p, e)
        continue
    print("size", p, len(d))
    s = d.decode("latin1", "ignore")
    # printable-ish strings
    strs = re.findall(r"[ -~]{6,120}", s)
    keys = [x for x in strs if re.search(r"token|keychain|keyring|credential|github|secret|\.config|oauth", x, re.I)]
    for k in sorted(set(keys))[:80]:
        print(k)
