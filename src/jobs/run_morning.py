#!/usr/bin/env python3
"""The morning brief, before the EGX opens at 10:00 Cairo (engine workflow morning.yml, started Sunday to Thursday at 9:00
by the public repo's new-accounts watcher, src/jobs/kick_new_accounts.py morning_check).

    python3 run_morning.py --engine DIR [--code DIR] [--now ISO] [--manual] [--dry-run]

1. The owner's main portfolio (config.json "morningBrief", default on for portfolioId "khaled"): decrypt it, run
   tools/brief.js (engine2.js morningBrief: the last session, each holding's move, ex-dividend and earnings dates in the
   next 7 days, holdings near their target or stop, unusual volume, limits, a 5% index drop) and email emails.morning to
   the portfolio's recipient, once a day (jobs.json morning.sent).
2. Every site account whose mail package says prefs.morning: its own portfolio with the shared market data, to its own
   address only, once a day (sync/mail morningSent, encrypted to the account key). The owner's own sign-in account is
   skipped (it has no portfolio of its own). An account failing never stops the others.
Not on Friday or Saturday (no session) unless --manual. Output: counts only. The owner's part failing emails a FAILED
notice to the owner; exit 1 when nothing at all could be done."""
import os, sys, json, argparse, datetime, hashlib, shutil, subprocess, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import jobs_common as jc  # noqa: E402
import store  # noqa: E402
import emails  # noqa: E402

JOB = "morning brief"


def brief(code, data, today):
    r = subprocess.run(["node", os.path.join(code, "src", "tools", "brief.js"), "--data", data, "--today", today], capture_output=True, text=True, timeout=300)
    out = json.loads((r.stdout or "{}").strip().splitlines()[-1] if (r.stdout or "").strip() else "{}")
    if not out.get("ok"):
        raise jc.JobError("brief", out.get("error") or "brief.js failed")
    return out


def owner_part(a, today, send_owner):
    ctx = jc.Ctx(a.engine, a.code, a.now)
    if ctx.config.get("movedToAccount"):
        return "owner: the portfolio moved to the owner's account (its brief goes with the accounts)"
    if not ctx.config.get("morningBrief", ctx.config.get("portfolioId") == "khaled"):
        return "owner: not switched on"
    if (jc.jobs_state(ctx).get("morning") or {}).get("sent") == today and not a.manual:
        return "owner: already sent today"
    data = os.path.join(ctx.workdir(), "data")
    ctx.materialize(data)
    out = brief(ctx.code, data, today)
    subj, text, html = emails.morning(out.get("name") or ctx.config.get("portfolioId"), out["brief"])
    if a.dry_run:
        return "owner: brief made (dry run, not sent)"
    jc.log("owner: " + send_owner(ctx, subj, text, html))
    jc.record_job(ctx, "morning", {"sent": today}, f"jobs: morning brief {today}")
    return "owner: sent"


def accounts_part(a, today, http, send):
    import run_account_mail as ram
    shared = os.path.join(os.path.abspath(a.engine), "shared")
    keys = store.load_keys(os.path.join(a.code, "p", "khaled", "keys.json"))
    key = os.environ.get("SETUP_KEY", "").strip()
    if not key:
        raise jc.JobError("mail key", "SETUP_KEY is not set")
    priv = store.unlock(keys, key)
    pkgs = ram.list_packages(http)
    moved = jc.main_moved(os.path.abspath(a.engine))   # the owner's portfolio lives in the owner's account: its brief is here
    n = sent = bad = 0
    for i, p in enumerate(pkgs, 1):
        try:
            pkg = ram.open_mail_pkg(priv, p["pkg"])
            prefs = pkg.get("prefs") or {}
            if pkg.get("uid") != p["uid"] or not (prefs.get("morning") or (moved and "morning" not in prefs)):
                continue
            tok, uid = ram.id_token(http, pkg["refresh"])
            if uid and uid != pkg["uid"]:
                raise jc.JobError("sign-in", "the package belongs to another account")
            owner = hashlib.sha256(str(ram.token_claims(tok).get("email") or "").lower().encode()).hexdigest() == ram.OWNER_HASH
            if owner and not moved:
                continue     # the owner's sign-in account before the move: the main portfolio's brief is the owner's
            if not owner and not prefs.get("morning"):
                continue     # the owner's moved portfolio gets the brief unless switched off; anyone else when ticked
            apriv, akeys = ram.account_key(pkg["pk8"])
            docs = ram.read_account(http, tok, pkg["uid"], apriv)
            if owner and not ((docs.get("portfolio/settings") or {}).get("data") or {}).get("migratedFrom"):
                continue
            n += 1
            if not ((docs.get("portfolio/settings") or {}).get("data") or {}).get("inception"):
                continue     # no portfolio yet
            state_doc = docs.get("sync/mail")
            state = dict((state_doc or {}).get("data") or {})
            if state.get("morningSent") == today and not a.manual:
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
            name = ((docs.get("portfolio/settings") or {}).get("data") or {}).get("name") or "Your portfolio"
            subj, text, html = emails.morning(name, b, emails.ACCOUNT_FOOT)
            if a.dry_run:
                continue
            send(pkg["email"], subj, text, html)
            sent += 1
            state["morningSent"] = today
            try:
                ram.write_state(http, tok, pkg["uid"], akeys, state_doc, state, jc.now_iso())
            except Exception as e:      # sent; the watcher starts this once a day, so a missed record repeats nothing
                jc.log(f"account {i}: brief sent, record not saved ({type(e).__name__})")
        except Exception as e:
            bad += 1
            jc.log(f"account {i}: not done ({getattr(e, 'step', type(e).__name__)}: {jc.mask(str(getattr(e, 'detail', e)))[:160]})")
    return f"accounts: {len(pkgs)} with email updates, {n} with the morning brief, {sent} sent, {bad} not done"


def main(argv=None, http=None, send=None, send_owner=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--engine", required=True)
    ap.add_argument("--code", default=jc.CODE_DEFAULT)
    ap.add_argument("--now")
    ap.add_argument("--manual", action="store_true", help="also on Friday / Saturday, and again the same day")
    ap.add_argument("--dry-run", action="store_true", help="make the briefs, send and save nothing")
    a = ap.parse_args(argv)
    import zoneinfo
    t = datetime.datetime.fromisoformat(a.now.replace("Z", "+00:00")) if a.now else datetime.datetime.now(datetime.timezone.utc)
    cairo = t.astimezone(zoneinfo.ZoneInfo("Africa/Cairo"))
    today = cairo.strftime("%Y-%m-%d")
    if cairo.strftime("%a") in ("Fri", "Sat") and not a.manual:
        jc.log(f"morning brief: no session on {cairo.strftime('%A')}")
        return 0
    ok = 0
    try:
        import mail_send
        jc.log(owner_part(a, today, send_owner or mail_send.send))
        ok += 1
    except jc.JobError as e:
        jc.report_failure(None, JOB, e.step, e.detail, engine=a.engine, code=a.code)
    except Exception as e:
        jc.report_failure(None, JOB, "owner", f"{type(e).__name__}: {e}", engine=a.engine, code=a.code)
    try:
        import run_account_mail as ram
        jc.log(accounts_part(a, today, http or ram.Http(), send or (None if a.dry_run else ram.smtp_sender())))
        ok += 1
    except Exception as e:
        jc.log(f"accounts: not done ({getattr(e, 'step', type(e).__name__)}: {jc.mask(str(getattr(e, 'detail', e)))[:160]})")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
