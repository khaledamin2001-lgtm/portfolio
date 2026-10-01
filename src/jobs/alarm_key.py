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
    left = (expires - today).days
    when = "tomorrow" if left == 1 else f"in {left} days"
    d = f"{expires.day} {expires.strftime('%b %Y')}"
    text = (f"The GitHub key that keeps your portfolio on time expires {when} ({d}).\n\n"
            "It is the key named \"on-time alarm\". The cron-job.org alarms use it to start the market update at 3:40 pm and "
            "the Thndr email checks at 4:15 pm, 6:15 pm and 11 pm, and the site uses it to start a new friend's account within "
            "minutes. Once it expires, the updates still happen, but up to a few hours late (on GitHub's own timers).\n\n"
            "To renew it (5 minutes):\n"
            "1. GitHub → your photo → Settings → Developer settings → Personal access tokens → Fine-grained tokens → "
            "\"on-time alarm\" → Regenerate token. Copy the new key (it starts with github_pat_).\n"
            "2. cron-job.org → each of the 4 jobs → Advanced → Headers → in \"Authorization\", replace the old key after "
            "\"Bearer \" with the new one → Save.\n"
            "3. GitHub → the portfolio repository → Settings → Secrets and variables → Actions → ENGINE_TOKEN → Update → "
            "paste the new key.\n\n"
            "Don't paste the key anywhere else (not in emails or chats).\n")
    return f"Portfolio: on-time alarm key expires {d}", text


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
        subj, text = reminder(expires, datetime.date.fromisoformat(ctx.today()))
        jc.log("email: " + mail_send.send(ctx, subj, text))
        return 0
    except jc.JobError as e:
        jc.log(f"FAILED: {e.step}: {jc.mask(e.detail)}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
