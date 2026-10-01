#!/usr/bin/env python3
"""Send one email through Gmail SMTP (smtp.gmail.com:465, SSL) from GMAIL_ADDRESS with GMAIL_APP_PASSWORD.

The only allowed recipient is the portfolio's own portfolio/settings.factsheetEmail (decrypted from the engine repo);
any other address is refused. Plain text body plus an optional HTML alternative; attachments only for the portfolio's
own month-end files (workbook and PDF factsheet). run_account_mail.py uses build() for a site account's own address.

    python3 mail_send.py --engine DIR [--code DIR] --subject S --text FILE [--html FILE] [--to ADDR]
    python3 mail_send.py --failure JOB --engine DIR [--code DIR] [--step S] [--error E]
        the workflow's last-resort failure step: "Portfolio: <JOB> FAILED <Cairo date>". Skipped when the job already
        emailed its own failure (marker file, see jobs_common.failure_mark). When the settings cannot be decrypted
        (e.g. the setup key itself is the problem) it falls back to GMAIL_ADDRESS - the sender's own mailbox.

Shadow mode (config.json "mode" is not "live"): nothing is sent; the message is saved encrypted (site public key) as
outbox/<Cairo date>/<time>-<n>.enc.json in the engine repo, for comparing with what the Claude jobs sent.
Env for tests: SMTP_HOST, SMTP_PORT, SMTP_SSL=0 (plain SMTP). Prints one status line, never the message or a secret."""
import os, re, sys, ssl, json, time, smtplib, argparse, datetime
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import jobs_common as jc  # noqa: E402
import store  # noqa: E402

ADDR = re.compile(r"^[^@\s,;<>\"']+@[^@\s,;<>\"']+\.[A-Za-z]{2,}$")


def _sender():
    a = os.environ.get("GMAIL_ADDRESS", "").strip()
    pw = os.environ.get("GMAIL_APP_PASSWORD", "").replace(" ", "").strip()
    if not ADDR.match(a) or not pw:
        raise jc.JobError("email", "GMAIL_ADDRESS / GMAIL_APP_PASSWORD are not set")
    return a, pw


def build(sender, to, subject, text, html=None, attachments=None):
    """attachments: [(filename, bytes, 'maintype/subtype')]"""
    m = EmailMessage()
    m["From"], m["To"], m["Subject"] = sender, to, subject
    m["Date"] = formatdate(localtime=False)
    m["Message-ID"] = make_msgid(domain=sender.split("@")[1])
    m.set_content(text or "")
    if html:
        m.add_alternative(html, subtype="html")
    for name, data, ctype in attachments or []:
        mt, st = ctype.split("/", 1)
        m.add_attachment(data, maintype=mt, subtype=st, filename=name)
    return m


def smtp_send(msg, sender, pw, to):
    host = os.environ.get("SMTP_HOST", "smtp.gmail.com")
    port = int(os.environ.get("SMTP_PORT", "465"))
    use_ssl = os.environ.get("SMTP_SSL", "1") != "0"
    last = None
    for wait in (0, 3, 9):
        if wait:
            time.sleep(wait)
        try:
            if use_ssl:
                s = smtplib.SMTP_SSL(host, port, context=ssl.create_default_context(), timeout=60)
            else:
                s = smtplib.SMTP(host, port, timeout=60)
            try:
                s.login(sender, pw)
                refused = s.send_message(msg, from_addr=sender, to_addrs=[to])
                if refused:
                    raise jc.JobError("email", "the server refused the recipient")
            finally:
                try:
                    s.quit()
                except Exception:
                    pass
            return
        except smtplib.SMTPAuthenticationError:
            raise jc.JobError("email", "Gmail refused the app password (SMTP login)") from None
        except (OSError, smtplib.SMTPException) as e:
            last = e
    raise jc.JobError("email", f"SMTP failed after retries: {type(last).__name__}: {jc.redact(last)[:200]}")


