#!/usr/bin/env python3
"""The email run's gate (engine workflow email-run.yml, step 1): is this firing one of the day's three checks?

    python3 email_gate.py --engine DIR [--code DIR] [--manual] [--now ISO]

Schedule: email-run.yml at 16:15, 18:15 and 23:00 Cairo (started on time by cron-job.org; GitHub's own timers are a
late backup). A firing counts only inside a slot window - "afternoon" 16:15-18:14, "evening" 18:15-22:59, "night"
23:00-23:59 and "after midnight" 00:00-06:59 Cairo (a late-started 11 pm run, only when last night's check is missing) -
when jobs.json has no check of that slot today. It writes ran=true|false to GITHUB_OUTPUT; the site accounts step
(run_account_mail.py) follows it. --manual (Run workflow) always counts and is not recorded as a slot.
Once a day it also reads when SITE_TOKEN (the jobs' key to the site repository) expires; 14 days before, the site owner
gets one email with the renewal steps.
Output: one line; exit 1 (and a FAILED email to the owner) only when the gate itself could not decide.
"""
import os, sys, argparse, datetime, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import jobs_common as jc  # noqa: E402

# the three checks (4:15 pm, 6:15 pm, 11 pm Cairo), each window lasting until the next; GitHub starts scheduled runs hours
# late at times, so a run after midnight still counts once as last night's check
WINDOWS = [("afternoon", 16 * 60 + 15, 18 * 60 + 15), ("evening", 18 * 60 + 15, 23 * 60), ("night", 23 * 60, 24 * 60), ("after midnight", 0, 7 * 60)]
JOB = "email run"
SITE_REPO = "khaledamin2001-lgtm/portfolio"


def token_check(ctx, today, jobs):
    """SITE_TOKEN's expiry (GitHub's token-expiration header), once a day; one reminder 14 days before."""
    tok = os.environ.get("SITE_TOKEN", "").strip()
    sj = jobs.setdefault("sync", {})
    if not tok or sj.get("tokenCheckedOn") == today:
        return None
    sj["tokenCheckedOn"] = today
    try:
        req = urllib.request.Request(f"https://api.github.com/repos/{ctx.config.get('siteRepo') or SITE_REPO}",
                                     headers={"Authorization": f"Bearer {tok}", "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            exp = r.headers.get("github-authentication-token-expiration")
    except Exception as e:
        return f"token check skipped ({type(e).__name__})"
    if not exp:
        return "token has no expiry"
    try:
        d = datetime.datetime.strptime(exp.strip()[:10], "%Y-%m-%d").date()
    except ValueError:
        return "token expiry unreadable"
    t = datetime.date.fromisoformat(today)
    if (d - t).days > 14:
        return f"token valid until {d}"
    if sj.get("tokenWarned") == str(d):
        return f"token expires {d} (already warned)"
    import mail_send, emails
    subj, text, html = emails.token(d, t)
    mail_send.send(ctx, subj, text, html)
    sj["tokenWarned"] = str(d)
    return f"token expires {d}: reminder emailed"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--engine", required=True)
    ap.add_argument("--code")
    ap.add_argument("--manual", action="store_true")
    ap.add_argument("--now")
    a = ap.parse_args(argv)
    ctx, step = None, "setup"
    try:
        ctx = jc.Ctx(a.engine, a.code, a.now)
        jc.engine_refresh(ctx)
        step = "plan"
        plan = ctx.plan()
        jobs = jc.jobs_state(ctx)
        done = (jobs.get("sync") or {}).get("slots") or {}
        slot, why = jc.gate(plan, WINDOWS, done, a.manual)
        if slot == "after midnight":   # only for a late-started 11 pm check: last night's check must be missing
            yday = (datetime.date.fromisoformat(plan["today"]) - datetime.timedelta(days=1)).isoformat()
            if done.get("night") == yday or (done.get("after midnight") or "") >= plan["today"]:
                slot, why = None, "last night's check already happened"
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as fh:
                fh.write(f"ran={'true' if slot else 'false'}\n")
        if not slot:
            jc.log(f"email run: skipped ({why}; Cairo {plan['nowCairo'][11:16]})")
            return 0
        jc.log(f"email run: {why}, {plan['today']} Cairo {plan['nowCairo'][11:16]}")
        step = "token check"
        try:
            t = token_check(ctx, plan["today"], jobs)
            if t:
                jc.log(t)
        except Exception as e:      # a missed reminder never stops the accounts' check
            jc.log(f"token check not done ({type(e).__name__})")
        step = "record"
        sj = jobs.setdefault("sync", {})
        if slot != "manual":
            sj.setdefault("slots", {})[slot] = plan["today"]
        sj.update({"at": jc.now_iso(), "status": "ok", "lastSlot": slot})
        rec = dict(sj)
        for attempt in range(3):
            j2 = jc.jobs_state(ctx)
            j2["sync"] = rec
            jc.save_jobs_state(ctx, j2)
            try:
                jc.engine_commit(ctx, ["jobs.json"], f"jobs: email run {plan['today']} {slot}")
                break
            except jc.PushRejected:
                jc.engine_refresh(ctx)
        return 0
    except jc.JobError as e:
        jc.report_failure(ctx, JOB, e.step, e.detail, a.engine, a.code)
        return 1
    except Exception as e:
        jc.report_failure(ctx, JOB, step, f"{type(e).__name__}: {e}", a.engine, a.code)
        return 1
    finally:
        if ctx:
            ctx.cleanup()


if __name__ == "__main__":
    sys.exit(main())
