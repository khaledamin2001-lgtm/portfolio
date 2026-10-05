#!/usr/bin/env python3
"""Shared market data for every account on the site: ONE daily download of the whole EGX market, published once for all
members instead of once per portfolio.

    python3 run_shared_market.py --engine DIR [--code DIR] [--manual] [--fill N] [--prices FILE] [--now ISO]
                                 [--no-publish] [--site-remote URL|PATH] [--members-pub B64]

1. Gate: an EGX weekday (Sun-Thu) at or after 15:40 Cairo, once a day (engine shared/jobs.json); --manual always runs.
2. src/jobs/fetch_prices.py - --all: a quote for every EGX-listed stock, the indices, USD/EGP, gold, the EGX30 members,
   macro fields, and daily closes for EVERY stock over the last N sessions (N = --fill, default 10; 260 on the very first
   run, when shared/history is empty, so members start with a year of history). --prices uses a saved output instead.
3. Merges into the engine repository's shared/ folder (plain JSON: public market data, nothing about anyone's holdings):
      shared/latest.json            market/latest
      shared/history/<YYYY-MM>.json {month, days: {date: {SYM: close}}}   (days merge; the newest value wins)
      shared/bench.json             bench/egx30: members, asOf, divYield(AsOf); other fields (capWeight, actions) kept
      shared/macro.json             {cpiMoM, fxEom, cashRate: {YYYY-MM: value}, their sources, benchClose: {YYYY-MM: EGX30
                                    Capped month-end close}} accumulated run after run
   and commits them (redone on fresh data if someone pushed meanwhile).
4. Publishes m/market.enc.json on the site: gzip JSON {exportedAt, docs: {"market/latest", "bench/egx30", "market/macro",
   "history/<M>"...}} sealed exactly like a portfolio's data.enc.json ('portfolio-data-v1') but to the MEMBERS public key,
   read from the public Firestore document shared/membersPub (field "pub"); signed-in members read the private half from
   shared/members. No key yet (no member has signed in): the data is kept and publishing waits for the next run.
Output: log lines (counts only). Any failure: email "Portfolio: shared market FAILED <date>" and exit 1.
"""
import os, sys, json, gzip, base64, argparse, datetime, subprocess, tempfile, shutil, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import jobs_common as jc  # noqa: E402

JOB = "shared market"
FIREBASE_PROJECT = "portfolio-desk-4d14a"
MEMBERS_PUB_URL = (f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT}/databases/(default)/documents/shared/membersPub")
SITE_PATH = "m/market.enc.json"
LABEL = b"portfolio-data-v1"


class Engine:
    """The bits of jobs_common.Ctx that engine_refresh / engine_commit use."""
    def __init__(self, path):
        self.engine = os.path.abspath(path)


def cairo_now(now=None):
    import zoneinfo
    t = datetime.datetime.fromisoformat(now.replace("Z", "+00:00")) if now else datetime.datetime.now(datetime.timezone.utc)
    return t.astimezone(zoneinfo.ZoneInfo("Africa/Cairo"))


def load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def dump(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False, sort_keys=True)
        f.write("\n")


def merge(shared, out):
    """Fold one fetch_prices output into the shared/ folder. Returns {"months": [...], "sessions": n}."""
    dump(os.path.join(shared, "latest.json"), out["latest"])
    months = []
    for H in out.get("histories") or []:
        p = os.path.join(shared, "history", H["month"] + ".json")
        cur = load(p, {"month": H["month"], "days": {}})
        for d, row in (H.get("days") or {}).items():
            cur["days"].setdefault(d, {}).update(row)
        dump(p, cur)
        months.append(H["month"])
    b = load(os.path.join(shared, "bench.json"), {})
    ob = out.get("bench") or {}
    b.update({k: ob[k] for k in ("members", "asOf") if k in ob})
    if isinstance(ob.get("divYield"), (int, float)):
        b.update({"divYield": ob["divYield"], "divYieldAsOf": ob.get("divYieldAsOf")})
    dump(os.path.join(shared, "bench.json"), b)
    m = load(os.path.join(shared, "macro.json"), {})
    mac = out.get("macro") or {}
    for k in ("cpiMoM", "fxEom", "cashRate"):
        if isinstance(mac.get(k), dict):
            m.setdefault(k, {}).update(mac[k])
    for k in ("cpiSource", "fxSource", "cashRateSource"):
        if mac.get(k):
            m[k] = mac[k]
    bc = m.setdefault("benchClose", {})
    pm = out.get("prevMonth") or {}
    if pm.get("month") and isinstance(pm.get("benchClose"), (int, float)):
        bc[pm["month"]] = pm["benchClose"]
    cur_month = out.get("currentMonth")
    for f in sorted(os.listdir(os.path.join(shared, "history"))):
        M = f[:-5]
        if not f.endswith(".json") or (cur_month and M >= cur_month) or M in bc:
            continue
        days = load(os.path.join(shared, "history", f), {}).get("days") or {}
        closes = [(d, r.get("EGX30CAPPED")) for d, r in days.items() if isinstance(r.get("EGX30CAPPED"), (int, float))]
        if closes:
            bc[M] = max(closes)[1]      # the month's last session with an index close
    dump(os.path.join(shared, "macro.json"), m)
    return {"months": months, "sessions": len({d for H in out.get("histories") or [] for d in H.get("days") or {}})}


