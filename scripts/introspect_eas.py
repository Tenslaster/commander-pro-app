import json
import os
import urllib.request
from pathlib import Path

expo = json.loads(
    (Path(os.environ["USERPROFILE"]) / ".expo" / "state.json").read_text(encoding="utf-8")
)
session = expo["auth"]["sessionSecret"]


def gql(query, variables=None):
    body = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = urllib.request.Request(
        "https://api.expo.dev/graphql",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "expo-session": session,
            "User-Agent": "fcm-setup",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


for name in [
    "GoogleServiceAccountKeyMutation",
    "AndroidAppCredentialsMutation",
    "GoogleServiceAccountKey",
    "Mutation",
]:
    q = f"""
    {{
      __type(name: \"{name}\") {{
        name
        fields {{
          name
          args {{
            name
            type {{ kind name ofType {{ kind name ofType {{ name kind }} }} }}
          }}
        }}
      }}
    }}
    """
    print("====", name)
    data = gql(q)
    t = data.get("data", {}).get("__type")
    if not t:
        print(data)
        continue
    fields = t.get("fields") or []
    for f in fields:
        if any(
            x in f["name"].lower()
            for x in ["fcm", "google", "service", "android", "credential"]
        ):
            print(f["name"], f.get("args"))
