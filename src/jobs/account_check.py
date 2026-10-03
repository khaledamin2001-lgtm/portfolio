#!/usr/bin/env python3
"""Read-only check of ONE site account against its owner's Thndr emails (engine workflow account-check.yml, by hand):
every Thndr email since 2019 in the account's Gmail (dates, kinds, used or not and why), and each monthly statement's
month-end against the portfolio (matches / off by x%), via src/tools/account_check.js. Prints no amount, no address, no
name. Writes, sends and saves nothing.

    python3 account_check.py --engine DIR [--code DIR] --account N      (N: the account's number in the job's log)
    python3 account_check.py --engine DIR [--code DIR] --account N --dry-sync
        what the next inbox sync WOULD do: the same Gmail search window and seen ids as the real run, sync.js on a copy,
        then each email's kind, status and changes printed with every amount masked. Nothing is written or sent.
        --account 0 = the owner's main portfolio (the engine repo's db/, Gmail login from GMAIL_ADDRESS / GMAIL_APP_PASSWORD).
Env: SETUP_KEY (the mail key)."""
import os, sys, json, argparse, tempfile, shutil, subprocess, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import jobs_common as jc  # noqa: E402
import store  # noqa: E402
import run_account_mail as ram  # noqa: E402
import imap_fetch  # noqa: E402
import re  # noqa: E402

MASK = re.compile(r"-?\d[\d,]*(\.\d+)?")


def masked(s):
    """Amounts out, dates kept: dates are cut out first, every other number becomes #."""
    parts = re.split(r"(\b\d{4}-\d{2}-\d{2}\b)", str(s))
    return "".join(p if i % 2 else MASK.sub("#", p) for i, p in enumerate(parts))


def write_docs(docs, out):
    for k, v in docs.items():
        c, d = k.split("/", 1)
        if k in ("sync/gmail", "sync/mail"):
            continue
        os.makedirs(os.path.join(out, c), exist_ok=True)
        with open(os.path.join(out, c, d + ".json"), "w", encoding="utf-8") as f:
            json.dump({"id": d, "data": v["data"]}, f)


def dry_sync(a, docs, data, inbox, login, code, now):
    """Fetch exactly what the real run would and run sync.js on a copy; print masked results."""
    st = (docs.get("sync/state") or {}).get("data") or {}
    settings = (docs.get("portfolio/settings") or {}).get("data") or {}
    imports = {k.split("/", 1)[1]: (v or {}).get("data") or {} for k, v in docs.items() if k.startswith("imports/")}
    marks = ((docs.get("portfolio/marks") or {}).get("data") or {}).get("months")
    fallback = ram.gmail_after(code, st, settings, now)
    after = imap_fetch.mail_floor(settings, marks, imports, fallback)
    items = ((docs.get("portfolio/assets") or {}).get("data") or {}).get("items") or {}
    c = imap_fetch.fetch(after, imap_fetch.skip_ids(st.get("seen"), items), inbox, login.get("address"), login.get("appPassword"))
    print(json.dumps({"searchFrom": after, "previousWindowFrom": fallback, "found": c["found"], "new": c["kept"], "alreadySeen": c["seen"], "otherSubjects": c["otherSubject"]}))
    run = os.path.join(os.path.dirname(data), "run")
    r = subprocess.run(["node", os.path.join(code, "src", "tools", "sync.js"), "--data", data, "--inbox", inbox, "--out", run, "--today", now.strftime("%Y-%m-%d")],
                       capture_output=True, text=True, timeout=1200)
    if r.returncode != 0:
        print("sync.js failed: " + masked(jc.mask((r.stderr or r.stdout or "")[-300:])))
        return 1
    with open(os.path.join(run, "summary.json"), encoding="utf-8") as f:
        sm = json.load(f)
    day = lambda ms: datetime.datetime.fromtimestamp(int(ms) / 1000, datetime.timezone.utc).strftime("%Y-%m-%d")
    for e in sm.get("log") or []:
        print(json.dumps({"date": day(e.get("date") or 0), "kind": e.get("kind"), "status": e.get("status"), "period": e.get("period"),
                          "changes": [masked(x) for x in e.get("changes") or []], "notes": [masked(x) for x in e.get("notes") or []],
                          "reasons": [masked(x) for x in e.get("reasons") or []], "unchanged": e.get("unchanged")}))
    print(json.dumps({"wouldWrite": sm.get("writes"), "status": sm.get("status"), "applied": sm.get("applied"), "held": sm.get("held"), "healed": [masked(x) for x in sm.get("healed") or []]}))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--engine", required=True)
    ap.add_argument("--code", default=jc.CODE_DEFAULT)
    ap.add_argument("--account", type=int, required=True)
    ap.add_argument("--dry-sync", action="store_true")
    a = ap.parse_args(argv)
    keys = store.load_keys(os.path.join(a.code, "p", "khaled", "keys.json"))
    priv = store.unlock(keys, os.environ["SETUP_KEY"].strip())
    now = datetime.datetime.now(datetime.timezone.utc)
    if a.account == 0:   # the owner's main portfolio
        if not a.dry_sync:
            print("--account 0 needs --dry-sync")
            return 1
        docs = store.read_all(os.path.abspath(a.engine), keys, priv)
        work = tempfile.mkdtemp(prefix="check-", dir=os.environ.get("RUNNER_TEMP") or None)
        try:
            data, inbox = os.path.join(work, "data"), os.path.join(work, "inbox")
            write_docs(docs, data)
            return dry_sync(a, docs, data, inbox, {}, a.code, now)
        finally:
            shutil.rmtree(work, ignore_errors=True)
    http = ram.Http()
    pkgs = ram.list_packages(http)
    if not (1 <= a.account <= len(pkgs)):
        print(f"there are {len(pkgs)} accounts with email updates or Gmail; pick 1 to {len(pkgs)}")
        return 1
    pkg = ram.open_mail_pkg(priv, pkgs[a.account - 1]["pkg"])
    tok, uid = ram.id_token(http, pkg["refresh"])
    apriv, _ = ram.account_key(pkg["pk8"])
    docs = ram.read_account(http, tok, pkg["uid"], apriv)
    login = (docs.get("sync/gmail") or {}).get("data") or {}
    work = tempfile.mkdtemp(prefix="check-", dir=os.environ.get("RUNNER_TEMP") or None)
    try:
        data, inbox = os.path.join(work, "data"), os.path.join(work, "inbox")
        ram.materialize(docs, os.path.join(os.path.abspath(a.engine), "shared"), data)
        if a.dry_sync:
            if not login.get("address"):
                print("this account has no Gmail connected")
                return 1
            return dry_sync(a, docs, data, inbox, login, a.code, now)
        if not login.get("address"):
            print("this account has no Gmail connected")
        else:
            c = imap_fetch.fetch(ram.HISTORY_AFTER, set(), inbox, login["address"], login["appPassword"])
            print(f"Thndr emails in the Gmail since 2019: {c.get('kept', c)}")
        os.makedirs(inbox, exist_ok=True)
        r = subprocess.run(["node", os.path.join(a.code, "src", "tools", "account_check.js"), "--data", data, "--inbox", inbox], capture_output=True, text=True, timeout=1200)
        print(r.stdout.strip() or jc.mask((r.stderr or "")[-400:]))
        return r.returncode
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
