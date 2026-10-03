#!/usr/bin/env python3
"""Moves the MAIN portfolio (the engine repository's db/, opened with the setup key) into the site owner's own account
(Firestore users/{uid}/docs, sealed to the account key), so every portfolio lives the same way. Engine workflow
migrate-main.yml, by hand.

    python3 migrate_main.py --engine DIR [--code DIR] --mode check|copy|compare

  check    reads both sides and prints what a copy would write (document names and counts only). Writes nothing.
  copy     writes the copy in ONE Firestore commit, refused when the account already has a portfolio (starter documents
           the site wrote at sign-up, with no portfolio in them, are replaced):
             - every engine document except the market data (market/, history/, bench/: accounts read the shared copy)
               and an unsent-email outbox; settings gain migratedFrom / migratedAt;
             - imports/<M>: a month the main portfolio already reported (reports.factsheetSentAt, or jobs.json
               sync.monthEndEmailed) is stamped reports.emailedAt, so the account never emails it again;
             - sync/mail: the account job's record gets what the main portfolio already sent (alertsSent from its sync
               state, weeklySent, reportCardSent from jobs.json), merged into the record the account already has;
             - sync/gmail: the owner's Gmail login (GMAIL_ADDRESS / GMAIL_APP_PASSWORD), so the account reads the same
               Thndr emails.
           From then on the account job runs that portfolio in SHADOW (the Gmail import, no emails) until the engine's
           config.json says movedToAccount; see run_account_mail.py.
  compare  the percentages profile (monthly returns, holding weights, trade count; tools/profile.js) of both copies side
           by side, and the ledger and month-end documents compared field by field. Prints differences only, never an
           amount.
Env: SETUP_KEY (= KHALED_SETUP_KEY), GMAIL_ADDRESS, GMAIL_APP_PASSWORD. Logs carry document names, counts and percentages
only."""
import os, sys, json, argparse, tempfile, shutil, subprocess, hashlib, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import jobs_common as jc  # noqa: E402
import store  # noqa: E402
import run_account_mail as ram  # noqa: E402

SKIP_COLLS = ("market", "history", "bench")
SKIP_DOCS = ("sync/outbox", "sync/gmail", "sync/mail")


def owner_account(http, priv):
    """(pkg, tok) of the site owner's verified account (its sign-in email hashes to OWNER_HASH)."""
    for p in ram.list_packages(http):
        try:
            pkg = ram.open_mail_pkg(priv, p["pkg"])
        except Exception:
            continue
        if pkg.get("uid") != p["uid"]:
            continue
        tok, uid = ram.id_token(http, pkg["refresh"])
        cl = ram.token_claims(tok)
        if hashlib.sha256(str(cl.get("email") or "").lower().encode()).hexdigest() == ram.OWNER_HASH:
            if not cl.get("email_verified"):
                raise jc.JobError("owner", "the owner's account email is not verified")
            return pkg, tok
    raise jc.JobError("owner", "the owner's account has no mail package (switch on an email update on the site once)")


def plan_copy(engine_docs, acct_docs, jobs, login, now_iso):
    """-> (writes, notes): the Firestore writes of a copy (run_sync.writes_from_plan shape)."""
    sync_jobs = (jobs or {}).get("sync") or {}
    emailed = dict(sync_jobs.get("monthEndEmailed") or {})
    writes, notes = [], []
    for k in sorted(engine_docs):
        c, d = k.split("/", 1)
        if c in SKIP_COLLS or k in SKIP_DOCS:
            continue
        data = json.loads(json.dumps(engine_docs[k]["data"]))
        if k == "portfolio/settings":   # what the site wrote at sign-up (no portfolio yet) is kept under the main settings
            data = {**(((acct_docs.get(k) or {}).get("data")) or {}), **data}
            data["migratedFrom"] = data.get("portfolioId") or "khaled"
            data["migratedAt"] = now_iso
        if c == "imports" and data.get("fullMonth"):
            rep = data.get("reports") or {}
            when = rep.get("emailedAt") or rep.get("factsheetSentAt") or emailed.get(d)
            if when:
                data["reports"] = {**rep, "emailedAt": when}
                data.pop("reportsPending", None)
                notes.append(f"{d}: already reported")
        writes.append({"op": "set", "collection": c, "doc_id": d, "data": data})
    # what the main portfolio already sent, so the account job does not send it again
    st = (engine_docs.get("sync/state") or {}).get("data") or {}
    cur = dict(((acct_docs.get("sync/mail") or {}).get("data")) or {})
    sent = dict(cur.get("alertsSent") or {})
    for kk, v in (st.get("alertsSent") or {}).items():
        sent.setdefault(kk, v)
    cur["alertsSent"] = sent
    for key in ("weeklySent", "reportCardSent"):
        if sync_jobs.get(key) and str(sync_jobs[key]) > str(cur.get(key) or ""):
            cur[key] = sync_jobs[key]
    cur["migratedAt"] = now_iso
    writes.append({"op": "set", "collection": "sync", "doc_id": "mail", "data": cur, "_merge": True})
    if login.get("address") and login.get("appPassword"):
        writes.append({"op": "set", "collection": "sync", "doc_id": "gmail", "data": {"address": login["address"], "appPassword": login["appPassword"]}})
    else:
        notes.append("no Gmail login in the environment: the account will not read the Thndr emails until it is connected on the site")
    return writes, notes


