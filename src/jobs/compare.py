#!/usr/bin/env python3
"""Side-by-side check for the move off Claude.

During the side-by-side period the old jobs (Claude) keep publishing the site, while the new GitHub jobs run in shadow
mode and write only to the engine repository. Each evening this compares, document by document, what the old jobs
published (the site's encrypted bundle, <siteFolder>/data.enc.json in the public repo checkout) with the engine's own
data, and emails the owner the differences plus the emails the new jobs would have sent that day.

    python3 src/jobs/compare.py --engine ENGINE_DIR --code PUBLIC_REPO_CHECKOUT [--manual] [--dry-run]

Scheduled at 23:30 Cairo (both UTC offsets fire; only the one that lands in the 23:00 hour runs). The comparison email
is the one email that is sent even in shadow mode. Logs print counts only, never values.
"""
import os, sys, json, gzip, base64, argparse, datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jobs_common as jc          # noqa: E402
import mail_send                  # noqa: E402
import store                      # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec                       # noqa: E402
from cryptography.hazmat.primitives import hashes                               # noqa: E402
from cryptography.hazmat.primitives.kdf.hkdf import HKDF                        # noqa: E402
from cryptography.hazmat.primitives.ciphers.aead import AESGCM                  # noqa: E402

# Fields that legitimately differ between two runs of the same job (clock times, run bookkeeping).
VOLATILE = {
    "sync/state": {"lastRun", "heartbeat", "toolSha", "digest.at"},
    "market/latest": {"asOf", "jobAsOf", "source"},
}
VOLATILE_ANY = {"postedAt", "factsheetSentAt", "workbooksPublishedAt", "updatedAt", "exportedAt"}
SHOW = 40          # differences listed in full in the email; the rest are counted
# Differences that only reflect WHEN each side fetched prices (the dollar and gold trade around the clock; "as of" dates):
# counted separately, never listed as problems.
def is_timing(doc, path):
    if doc == "bench/egx30" and path in ("asOf", "divYieldAsOf"):
        return True
    if doc == "market/latest" and (path.startswith("fx.") or path.startswith("gold.") or path.endswith(".date") and path.startswith("index.")):
        return True
    if doc.startswith("history/") and (path.endswith(".USDEGP") or path.endswith(".GOLD24K")):
        return True
    return False



def open_bundle(priv, path):
    """Decrypt a site bundle written by tools/export.py ("portfolio-data-v1", gzipped JSON)."""
    e = json.load(open(path, encoding="utf-8"))
    b = base64.b64decode
    epk = b(e["epk"])
    shared = priv.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), epk))
    key = HKDF(hashes.SHA256(), 32, epk, b"portfolio-data-v1").derive(shared)
    plain = gzip.decompress(AESGCM(key).decrypt(b(e["iv"]), b(e["ct"]), b"portfolio-data-v1"))
    return json.loads(plain)


def short(v, n=60):
    s = json.dumps(v, ensure_ascii=False, sort_keys=True)
    return s if len(s) <= n else s[: n - 1] + "…"


def diff(a, b, path, doc, out):
    """Collect (doc, path, old, new) for every leaf that differs; volatile fields skipped."""
    key = path.rsplit(".", 1)[-1] if path else ""
    if key in VOLATILE_ANY or path in VOLATILE.get(doc, ()):
        return
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b), key=str):
            p = f"{path}.{k}" if path else str(k)
            if k not in a:
                out.append((doc, p, "(missing)", short(b[k])))
            elif k not in b:
                out.append((doc, p, short(a[k]), "(missing)"))
            else:
                diff(a[k], b[k], p, doc, out)
    elif isinstance(a, list) and isinstance(b, list) and doc.startswith("ledger/"):
        ia = {r.get("id"): r for r in a if isinstance(r, dict)}
        ib = {r.get("id"): r for r in b if isinstance(r, dict)}
        for rid in sorted(set(ia) | set(ib), key=str):
            p = f"{path}[{rid}]"
            if rid not in ia:
                out.append((doc, p, "(missing)", short(ib[rid])))
            elif rid not in ib:
                out.append((doc, p, short(ia[rid]), "(missing)"))
            else:
                diff(ia[rid], ib[rid], p, doc, out)
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool) and not isinstance(b, bool):
        if abs(a - b) > 1e-9 * max(1.0, abs(a), abs(b)):
            out.append((doc, path, short(a), short(b)))
    elif a != b:
        out.append((doc, path, short(a), short(b)))


def normalize(doc, data):
    """The heads-up texts quote live figures (e.g. today's value in the drawdown line), so compare which alerts exist."""
    if doc == "sync/state" and isinstance(data, dict) and isinstance(data.get("digest"), dict):
        dg = dict(data["digest"])
        dg["items"] = sorted(str(i.get("key")) for i in (dg.get("items") or []) if isinstance(i, dict))
        dg.pop("drawdown", None)
        data = dict(data, digest=dg)
    return data