def bundle(shared):
    docs = {"market/latest": load(os.path.join(shared, "latest.json"), None), "bench/egx30": load(os.path.join(shared, "bench.json"), {}),
            "market/macro": load(os.path.join(shared, "macro.json"), {})}
    if not docs["market/latest"]:
        raise jc.JobError("bundle", "shared/latest.json is missing")
    hd = os.path.join(shared, "history")
    for f in sorted(os.listdir(hd)):
        if f.endswith(".json"):
            docs["history/" + f[:-5]] = load(os.path.join(hd, f), {})
    return docs


def seal_bundle(docs, pub_b64, now_iso):
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import serialization, hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    plain = gzip.compress(json.dumps({"exportedAt": now_iso, "docs": docs}, separators=(",", ":")).encode(), 9)
    site = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), base64.b64decode(pub_b64))
    eph = ec.generate_private_key(ec.SECP256R1())
    epk = eph.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    key = HKDF(hashes.SHA256(), 32, epk, LABEL).derive(eph.exchange(ec.ECDH(), site))
    iv = os.urandom(12)
    ct = AESGCM(key).encrypt(iv, plain, LABEL)
    b = lambda x: base64.b64encode(x).decode()
    return json.dumps({"v": 1, "at": now_iso, "epk": b(epk), "iv": b(iv), "ct": b(ct)}, separators=(",", ":"))


def members_pub(override=None):
    """The members public key (base64 X9.62 point) from the public Firestore doc; None while no member has created it."""
    if override:
        return override
    try:
        with urllib.request.urlopen(MEMBERS_PUB_URL, timeout=30) as r:
            doc = json.load(r)
    except urllib.error.HTTPError as e:
        if e.code in (403, 404):
            return None
        raise jc.JobError("members key", f"Firestore answered {e.code}")
    except Exception as e:
        raise jc.JobError("members key", f"could not read shared/membersPub: {type(e).__name__}")
    v = ((doc.get("fields") or {}).get("pub") or {}).get("stringValue")
    return v or None