def profile(code, docs, shared, work, tag, own_market):
    d = os.path.join(work, "p-" + tag)
    if own_market:   # the engine copy: its own market data, as its site page reads it
        for k, v in docs.items():
            c, n = k.split("/", 1)
            os.makedirs(os.path.join(d, c), exist_ok=True)
            with open(os.path.join(d, c, n + ".json"), "w", encoding="utf-8") as f:
                json.dump({"id": n, "data": v["data"]}, f)
    else:
        ram.materialize(docs, shared, d)
    r = subprocess.run(["node", os.path.join(code, "src", "tools", "profile.js"), "--data", d], capture_output=True, text=True, timeout=300)
    out = json.loads((r.stdout or "{}").strip().splitlines()[-1] if (r.stdout or "").strip() else "{}")
    if not out.get("ok"):
        raise jc.JobError("compare", out.get("error") or "profile.js failed")
    return out["profile"]


def compare(engine_docs, acct_docs, code, shared, work):
    """Differences between the two copies: documents, ledger rows, month-ends, then the percentages profile."""
    lines = []
    ek = {k for k in engine_docs if k.split("/", 1)[0] not in SKIP_COLLS and k not in SKIP_DOCS}
    ak = {k for k in acct_docs if k.split("/", 1)[0] not in SKIP_COLLS and k not in SKIP_DOCS}
    if ek - ak:
        lines.append("only in the main portfolio: " + ", ".join(sorted(ek - ak)))
    if ak - ek:
        lines.append("only in the account: " + ", ".join(sorted(ak - ek)))
    def rows(docs):
        out = {}
        for k, v in docs.items():
            if k.startswith("ledger/"):
                for r in (v["data"] or {}).get("rows") or []:
                    out[r.get("id") or json.dumps(r, sort_keys=True)] = r
        return out
    er, ar = rows(engine_docs), rows(acct_docs)
    key = lambda r: (r.get("d"), r.get("t"), r.get("a") or "", round(float(r.get("amt") or 0), 2), round(float(r.get("q") or 0), 4))
    only_e = sorted(key(er[i]) for i in er if i not in ar)
    only_a = sorted(key(ar[i]) for i in ar if i not in er)
    diff = sorted(i for i in er if i in ar and key(er[i]) != key(ar[i]))
    lines.append(f"ledger: {len(er)} rows in the main portfolio, {len(ar)} in the account; {len(only_e)} only in the main, {len(only_a)} only in the account, {len(diff)} differ")
    for r in only_e[:20]:
        lines.append(f"  only in the main: {r[0]} {r[1]} {r[2]}")
    for r in only_a[:20]:
        lines.append(f"  only in the account: {r[0]} {r[1]} {r[2]}")
    em = ((engine_docs.get("portfolio/marks") or {}).get("data") or {}).get("months") or {}
    am = ((acct_docs.get("portfolio/marks") or {}).get("data") or {}).get("months") or {}
    for M in sorted(set(em) | set(am)):
        a, b = em.get(M) or {}, am.get(M) or {}
        for f in ("cash", "securities", "source", "provisional"):
            if a.get(f) != b.get(f):
                lines.append(f"month-end {M}: {f} differs" + ("" if f in ("cash", "securities") else f" ({a.get(f)} / {b.get(f)})"))
    try:
        pe = profile(code, engine_docs, shared, work, "main", True)
        pa = profile(code, acct_docs, shared, work, "acct", False)
        rm = {m["m"]: m.get("r") for m in pe.get("months") or []}
        ra = {m["m"]: m.get("r") for m in pa.get("months") or []}
        worst = max((abs((rm.get(M) or 0) - (ra.get(M) or 0)), M) for M in set(rm) | set(ra)) if (rm or ra) else (0, None)
        lines.append(f"monthly returns: {len(rm)} months in the main, {len(ra)} in the account; largest gap {worst[0] * 100:.2f} points ({worst[1]})")
        wm = {h["s"] or h["n"]: h["w"] for h in pe.get("holdings") or []}
        wa = {h["s"] or h["n"]: h["w"] for h in pa.get("holdings") or []}
        wd = max((abs(wm.get(s, 0) - wa.get(s, 0)), s) for s in set(wm) | set(wa)) if (wm or wa) else (0, None)
        lines.append(f"holdings: {len(wm)} in the main, {len(wa)} in the account; largest weight gap {wd[0] * 100:.2f} points ({wd[1]})")
    except jc.JobError as e:
        lines.append(f"profile not compared: {e.detail}")
    return lines


