#!/usr/bin/env python3
"""Read-only check of "Build it from my Thndr emails" on real Thndr emails: the owner's own Gmail.

    python3 history_check.py --engine DIR [--code DIR]

Builds a throwaway portfolio exactly as the account job builds a friend's (run_account_mail.py: the monthly statements
since 2019 through src/tools/history_seed.js, then sync.js on every Thndr email after the latest), from the owner's
Thndr account name and code only, and compares the result with the owner's real portfolio (the engine's documents):
share counts per stock and fund now, broker cash, and each month-end mark both have from a statement. Nothing is
written, sent or published. Prints one JSON line of counts and matches (tickers of any mismatch, never an amount).
Env: SETUP_KEY (the owner's), GMAIL_ADDRESS / GMAIL_APP_PASSWORD. Exit 0 when it ran (whatever it found), 1 when not.
"""
import os, sys, json, glob, shutil, argparse, datetime, subprocess, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import jobs_common as jc  # noqa: E402
import imap_fetch, run_sync, run_account_mail as ram  # noqa: E402


def load_dir(d):
    out = {}
    for f in glob.glob(os.path.join(d, "*", "*.json")):
        c, doc = f.split(os.sep)[-2], os.path.basename(f)[:-5]
        out[f"{c}/{doc}"] = jc.load_data(f, {})
    return out


def holdings(docs, names=None):
    """Shares per security now, keyed by ticker where either portfolio knows one (names: lower-case name -> ticker)."""
    items = (docs.get("portfolio/assets") or {}).get("items") or {}
    names = names or {}
    q = {}
    for k, v in docs.items():
        if not k.startswith("ledger/"):
            continue
        for t in (v or {}).get("rows") or []:
            if t.get("t") not in ("Buy", "Sell", "Bonus") or not t.get("a"):
                continue
            a = items.get(t["a"]) or {}
            key = (a.get("symbol") or names.get(t["a"].lower()) or t["a"]).upper()
            q[key] = q.get(key, 0) + (-1 if t["t"] == "Sell" else 1) * (t.get("q") or 0)
    return {k: v for k, v in q.items() if abs(v) > 0.5}