def publish(code, envelope, message, remote=None):
    import site_git as pub
    work = tempfile.mkdtemp(prefix="shared-site-", dir=os.environ.get("RUNNER_TEMP") or None)
    try:
        remote = remote or os.environ.get("SITE_REMOTE") or "https://github.com/khaledamin2001-lgtm/portfolio.git"
        site = os.path.join(work, "site")
        author = jc.author_args("SITE_COMMIT_AUTHOR", "Portfolio jobs <noreply@github.com>")
        last = ""
        for wait in (0, 2, 4, 8, 16):
            if wait:
                time.sleep(wait)
            env = pub.clone(remote, site)
            dest = os.path.join(site, *SITE_PATH.split("/"))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "w") as f:
                f.write(envelope)
            if not pub.is_envelope(dest):
                raise jc.JobError("publish", "the market bundle is not an encrypted envelope")
            paths = [l[3:].strip() for l in jc.git(site, "status", "--porcelain", "-uall").stdout.splitlines() if l.strip()]
            if any(p != SITE_PATH for p in paths):
                raise jc.JobError("publish", "refusing to publish anything but " + SITE_PATH)
            if not paths:
                return {"pushed": False, "head": jc.git(site, "rev-parse", "--short", "HEAD").stdout.strip()}
            jc.git(site, "add", "--", SITE_PATH)
            jc.git(site, *author, "commit", "-q", "-m", message)
            r = subprocess.run(["git", "-C", site, "push", "-q", "origin", "HEAD:main"], capture_output=True, text=True,
                               env=dict(os.environ, GIT_TERMINAL_PROMPT="0", **env))
            if r.returncode == 0:
                return {"pushed": True, "head": jc.git(site, "rev-parse", "--short", "HEAD").stdout.strip()}
            last = jc.redact(r.stderr.strip())[-300:]
        raise jc.JobError("publish", "push failed after retries: " + last)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--engine", required=True)
    ap.add_argument("--code", default=jc.CODE_DEFAULT)
    ap.add_argument("--manual", action="store_true")
    ap.add_argument("--fill", type=int)
    ap.add_argument("--prices")
    ap.add_argument("--now")
    ap.add_argument("--no-publish", action="store_true")
    ap.add_argument("--site-remote")
    ap.add_argument("--members-pub", help="tests: the members public key instead of reading Firestore")
    a = ap.parse_args(argv)
    step = "setup"
    try:
        eng = Engine(a.engine)
        shared = os.path.join(eng.engine, "shared")
        jc.engine_refresh(eng)
        now = cairo_now(a.now)
        today = now.strftime("%Y-%m-%d")
        st = load(os.path.join(shared, "jobs.json"), {})
        if not a.manual:
            if now.strftime("%a") not in ("Sun", "Mon", "Tue", "Wed", "Thu"):
                jc.log(f"shared market: skipped ({now.strftime('%a')} is not an EGX session day)")
                return 0
            if now.hour * 60 + now.minute < 15 * 60 + 40:
                jc.log(f"shared market: skipped (before 15:40 Cairo, {now.strftime('%H:%M')})")
                return 0
            if st.get("lastRun") == today:
                jc.log("shared market: skipped (already ran today)")
                return 0
        step = "fetch prices"
        first = not os.path.isdir(os.path.join(shared, "history")) or not os.listdir(os.path.join(shared, "history"))
        if a.prices:
            with open(a.prices) as f:
                out = json.load(f)
        else:
            n = a.fill or (260 if first else 10)
            cmd = [sys.executable, os.path.join(a.code, "src", "jobs", "fetch_prices.py"), "-", "--all", "--fill", str(n)]
            last = ""
            for wait in (0, 30, 30, 30):
                if wait:
                    time.sleep(wait)
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
                if r.returncode == 0:
                    out = json.loads(r.stdout)
                    break
                last = jc.redact(r.stderr.strip())[-300:]
            else:
                raise jc.JobError("fetch prices", "fetch_prices.py failed 4 times: " + last)
        step = "merge"
        for attempt in range(3):
            if attempt:
                jc.engine_refresh(eng)
            info = merge(shared, out)
            st = load(os.path.join(shared, "jobs.json"), {})
            st.update({"lastRun": today if not a.manual else st.get("lastRun"), "at": jc.now_iso(), "status": "ok"})
            dump(os.path.join(shared, "jobs.json"), st)
            jc.git(eng.engine, "add", "-A", "--", "shared")
            if not jc.git(eng.engine, "diff", "--cached", "--name-only").stdout.strip():
                head = None
                break
            jc.git(eng.engine, *jc.author_args("ENGINE_COMMIT_AUTHOR", jc.ENGINE_AUTHOR), "commit", "-q", "-m", f"Shared market {today}")
            head = jc.git(eng.engine, "rev-parse", "--short", "HEAD").stdout.strip()
            if not jc.has_origin(eng.engine):
                break
            r = jc.git(eng.engine, "push", "-q", "origin", "HEAD:main", check=False)
            if r.returncode == 0:
                break
            if attempt == 2:
                raise jc.JobError("git", "push to the engine repository kept failing: " + jc.redact(r.stderr.strip())[-300:])
        L = out["latest"]
        jc.log(f"shared market: asOf {L.get('asOf')}, {len(L.get('quotes') or {})} quotes, history {','.join(info['months'])} "
               f"({info['sessions']} sessions), fillErrors {len(out.get('fillErrors') or {})}, engine commit {head or 'none'}")
        step = "publish"
        if a.no_publish:
            return 0
        pub = members_pub(a.members_pub)
        if not pub:
            jc.log("publish: no members key yet (nobody has signed in); the data is kept and published on the next run")
            return 0
        docs = bundle(shared)
        env = seal_bundle(docs, pub, datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"))
        r = publish(a.code, env, f"Shared market {today}", a.site_remote)
        jc.log(f"publish: {'pushed' if r['pushed'] else 'unchanged'} ({len(docs)} documents, {len(env)} bytes), head {r['head']}")
        return 0
    except jc.JobError as e:
        jc.report_failure(None, JOB, e.step, e.detail)
        return 1
    except Exception as e:
        jc.report_failure(None, JOB, step, f"{type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
