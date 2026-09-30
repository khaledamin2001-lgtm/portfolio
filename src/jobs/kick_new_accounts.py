#!/usr/bin/env python3
"""Start the account job right away for a brand-new account, once (.github/workflows/new-accounts.yml, every 5 minutes).

    python3 kick_new_accounts.py [--window-min 60] [--dry-run]

A site account that turns on email updates or connects its Gmail writes mail/{uid} (its sealed package; the rules let
anyone list these, nobody open them). When one of those was CREATED in the last --window-min minutes and the private
repo's "Account emails" workflow has not started since it was last written, that workflow is started now (so a new
friend's portfolio is built within minutes instead of at the next hourly run). Nothing about an account is printed:
only how many are new and what was done. Env ENGINE_TOKEN: a fine-grained GitHub token for the private repo with
"Actions: Read and write" (a repository secret); without it the script says so and exits 0.
Exit 0 whatever it found, 1 when Firestore or GitHub could not be reached."""
import os, sys, json, argparse, datetime, urllib.request, urllib.error

FS = "https://firestore.googleapis.com/v1/projects/portfolio-desk-4d14a/databases/(default)/documents/mail"
GH = "https://api.github.com/repos/khaledamin2001-lgtm/portfolio-engine/actions/workflows/account-mail.yml"


def when(s):
    """RFC 3339 (Firestore's nanoseconds or GitHub's seconds) as an aware datetime."""
    s = s.replace("Z", "+00:00")
    if "." in s:
        head, rest = s.split(".", 1)
        frac, tz = rest[:rest.index("+")] if "+" in rest else rest, rest[rest.index("+"):] if "+" in rest else "+00:00"
        s = f"{head}.{frac[:6]}{tz}"
    return datetime.datetime.fromisoformat(s)


def get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--window-min", type=int, default=60)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--now")
    a = ap.parse_args(argv)
    now = when(a.now) if a.now else datetime.datetime.now(datetime.timezone.utc)
    try:
        docs, page = [], ""
        while True:
            d = get(f"{FS}?pageSize=300&mask.fieldPaths=none" + (f"&pageToken={page}" if page else ""))
            docs += d.get("documents") or []
            page = d.get("nextPageToken")
            if not page:
                break
    except (urllib.error.URLError, ValueError) as e:
        print(f"could not list the accounts ({type(e).__name__})")
        return 1
    new = [x for x in docs if now - when(x["createTime"]) <= datetime.timedelta(minutes=a.window_min)]
    if not new:
        print(f"{len(docs)} accounts, none new")
        return 0
    token = os.environ.get("ENGINE_TOKEN", "").strip()
    if not token:
        print(f"{len(new)} new account(s), but ENGINE_TOKEN is not set: they wait for the next hourly run")
        return 0
    hdr = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    latest = max(when(x["updateTime"]) for x in new)
    try:
        runs = get(f"{GH}/runs?per_page=5", hdr).get("workflow_runs") or []
    except (urllib.error.URLError, ValueError) as e:
        print(f"could not read the account job's runs ({type(e).__name__}: {getattr(e, 'code', '')})")
        return 1
    if any(when(r["created_at"]) >= latest for r in runs):
        print(f"{len(new)} new account(s), already handled by a run started since")
        return 0
    if a.dry_run:
        print(f"{len(new)} new account(s): would start the account job now (dry run)")
        return 0
    req = urllib.request.Request(f"{GH}/dispatches", data=json.dumps({"ref": "main"}).encode(), headers={**hdr, "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            r.read()
    except urllib.error.URLError as e:
        print(f"could not start the account job ({type(e).__name__}: {getattr(e, 'code', '')})")
        return 1
    print(f"{len(new)} new account(s): the account job was started now")
    return 0


if __name__ == "__main__":
    sys.exit(main())