def ticker_names(*docs):
    out = {}
    for d in docs:
        for n, a in ((d.get("portfolio/assets") or {}).get("items") or {}).items():
            if a.get("symbol"):
                out[n.lower()] = a["symbol"]
                out[(a.get("name") or n).lower()] = a["symbol"]
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--engine", required=True)
    ap.add_argument("--code", default=jc.CODE_DEFAULT)
    a = ap.parse_args(argv)
    work = tempfile.mkdtemp(prefix="hcheck-", dir=os.environ.get("RUNNER_TEMP") or None)
    try:
        ctx = jc.Ctx(a.engine, a.code)
        main_dir = os.path.join(work, "main")
        ctx.materialize(main_dir)
        real = load_dir(main_dir)
        s = real.get("portfolio/settings") or {}
        today = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
        fresh = {k: v for k, v in s.items() if k != "trackFrom"}
        fresh.update({"name": "History check", "inception": today[:7], "cash": 0, "cashDate": today, "historyImport": {"status": "pending"},
                      "account": {"holder": (s.get("account") or {}).get("holder") or "", "unifiedCode": (s.get("account") or {}).get("unifiedCode") or ""}})
        docs = {"portfolio/settings": {"data": fresh}, "portfolio/assets": {"data": {"items": {}}}, "portfolio/marks": {"data": {"months": {}}}}
        data = os.path.join(work, "data")
        ram.materialize(docs, os.path.join(os.path.abspath(a.engine), "shared"), data)
        inbox_m, seed_out = os.path.join(work, "inbox-monthly"), os.path.join(work, "seed")
        cm = imap_fetch.fetch(ram.HISTORY_AFTER, set(), inbox_m, query=imap_fetch.QUERY_MONTHLY)
        r = subprocess.run(["node", os.path.join(ctx.code, "src", "tools", "history_seed.js"), "--data", data, "--inbox", inbox_m, "--out", seed_out],
                           capture_output=True, text=True, timeout=1200)
        seed = json.loads((r.stdout or "{}").strip().splitlines()[-1] if (r.stdout or "").strip() else "{}")
        out = {"ok": True, "monthlyStatementsFound": cm.get("kept"), "seed": {k: seed.get(k) for k in ("ok", "first", "last", "lastTo", "months", "holdings", "adjustments", "adjustedMonths", "gaps", "skipped", "openingFunds", "fundsOnSnapshot", "fundStatement", "error")}}
        if not seed.get("ok"):
            print(json.dumps(out))
            return 0
        ram.apply_to_data(data, run_sync.writes_from_plan(seed_out, {}))
        inbox, run = os.path.join(work, "inbox"), os.path.join(work, "run")
        c = imap_fetch.fetch(seed["lastTo"].replace("-", "/"), set(), inbox)
        os.makedirs(run)
        r = subprocess.run(["node", os.path.join(ctx.code, "src", "tools", "sync.js"), "--data", data, "--inbox", inbox, "--out", run, "--today", today],
                           capture_output=True, text=True, timeout=1800)
        if r.returncode != 0:
            raise jc.JobError("sync.js", jc.mask((r.stderr or r.stdout or "failed").strip().splitlines()[-1][:200]))
        summary = json.load(open(os.path.join(run, "summary.json")))
        ram.apply_to_data(data, run_sync.writes_from_plan(os.path.join(run, "write"), {}))
        built = load_dir(data)
        tn = ticker_names(real, built)
        hr, hb = holdings(real, tn), holdings(built, tn)
        keys = sorted(set(hr) | set(hb))
        differ = [k for k in keys if abs(hr.get(k, 0) - hb.get(k, 0)) >= 0.5]
        side = lambda k: "only in the real one" if k not in hb else "only in the built one" if k not in hr else "more in the real one" if hr[k] > hb[k] else "more in the built one"
        # where each differing security's rows in the built portfolio came from (dates, types and sources, no amounts)
        bitems = (built.get("portfolio/assets") or {}).get("items") or {}
        keyof = lambda n: ((bitems.get(n) or {}).get("symbol") or tn.get(n.lower()) or n).upper()
        brows = [t for kk, v in built.items() if kk.startswith("ledger/") for t in (v or {}).get("rows") or []]
        trail = {k: [f"{t['d']} {t['t']}{' (' + t['a'] + ')' if t['a'].upper() != k else ''} {t.get('src', '')}" for t in sorted(brows, key=lambda t: t["d"]) if t.get("a") and t["t"] in ("Buy", "Sell", "Bonus") and keyof(t["a"]) == k][-8:] for k in differ}
        mr = ((real.get("portfolio/marks") or {}).get("months") or {})
        mb = ((built.get("portfolio/marks") or {}).get("months") or {})
        both = [m for m in sorted(mb) if (mb[m] or {}).get("source") == "statement" and (mr.get(m) or {}).get("source") in ("statement", "reconstructed")]
        mm = [m for m in both if abs((mr[m].get("cash") or 0) - (mb[m].get("cash") or 0)) < 1 and abs((mr[m].get("securities") or 0) - (mb[m].get("securities") or 0)) < 1]
        # how big a month-end difference is, as a share of the real figure (never the amount)
        size = lambda r, b: (lambda d: "under 0.01%" if d < 1e-4 else "under 0.1%" if d < 1e-3 else "under 1%" if d < 1e-2 else "1% or more")(abs((r or 0) - (b or 0)) / max(abs(r or 0), 1))
        sb = built.get("portfolio/settings") or {}
        held = [e for e in summary.get("log") or [] if e.get("status") == "hold"]
        out.update({
            "emailsAfterStart": c.get("kept"), "applied": summary.get("applied"), "held": len(held),
            "heldWhy": [jc.mask(f"{e.get('subject')}: {(e.get('reasons') or ['?'])[0]}")[:160] for e in held[:6]],
            "missingStatements": summary.get("alert"),
            "holdings": {"match": len(keys) - len(differ), "of": len(keys), "differ": {k: side(k) for k in differ}, "builtRows": trail},
            "adjustmentRows": [f"{t['d']} {t['t']} {t.get('a') or 'cash'}" for t in brows if t.get("src") == "history-adjust"],
            "cash": {"sameDate": sb.get("cashDate") == s.get("cashDate"), "match": abs((sb.get("cash") or 0) - (s.get("cash") or 0)) < 1},
            "marks": {"match": len(mm), "of": len(both), "differ": {m: [f"{x} {'higher' if (mb[m].get(x) or 0) > (mr[m].get(x) or 0) else 'lower'} in the built one by {size(mr[m].get(x), mb[m].get(x))}" for x in ("cash", "securities") if abs((mr[m].get(x) or 0) - (mb[m].get(x) or 0)) >= 1] + [f"real source {mr[m].get('source')}"] for m in both if m not in mm}},
        })
        print(json.dumps(out))
        return 0
    except (jc.JobError, imap_fetch.FetchError) as e:
        print(json.dumps({"ok": False, "step": getattr(e, "step", "Gmail"), "error": jc.mask(str(getattr(e, "detail", e)))[:200]}))
        return 1
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