def main(argv=None, http=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--engine", required=True)
    ap.add_argument("--code", default=jc.CODE_DEFAULT)
    ap.add_argument("--mode", choices=("check", "copy", "compare"), default="check")
    a = ap.parse_args(argv)
    engine = os.path.abspath(a.engine)
    keys_path = os.path.join(a.code, "p", "khaled", "keys.json")
    priv = store.unlock(store.load_keys(keys_path), os.environ["SETUP_KEY"].strip())
    http = http or ram.Http()
    engine_docs = store.read_all(engine, keys_path, priv)
    with open(os.path.join(engine, "jobs.json"), encoding="utf-8") as f:
        jobs = json.load(f)
    pkg, tok = owner_account(http, priv)
    apriv, akeys = ram.account_key(pkg["pk8"])
    acct_docs = ram.read_account(http, tok, pkg["uid"], apriv)
    has = ((acct_docs.get("portfolio/settings") or {}).get("data") or {})
    print(f"main portfolio: {len(engine_docs)} documents; owner's account: {len(acct_docs)} documents"
          + (f", portfolio copied {has.get('migratedAt')}" if has.get("migratedFrom") else (", has a portfolio of its own" if has.get("inception") else ", no portfolio yet")))
    print("account email prefs: " + json.dumps({k: v for k, v in (pkg.get("prefs") or {}).items()}, sort_keys=True))
    if has.get("inception") and not has.get("migratedFrom"):   # what the account holds now (names, dates and counts only)
        nrows = sum(len(((v.get("data") or {}).get("rows")) or []) for k, v in acct_docs.items() if k.startswith("ledger/"))
        print("account's own portfolio: " + json.dumps({"documents": sorted(acct_docs), "name": has.get("name"), "inception": has.get("inception"),
              "trackFrom": has.get("trackFrom"), "historyImport": {k: (has.get("historyImport") or {}).get(k) for k in ("status", "from", "to", "months")},
              "ledgerRows": nrows, "updated": max((v.get("updatedAt") or "") for v in acct_docs.values())}, sort_keys=True))
    if a.mode == "compare":
        if not has.get("migratedFrom"):
            print("nothing to compare: the account has no copy yet")
            return 1
        work = tempfile.mkdtemp(prefix="cmp-", dir=os.environ.get("RUNNER_TEMP") or None)
        try:
            for line in compare(engine_docs, acct_docs, a.code, os.path.join(engine, "shared"), work):
                print(line)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        return 0
    login = {"address": os.environ.get("GMAIL_ADDRESS", "").strip(), "appPassword": os.environ.get("GMAIL_APP_PASSWORD", "").replace(" ", "").strip()}
    now_iso = jc.now_iso()
    writes, notes = plan_copy(engine_docs, acct_docs, jobs, login, now_iso)
    print("would write: " + ", ".join(f"{w['collection']}/{w['doc_id']}" for w in writes))
    for n in notes:
        print("  " + n)
    if a.mode == "check":
        return 0
    if has.get("inception") or has.get("migratedFrom"):
        print("refused: the account already has a portfolio (nothing written)")
        return 1
    # an account without a portfolio may hold empty starter documents from the site: they are replaced, each write
    # pinned to the version read (or to not existing), all in one commit
    for w in writes:
        w.pop("_merge", None)
    done = ram.commit_writes(http, tok, pkg["uid"], akeys, acct_docs, [{**w, "op": "set"} for w in writes], now_iso)
    print(f"copied: {len(done)} documents in one commit; the account now runs this portfolio in shadow (no emails) until the switch")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except jc.JobError as e:
        print(f"not done: {e.step}: {jc.mask(str(e.detail))[:200]}")
        sys.exit(1)
