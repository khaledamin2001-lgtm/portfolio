#!/usr/bin/env python3
"""The owner's unconfirmed fund rows checked against the Thndr statements in the owner's Gmail (engine workflow fund-fix.yml).

    python3 fund_fix.py --engine DIR [--code DIR] [--apply]

Decrypts the portfolio, fetches every Thndr monthly and requested statement since 2019, runs src/tools/fund_fix.js and
prints what it would change: each corrected row (date, fund, units before and after), how many were confirmed as they
are, and the rows / statement trades it could not pair (listed, never changed). Without --apply nothing is written.
With --apply the corrected ledger is saved (one engine commit, pinned to the versions read) and the site re-published.
Env: SETUP_KEY, GMAIL_ADDRESS / GMAIL_APP_PASSWORD, SITE_TOKEN (to publish). Exit 0 when it ran, 1 when not."""
import os, sys, json, shutil, argparse, subprocess, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import jobs_common as jc  # noqa: E402
import imap_fetch, run_sync  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--engine", required=True)
    ap.add_argument("--code", default=jc.CODE_DEFAULT)
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args(argv)
    work = tempfile.mkdtemp(prefix="fundfix-", dir=os.environ.get("RUNNER_TEMP") or None)
    try:
        ctx = jc.Ctx(a.engine, a.code)
        jc.engine_refresh(ctx)
        data = os.path.join(work, "data")
        ctx.materialize(data)
        inbox, out = os.path.join(work, "inbox"), os.path.join(work, "out")
        found = imap_fetch.fetch("2019/01/01", set(), inbox, query=imap_fetch.QUERY_MONTHLY)
        r = subprocess.run(["node", ctx.tool("fund_fix.js"), "--data", data, "--inbox", inbox, "--out", out], capture_output=True, text=True, timeout=1800)
        res = json.loads((r.stdout or "{}").strip().splitlines()[-1] if (r.stdout or "").strip() else "{}")
        if not res.get("ok"):
            raise jc.JobError("fund_fix.js", jc.mask(res.get("error") or (r.stderr or "failed")[-300:]))
        rep = json.load(open(os.path.join(out, "report.json")))
        print(f"statements found {found.get('kept')}, with a fund account page {rep['statementsWithFunds']}, fund trades on them {rep['fundTradesOnStatements']}")
        print(f"unconfirmed fund rows {rep['unconfirmed']}: corrected {len(rep['corrected'])}, confirmed as they are {len(rep['confirmed'])}, "
              f"units differ {len(rep.get('unitsDiffer') or [])}, not on the statements {len(rep['notOnStatements'])}, no statement covers them {len(rep['uncovered'])}")
        for c in rep["corrected"]:
            f, t = c["from"], c["to"]
            print(f"  {c['t']} {c['a']}: {f['d']} {f.get('q')} units -> {t['d']} {t.get('q')} units"
                  f"{'' if abs((f.get('amt') or 0) - (t.get('amt') or 0)) < 0.005 else ' (amount changed)'} [{c['statement']}{'' if c['unitsPrinted'] else ', date only'}]")
        if rep.get("unitsDiffer"):
            print("units differ from the statement by more than 1% (left as they are, for a look):")
            for x in rep["unitsDiffer"]:
                print(f"  {x['d']} {x['t']} {x['a']} {x['q']} units; statement {x['statementDate']} {x['statementUnits']} units at {x['statementNav']} [{x['statement']}]")
        for k, title in (("notOnStatements", "not on the statements (left as they are)"), ("uncovered", "no statement covers them (left as they are)"),
                         ("missing", "on the statements but not in the ledger (not added)")):
            if rep[k]:
                print(f"{title}:")
                for x in rep[k]:
                    print(f"  {x['d']} {x['t']} {x['a']} {x.get('q') if x.get('q') is not None else ''}")
        if not a.apply:
            print("preview only: nothing was saved (run again with apply ticked to save the corrections)")
            return 0
        if not rep["corrected"] and not rep["confirmed"]:
            print("nothing to save")
            return 0
        writes = run_sync.writes_from_plan(os.path.join(out, "write"), jc.versions_of(data))
        res2, head = jc.apply_and_commit(ctx, writes, f"Fund rows checked against the Thndr statements ({len(rep['corrected'])} corrected)")
        print(f"saved: {len(res2['changed'])} documents, engine commit {head or 'none'}")
        import publish
        pr = publish.publish(ctx, "Fund rows checked against the Thndr statements", push=ctx.live)
        print(f"site: {'published' if pr['pushed'] else 'not published'}")
        return 0
    except (jc.JobError, imap_fetch.FetchError) as e:
        print(f"not done: {getattr(e, 'step', 'Gmail')}: {jc.mask(str(getattr(e, 'detail', e)))[:300]}")
        return 1
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
