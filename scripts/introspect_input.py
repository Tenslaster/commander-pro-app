import json
import os
import urllib.request
from pathlib import Path

session = json.loads(
    (Path(os.environ["USERPROFILE"]) / ".expo" / "state.json").read_text(encoding="utf-8")
)["auth"]["sessionSecret"]


def gql(q, v=None):
    body = json.dumps({"query": q, "variables": v or {}}).encode()
    req = urllib.request.Request(
        "https://api.expo.dev/graphql",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "expo-session": session},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


print(
    json.dumps(
        gql(
            """
{
  __type(name: "GoogleServiceAccountKeyInput") {
    inputFields { name type { kind name ofType { kind name ofType { name } } } }
  }
}
"""
        ),
        indent=2,
    )
)

# accountId - is it owner account id?
print(
    json.dumps(
        gql(
            """
query($id: String!) {
  app {
    byId(appId: $id) {
      id
      ownerAccount { id name }
    }
  }
}
""",
            {"id": "ad3981e1-443b-40ec-9a35-83052e532a16"},
        ),
        indent=2,
    )
)
