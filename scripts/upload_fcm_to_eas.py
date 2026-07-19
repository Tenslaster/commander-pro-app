#!/usr/bin/env python3
"""Upload FCM V1 service account key to Expo EAS for Android push.

Flow (Expo GraphQL):
  1) resolve app + ownerAccount.id + androidAppCredentials
  2) createGoogleServiceAccountKey(accountId, { jsonKey: <SA dict> })
  3) setGoogleServiceAccountKeyForFcmV1(credentialsId, keyId)
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SA_PATH = ROOT / "credentials" / "fcm-service-account.json"
APP_JSON = ROOT / "app.json"
EXPO_STATE = Path(os.environ["USERPROFILE"]) / ".expo" / "state.json"
PACKAGE = "com.commanderpro.radios"
GRAPHQL = "https://api.expo.dev/graphql"


def load_session() -> str:
    data = json.loads(EXPO_STATE.read_text(encoding="utf-8"))
    auth = data.get("auth") or {}
    session = auth.get("sessionSecret")
    if not session and isinstance(auth.get("user"), dict):
        session = auth["user"].get("sessionSecret")
    if not session:
        raise SystemExit("No Expo session in ~/.expo/state.json — run: npx eas-cli login")
    return session


def gql(session: str, query: str, variables: dict | None = None) -> dict:
    body = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = urllib.request.Request(
        GRAPHQL,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "expo-session": session,
            "User-Agent": "commander-pro-fcm-setup",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            payload = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"GraphQL HTTP {e.code}: {e.read().decode()[:800]}")
    if payload.get("errors"):
        raise SystemExit(f"GraphQL errors: {json.dumps(payload['errors'], indent=2)[:1000]}")
    return payload.get("data") or {}


def main() -> int:
    if not SA_PATH.is_file():
        print("Missing", SA_PATH)
        return 1
    sa = json.loads(SA_PATH.read_text(encoding="utf-8"))
    print("SA email:", sa.get("client_email"))
    print("SA project:", sa.get("project_id"))

    app = json.loads(APP_JSON.read_text(encoding="utf-8-sig"))
    project_id = app["expo"]["extra"]["eas"]["projectId"]
    print("EAS projectId:", project_id)

    session = load_session()
    print("Expo session: ok")

    data = gql(
        session,
        """
        query($id: String!) {
          app {
            byId(appId: $id) {
              id
              fullName
              ownerAccount { id name }
              androidAppCredentials {
                id
                applicationIdentifier
                googleServiceAccountKeyForFcmV1 { id clientEmail projectIdentifier }
              }
            }
          }
        }
        """,
        {"id": project_id},
    )
    app_node = ((data.get("app") or {}).get("byId")) or {}
    print("App:", app_node.get("fullName"), app_node.get("id"))
    owner = app_node.get("ownerAccount") or {}
    account_id = owner.get("id")
    print("Owner:", owner.get("name"), account_id)
    if not account_id:
        print("FAIL: no ownerAccount id")
        return 1

    creds = app_node.get("androidAppCredentials") or []
    print("Existing android credentials:", len(creds))
    for c in creds:
        print(" -", c.get("id"), c.get("applicationIdentifier"), c.get("googleServiceAccountKeyForFcmV1"))

    match = next((c for c in creds if c.get("applicationIdentifier") == PACKAGE), None)
    if not match and creds:
        match = creds[0]

    if not match:
        print("Creating Android app credentials for", PACKAGE)
        data = gql(
            session,
            """
            mutation($appId: ID!, $identifier: String!, $input: AndroidAppCredentialsInput!) {
              androidAppCredentials {
                createAndroidAppCredentials(
                  appId: $appId
                  applicationIdentifier: $identifier
                  androidAppCredentialsInput: $input
                ) {
                  id
                  applicationIdentifier
                }
              }
            }
            """,
            {"appId": project_id, "identifier": PACKAGE, "input": {}},
        )
        match = ((data.get("androidAppCredentials") or {}).get("createAndroidAppCredentials")) or {}
        print("created:", match)

    if not match or not match.get("id"):
        print("FAIL: no androidAppCredentials. Manual: npx eas-cli credentials -p android")
        return 2

    cred_id = match["id"]
    print("Using credentials id:", cred_id)

    existing = match.get("googleServiceAccountKeyForFcmV1")
    if existing and existing.get("clientEmail") == sa.get("client_email"):
        print("SUCCESS: FCM V1 already set:", existing)
        return 0

    # Create key on Expo account (jsonKey = full SA dict)
    data = gql(
        session,
        """
        mutation($accountId: ID!, $input: GoogleServiceAccountKeyInput!) {
          googleServiceAccountKey {
            createGoogleServiceAccountKey(
              accountId: $accountId
              googleServiceAccountKeyInput: $input
            ) {
              id
              clientEmail
              projectIdentifier
            }
          }
        }
        """,
        {"accountId": account_id, "input": {"jsonKey": sa}},
    )
    created = ((data.get("googleServiceAccountKey") or {}).get("createGoogleServiceAccountKey")) or {}
    key_id = created.get("id")
    print("Created key:", created)
    if not key_id:
        print("FAIL: createGoogleServiceAccountKey returned no id")
        return 3

    data = gql(
        session,
        """
        mutation($id: ID!, $keyId: ID!) {
          androidAppCredentials {
            setGoogleServiceAccountKeyForFcmV1(
              id: $id
              googleServiceAccountKeyId: $keyId
            ) {
              id
              googleServiceAccountKeyForFcmV1 { id clientEmail projectIdentifier }
            }
          }
        }
        """,
        {"id": cred_id, "keyId": key_id},
    )
    print("Assigned:", json.dumps(data, indent=2)[:600])

    # Verify
    data = gql(
        session,
        """
        query($id: String!) {
          app {
            byId(appId: $id) {
              androidAppCredentials {
                id
                applicationIdentifier
                googleServiceAccountKeyForFcmV1 { id clientEmail projectIdentifier }
              }
            }
          }
        }
        """,
        {"id": project_id},
    )
    print("VERIFY:")
    print(json.dumps(data, indent=2)[:1200])
    creds = ((data.get("app") or {}).get("byId") or {}).get("androidAppCredentials") or []
    ok = any(c.get("googleServiceAccountKeyForFcmV1") for c in creds)
    if ok:
        print("SUCCESS: FCM V1 key is on EAS")
        return 0
    print("PARTIAL: verify failed")
    return 4


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as e:
        print("ERROR", e)
        raise
