#!/usr/bin/env python3
"""Read-only check of ONE site account against its owner's Thndr emails (engine workflow account-check.yml, by hand):
every Thndr email since 2019 in the account's Gmail (dates, kinds, used or not and why), and each monthly statement's
month-end against the portfolio (matches / off by x%), via src/tools/account_check.js. Prints no amount, no address, no
name. Writes, sends and saves nothing.

    python3 account_check.py --engine DIR [--code DIR] --account N      (N: the account's number in the job's log)
Env: SETUP_KEY (the mail key)."""
import os, sys, json, argparse, tempfile, shutil, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import jobs_common as jc  # noqa: E402
import store  # noqa: E402
import run_account_mail as ram  # noqa: E402
import imap_fetch  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--engine", required=True)
    ap.add_argument("--code", default=jc.CODE_DEFAULT)
    ap.add_argument("--account", type=int, required=True)
    a = ap.parse_args(argv)
    keys = store.load_keys(os.path.join(a.code, "p", "khaled", "keys.json"))
    priv = store.unlock(keys, os.environ["SETUP_KEY"].strip())
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
