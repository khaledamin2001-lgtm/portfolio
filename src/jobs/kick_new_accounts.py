#!/usr/bin/env python3
"""Start the account job right away for a brand-new account, once (.github/workflows/new-accounts.yml, every 5 minutes).

    python3 kick_new_accounts.py [--window-min 60] [--dry-run]

A site account that turns on email updates or connects its Gmail writes mail/{uid} (its sealed package; the rules let
anyone list these, nobody open them). When one of those was CREATED in the last --window-min minutes and the private
repo's "Account emails" workflow has not started since it was last written, that workflow is started now (so a new
friend's portfolio is built within minutes instead of at the next check). Nothing about an account is printed:
only how many are new and what was done.
Once a day (from 10:00 Cairo time; the reminder's own runs show whether today's went out) it also reads when ENGINE_TOKEN expires - the same key the
on-time alarms at cron-job.org use - and 14, 7, 3, 2 and 1 days before, starts the private repo's "Alarm key reminder"
workflow, which emails Khaled how to renew it (once that key has expired it can start nothing, so the warning comes first). Env ENGINE_TOKEN: a fine-grained GitHub token for the private repo with
"Actions: Read and write" (a repository secret); without it the script says so and exits 0.
Exit 0 whatever it found, 1 when Firestore or GitHub could not be reached."""
import os, sys, json, argparse, datetime, urllib.request, urllib.error

FS = "https://firestore.googleapis.com/v1/projects/portfolio-desk-4d14a/databases/(default)/documents/mail"
ENGINE = "https://api.github.com/repos/khaledamin2001-lgtm/portfolio-engine"
GH = ENGINE + "/actions/workflows/account-mail.yml"
EMAIL_RUN = ENGINE + "/actions/workflows/email-run.yml"
KEY_WF = ENGINE + "/actions/workflows/alarm-key.yml"
WARN_DAYS = (14, 7, 3, 2, 1)


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


def key_check(now, token, dry=False):
    """The daily alarm-key check (see the docstring). Returns a log line, or None outside the daily window."""
    from zoneinfo import ZoneInfo
    cairo = now.astimezone(ZoneInfo("Africa/Cairo"))
    if not token or cairo.hour < 10:
        return None
    hdr = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    try:
        with urllib.request.urlopen(urllib.request.Request(ENGINE, headers=hdr), timeout=30) as r:
            exp = r.headers.get("github-authentication-token-expiration")
    except urllib.error.URLError as e:
        return f"alarm key: could not check ({type(e).__name__}: {getattr(e, 'code', '')})"
    if not exp:
        return "alarm key: no expiry date"
    d = datetime.date.fromisoformat(exp.strip()[:10])
    left = (d - cairo.date()).days
    if left not in WARN_DAYS:
        return f"alarm key: valid until {d}"
    try:
        runs = get(f"{KEY_WF}/runs?per_page=5", hdr).get("workflow_runs") or []
    except (urllib.error.URLError, ValueError) as e:
        return f"alarm key: expires {d}; could not read the reminder's runs ({type(e).__name__})"
    if any(when(r["created_at"]).astimezone(ZoneInfo("Africa/Cairo")).date() == cairo.date() for r in runs):
        return f"alarm key: expires {d}; reminder already sent today"
    if dry:
        return f"alarm key: expires {d}; would send the reminder (dry run)"
    req = urllib.request.Request(f"{KEY_WF}/dispatches", data=json.dumps({"ref": "main", "inputs": {"expires": str(d)}}).encode(),
                                 headers={**hdr, "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            r.read()
    except urllib.error.URLError as e:
        return f"alarm key: expires {d}; could not start the reminder ({type(e).__name__}: {getattr(e, 'code', '')})"
    return f"alarm key: expires {d}; reminder started"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--window-min", type=int, default=60)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--now")
    a = ap.parse_args(argv)
    now = when(a.now) if a.now else datetime.datetime.now(datetime.timezone.utc)
    kc = key_check(now, os.environ.get("ENGINE_TOKEN", "").strip(), a.dry_run)
    if kc:
        print(kc)
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
        print(f"{len(new)} new account(s), but ENGINE_TOKEN is not set: they wait for the next check")
        return 0
    hdr = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    latest = max(when(x["updateTime"]) for x in new)
    try:
        runs = get(f"{GH}/runs?per_page=5", hdr).get("workflow_runs") or []
        email_runs = get(f"{EMAIL_RUN}/runs?per_page=5", hdr).get("workflow_runs") or []
    except (urllib.error.URLError, ValueError) as e:
        print(f"could not read the account job's runs ({type(e).__name__}: {getattr(e, 'code', '')})")
        return 1
    if any(when(r["created_at"]) >= latest for r in runs):
        print(f"{len(new)} new account(s), already handled by a run started since")
        return 0
    # never alongside the scheduled email run or another account run (both would email the same account): wait for them
    # to finish; the next check (5 minutes) starts it if it is still needed (a second run finds nothing new to send)
    if any(r.get("status") in ("queued", "in_progress", "waiting", "requested", "pending") for r in runs + email_runs):
        print(f"{len(new)} new account(s): an email or account run is going; checking again next time")
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