def compare(old_docs, new_docs):
    old_docs = {k: normalize(k, v) for k, v in old_docs.items()}
    new_docs = {k: normalize(k, v) for k, v in new_docs.items()}
    out = []
    only_old = sorted(set(old_docs) - set(new_docs))
    only_new = sorted(set(new_docs) - set(old_docs))
    for d in sorted(set(old_docs) & set(new_docs)):
        diff(old_docs[d], new_docs[d], "", d, out)
    timing = [x for x in out if is_timing(x[0], x[1])]
    real = [x for x in out if not is_timing(x[0], x[1])]
    return real, only_old, only_new, len(timing)


def outbox_today(ctx, day):
    """Subjects of the emails the new jobs would have sent today (shadow mode keeps them encrypted in outbox/)."""
    d = os.path.join(ctx.engine, "outbox", day)
    if not os.path.isdir(d):
        return []
    subs = []
    for f in sorted(os.listdir(d)):
        if f.endswith(".enc.json"):
            try:
                m = json.loads(store.unseal(ctx.priv, open(os.path.join(d, f), "rb").read()))
                subs.append(m.get("subject", "(no subject)"))
            except Exception:
                subs.append("(could not read " + f + ")")
    return subs


def build_email(name, day, bundle_at, diffs, only_old, only_new, sent, timing=0):
    n = len(diffs) + len(only_old) + len(only_new)
    subject = f"{name} · side-by-side check {day} · " + ("everything matches" if n == 0 else f"{n} difference{'s' if n != 1 else ''}")
    lines = [f"Side-by-side check for {day}.",
             "Old jobs (Claude): the data on your site, published " + (bundle_at or "at an unknown time") + ".",
             "New jobs (GitHub): the data in your private portfolio-engine repository.", ""]
    if n == 0:
        lines.append("Every document matches (clock times and run bookkeeping are ignored).")
    else:
        if only_old:
            lines.append("Only in the old jobs' data: " + ", ".join(only_old))
        if only_new:
            lines.append("Only in the new jobs' data: " + ", ".join(only_new))
        if diffs:
            lines.append(f"Different values ({len(diffs)}):")
            for doc, p, a, b in diffs[:SHOW]:
                lines.append(f"  {doc} · {p}\n      old: {a}\n      new: {b}")
            if len(diffs) > SHOW:
                lines.append(f"  … and {len(diffs) - SHOW} more.")
    if timing:
        lines += ["", f"Also {timing} small difference{'s' if timing != 1 else ''} from the two sides fetching prices at different minutes (dollar, gold, as-of dates). These are expected."]
    lines += ["", "Emails the new jobs would have sent today (not sent, kept encrypted):"]
    lines += [f"  • {s}" for s in sent] or ["  none"]
    lines += ["", "Nothing needs doing unless a difference looks wrong. Reply in Claude if one does."]
    return subject, "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--engine", required=True)
    ap.add_argument("--code", required=True)
    ap.add_argument("--manual", action="store_true", help="run now, whatever the time")
    ap.add_argument("--dry-run", action="store_true", help="print the email subject and counts, send nothing")
    a = ap.parse_args(argv)
    ctx = None
    try:
        ctx = jc.Ctx(a.engine, a.code)
        plan = ctx.plan()
        if not a.manual and plan["hour"] != 23:
            jc.log(f"compare: not 23:00-23:59 Cairo (hour {plan['hour']}); nothing to do")
            return 0
        bundle = os.path.join(ctx.code, *ctx.config["siteFolder"].split("/"), "data.enc.json")
        if not os.path.exists(bundle):
            raise jc.JobError("compare", "the site has no data.enc.json for this portfolio")
        old = open_bundle(ctx.priv, bundle)
        new = {k: v["data"] for k, v in store.read_all(ctx.engine, ctx.keys, ctx.priv).items()}
        old_docs = {k: v for k, v in old.get("docs", {}).items() if not k.startswith("tools/")}
        diffs, only_old, only_new, timing = compare(old_docs, new)
        sent = outbox_today(ctx, plan["today"])
        subject, text = build_email(ctx.config.get("name") or ctx.config["portfolioId"], plan["today"],
                                    old.get("exportedAt"), diffs, only_old, only_new, sent, timing)
        jc.log(f"compare: {len(old_docs)} old docs, {len(new)} new docs, {len(diffs)} value differences, "
               f"{len(only_old)} only-old, {len(only_new)} only-new, {timing} timing, {len(sent)} shadow emails")
        if a.dry_run:
            jc.log("compare: dry run, subject: " + subject)
            return 0
        to = ctx.recipient()
        sender, pw = mail_send._sender()
        mail_send.smtp_send(mail_send.build(sender, to, subject, text), sender, pw, to)
        jc.log("compare: email sent")
        return 0
    except jc.JobError as e:
        jc.report_failure(ctx, "side-by-side check", getattr(e, "step", "compare"), str(e), engine=a.engine, code=a.code)
        return 1


if __name__ == "__main__":
    sys.exit(main())
