#!/usr/bin/env python3
"""The morning brief, before the EGX opens at 10:00 Cairo (engine workflow morning.yml, started Sunday to Thursday at 9:00
by the public repo's new-accounts watcher, src/jobs/kick_new_accounts.py morning_check).

    python3 run_morning.py --engine DIR [--code DIR] [--now ISO] [--manual] [--dry-run]

Every site account whose mail package says prefs.morning (the site owner's account unless switched off): its own
portfolio with the shared market data, tools/brief.js (engine2.js morningBrief: the last session, each holding's move,
ex-dividend and earnings dates in the next 7 days, holdings near their target or stop, unusual volume, limits, a 5%
index drop) and emails.morning to its own address only, once a day (sync/mail morningSent, encrypted to the account
key). An account failing never stops the others.
--evening: the after-close recap instead (engine workflow evening.yml, started Sunday to Thursday at 16:30 by the same
watcher, kick_new_accounts.py evening_check): the same brief for the session that just closed, for the accounts whose
prefs.evening is on (the owner's unless switched off), once a day (sync/mail eveningSent); sent only when the shared
market data already has today's close (none on an EGX holiday).
Not on Friday or Saturday (no session) unless --manual. Output: counts only. Exit 1 (and a FAILED email to the owner)
when the job could not run at all."""
import os, sys, json, argparse, datetime, hashlib, shutil, subprocess, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import jobs_common as jc  # noqa: E402
import emails  # noqa: E402

JOB = "morning brief"


def brief(code, data, today):
    r = subprocess.run(["node", os.path.join(code, "src", "tools", "brief.js"), "--data", data, "--today", today], capture_output=True, text=True, timeout=300)
    out = json.loads((r.stdout or "{}").strip().splitlines()[-1] if (r.stdout or "").strip() else "{}")
    if not out.get("ok"):
        raise jc.JobError("brief", out.get("error") or "brief.js failed")
    return out


def accounts_part(a, today, http, send):
    import run_account_mail as ram
    shared = os.path.join(os.path.abspath(a.engine), "shared")
    priv = jc.mail_key(a.code)
    pkgs = ram.list_packages(http)
    kind, mark, what = ("evening", "eveningSent", "after-close recap") if a.evening else ("morning", "morningSent", "morning brief")
    n = sent = bad = 0
    for i, p in enumerate(pkgs, 1):
        try:
            pkg = ram.open_mail_pkg(priv, p["pkg"])
            prefs = pkg.get("prefs") or {}
            if pkg.get("uid") != p["uid"] or not (prefs.get(kind) or kind not in prefs):
                continue     # switched off (a package without the choice may be the owner's: on unless switched off)
            tok, uid = ram.id_token(http, pkg["refresh"])
            if uid and uid != pkg["uid"]:
                raise jc.JobError("sign-in", "the package belongs to another account")
            owner = hashlib.sha256(str(ram.token_claims(tok).get("email") or "").lower().encode()).hexdigest() == ram.OWNER_HASH
            if not owner and not prefs.get(kind):
                continue     # anyone else only when ticked
            apriv, akeys = ram.account_key(pkg["pk8"])
            docs = ram.read_account(http, tok, pkg["uid"], apriv)
            n += 1
            if not ((docs.get("portfolio/settings") or {}).get("data") or {}).get("inception"):
                continue     # no portfolio yet
            state_doc = docs.get("sync/mail")
            state = dict((state_doc or {}).get("data") or {})
            if state.get(mark) == today and not a.manual:
                continue
            work = tempfile.mkdtemp(prefix="brief-", dir=os.environ.get("RUNNER_TEMP") or None)
            try:
                d = os.path.join(work, "data")
                ram.materialize(docs, shared, d)
                out = brief(a.code, d, today)
            finally:
                shutil.rmtree(work, ignore_errors=True)
            b = out["brief"]
            if not b.get("value") and not b.get("movers"):
                continue     # nothing in the portfolio yet
            if a.evening and b.get("session") != today:
                jc.log(f"account {i}: no close for {today} in the market data (a holiday, or not published yet)")
                continue
            name = ((docs.get("portfolio/settings") or {}).get("data") or {}).get("name") or "Your portfolio"
            subj, text, html = emails.morning(name, b, emails.ACCOUNT_FOOT, evening=a.evening)
            if a.dry_run:
                continue
            send(pkg["email"], subj, text, html)
            sent += 1
            state[mark] = today
            try:
                ram.write_state(http, tok, pkg["uid"], akeys, state_doc, state, jc.now_iso())
            except Exception as e:      # sent; the watcher starts this once a day, so a missed record repeats nothing
                jc.log(f"account {i}: brief sent, record not saved ({type(e).__name__})")
        except Exception as e:
            bad += 1
            jc.log(f"account {i}: not done ({getattr(e, 'step', type(e).__name__)}: {jc.mask(str(getattr(e, 'detail', e)))[:160]})")
    return f"accounts: {len(pkgs)} with email updates, {n} with the {what}, {sent} sent, {bad} not done"


def main(argv=None, http=None, send=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--engine", required=True)
    ap.add_argument("--code", default=jc.CODE_DEFAULT)
    ap.add_argument("--now")
    ap.add_argument("--manual", action="store_true", help="also on Friday / Saturday, and again the same day")
    ap.add_argument("--dry-run", action="store_true", help="make the briefs, send and save nothing")
    ap.add_argument("--evening", action="store_true", help="the after-close recap instead of the morning brief")
    a = ap.parse_args(argv)
    import zoneinfo
    t = datetime.datetime.fromisoformat(a.now.replace("Z", "+00:00")) if a.now else datetime.datetime.now(datetime.timezone.utc)
    cairo = t.astimezone(zoneinfo.ZoneInfo("Africa/Cairo"))
    today = cairo.strftime("%Y-%m-%d")
    if cairo.strftime("%a") in ("Fri", "Sat") and not a.manual:
        jc.log(f"{'after-close recap' if a.evening else 'morning brief'}: no session on {cairo.strftime('%A')}")
        return 0
    try:
        import run_account_mail as ram
        jc.log(accounts_part(a, today, http or ram.Http(), send or (None if a.dry_run else ram.smtp_sender())))
        return 0
    except Exception as e:
        jc.report_failure(None, "after-close recap" if a.evening else JOB, getattr(e, "step", "accounts"), str(getattr(e, "detail", e)), engine=a.engine, code=a.code)
        return 1


if __name__ == "__main__":
    sys.exit(main())
