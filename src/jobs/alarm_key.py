#!/usr/bin/env python3
"""The "on-time alarm" key reminder (engine workflow alarm-key.yml, started by the public repo's new-accounts watcher
14, 7, 3, 2 and 1 days before the key expires): emails Khaled how to renew the GitHub key that the cron-job.org alarms
and the watcher use (secret ENGINE_TOKEN in the site repo).

    python3 alarm_key.py --engine DIR [--code DIR] --expires YYYY-MM-DD
Env: SETUP_KEY, GMAIL_ADDRESS / GMAIL_APP_PASSWORD. Exit 0 when sent."""
import os, sys, argparse, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import jobs_common as jc  # noqa: E402


def reminder(expires, today):
    """(subject, text, html) of the reminder (src/jobs/emails.py)."""
    import emails
    return emails.alarm_key(expires, today)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--engine", required=True)
    ap.add_argument("--code")
    ap.add_argument("--expires", required=True)
    a = ap.parse_args(argv)
    try:
        expires = datetime.date.fromisoformat(a.expires.strip())
    except ValueError:
        print("not sent: --expires is not a date")
        return 1
    try:
        import mail_send
        ctx = jc.Ctx(a.engine, a.code)
        subj, text, html = reminder(expires, datetime.date.fromisoformat(ctx.today()))
        jc.log("email: " + mail_send.send(ctx, subj, text, html))
        return 0
    except jc.JobError as e:
        jc.log(f"FAILED: {e.step}: {jc.mask(e.detail)}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