def _outbox(ctx, to, subject, text, html):
    """Shadow mode: keep an encrypted copy of what would have been sent."""
    day = ctx.today()
    d = os.path.join(ctx.engine, "outbox", day)
    os.makedirs(d, exist_ok=True)
    n = len([f for f in os.listdir(d) if f.endswith(".enc.json")]) + 1
    name = f"{datetime.datetime.utcnow().strftime('%H%M%S')}-{n:02d}"
    body = json.dumps({"to": to, "subject": subject, "text": text, "html": html, "at": jc.now_iso()}, ensure_ascii=False).encode("utf-8")
    with open(os.path.join(d, name + ".enc.json"), "wb") as f:
        f.write(store.seal(ctx.keys, body, name + ".json"))
    return f"outbox/{day}/{name}.enc.json"


def send(ctx, subject, text, html=None, to=None, attachments=None):
    """Send to settings.factsheetEmail. `to`, when given, must be that same address. Returns a short status string
    ('sent', or 'shadow: outbox/...'); the caller commits outbox files in shadow mode (jobs collect them)."""
    allowed = ctx.recipient()
    if to is not None and to.strip().lower() != allowed.lower():
        raise jc.JobError("email", "refusing to email anyone but settings.factsheetEmail")
    if not subject or "\n" in subject or "\r" in subject:
        raise jc.JobError("email", "bad subject")
    if not ctx.live:
        path = _outbox(ctx, allowed, subject, text, html)
        ctx.__dict__.setdefault("outbox_files", []).append(path)
        return "shadow: saved to " + path
    sender, pw = _sender()
    smtp_send(build(sender, allowed, subject, text, html, attachments), sender, pw, allowed)
    return "sent"


def send_failure(ctx, engine, code, subject, body, html=None):
    """FAILED notice. Uses settings.factsheetEmail when the settings can be read, else the sender's own address."""
    if ctx is None and engine:
        try:
            ctx = jc.Ctx(engine, code)
        except Exception:
            ctx = None
    if ctx is not None and not ctx.live and not (ctx.config.get("failureEmails") is True):
        return "shadow: failure email not sent (GitHub's own failure notice still goes out)"
    sender, pw = _sender()
    to = None
    if ctx is not None:
        try:
            to = ctx.recipient()
        except Exception:
            to = None
    to = to or sender          # the owner's own mailbox: the one address that is always safe
    smtp_send(build(sender, to, subject, body, html), sender, pw, to)
    return "sent"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Send one email to settings.factsheetEmail via Gmail SMTP.")
    ap.add_argument("--engine", required=True)
    ap.add_argument("--code")
    ap.add_argument("--subject")
    ap.add_argument("--text")
    ap.add_argument("--html")
    ap.add_argument("--to")
    ap.add_argument("--failure", metavar="JOB")
    ap.add_argument("--step", default="workflow setup")
    ap.add_argument("--error", default="a workflow step failed before the job could report it itself")
    a = ap.parse_args(argv)
    try:
        if a.failure:
            if os.path.exists(jc.failure_mark()):
                jc.log("failure already emailed by the job")
                return 0
            ctx = None
            try:
                ctx = jc.Ctx(a.engine, a.code)
            except Exception:
                pass
            date = ctx.today() if ctx else jc.cairo_today()
            import emails
            u = jc.run_url()
            subj, body, html = emails.failure(a.failure, date, a.step, a.error, u[len("Run log: "):] if u.startswith("Run log: http") else None)
            jc.log("failure email: " + send_failure(ctx, a.engine, a.code, subj, body, html))
            return 0
        if not a.subject or not a.text:
            ap.error("--subject and --text are required")
        ctx = jc.Ctx(a.engine, a.code)
        text = open(a.text, encoding="utf-8").read()
        html = open(a.html, encoding="utf-8").read() if a.html else None
        jc.log("email: " + send(ctx, a.subject, text, html, a.to))
        return 0
    except jc.JobError as e:
        jc.log(f"FAILED: {e.step}: {jc.mask(e.detail)}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
