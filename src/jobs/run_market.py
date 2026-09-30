#!/usr/bin/env python3
"""Daily market update for ONE portfolio's engine repository (the Claude routine "Portfolio: EGX close market update",
turned into code), then a site refresh for that portfolio (the old 3:38 PM "refresh live site" routine).

    python3 run_market.py --engine DIR [--code DIR] [--manual] [--force-publish] [--prices out.json] [--now ISO]
                          [--no-publish] [--site-remote URL|PATH]

Schedule: the workflow fires at 15:10 Cairo in both UTC offsets (12:10 and 13:10 UTC, Sun-Thu); the job runs only
when plan.js says it is an EGX weekday (Sun-Thu), the Cairo time is 15:10 or later, and jobs.json has no market run
for today. --manual (workflow_dispatch, e.g. "Refresh prices now" on the site) runs regardless and is not recorded as
the day's scheduled run.

Steps (routine step numbers):
 1-2. Decrypt this portfolio's documents. Prices are fetched for THIS portfolio's assets only (the routine's union
      with the other portfolio's list is gone: the portfolios never mix).
 3.   python3 src/jobs/fetch_prices.py <assets> > out.json, retried 3 times 30 s apart (--prices uses a saved file).
      fillErrors are not a failure.
 4.   One all-or-nothing write, every document pinned to the version just read (if_version):
      a. market/latest  set = out.latest
      b. history/<H.month> for each H in out.histories: update {"days": H.days} when it exists, else set H
      c. bench/egx30    update {members, asOf} (+ divYield, divYieldAsOf when out.bench.divYield is a number);
                        capWeight, actions, actionsSource are never touched
      d. portfolio/marks update {"months": patch}: months[P].benchClose for P = out.prevMonth.month when months[P]
         exists, has no numeric benchClose and out.prevMonth.benchClose is a number; for every month K already in the
         marks with K < out.currentMonth: cpi/cpiSource from macro.cpiMoM[K], usdegp/usdegpSource from macro.fxEom[K],
         cashRate/cashRateSource from macro.cashRate[K], each only when months[K] has no numeric value there. An
         existing value is never overwritten; cash, securities, source and provisional are never touched.
      e. portfolio/assets update {"items": entries} for out.newAssets names not already in the assets (watch entries).
      Ledger, settings, imports and sync documents are never written. If someone saved meanwhile (version conflict
      or rejected push) the patches are recomputed on the fresh documents once with the same prices.
 5.   Publish this portfolio's site folder (publish.py). Then jobs.json records the run.
 6.   Scheduled runs only, unless config.json "marketEmail" is false: the "Portfolio: market updated <close date>" email, market figures only (never holdings, cash,
      values or anything from the ledger, marks or settings). A failure to send it is logged, not a job failure.
Output: one line of counts. Any failure: email "Portfolio: market FAILED <date>" and exit 1.
"""
import os, sys, json, time, argparse, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import jobs_common as jc  # noqa: E402
import store  # noqa: E402

WINDOW = [("day", 15 * 60 + 10, 24 * 60)]


def isnum(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def marks_patch(marks, out):
    """The routine's step 4d. marks = portfolio/marks data; returns the {"months": ...} patch dict (possibly empty)."""
    months = (marks or {}).get("months") or {}
    patch = {}
    pm = out.get("prevMonth") or {}
    P = pm.get("month")
    if P and P in months and not isnum((months[P] or {}).get("benchClose")) and isnum(pm.get("benchClose")):
        patch.setdefault(P, {})["benchClose"] = pm["benchClose"]
    macro = out.get("macro") or {}
    cur = out.get("currentMonth")
    for K in sorted(months):
        if not cur or not (K < cur):
            continue
        m = months[K] or {}
        for field, series, source in (("cpi", "cpiMoM", "cpiSource"), ("usdegp", "fxEom", "fxSource"), ("cashRate", "cashRate", "cashRateSource")):
            s = macro.get(series) or {}
            if not isnum(m.get(field)) and K in s and s[K] is not None:
                p = patch.setdefault(K, {})
                p[field] = s[K]
                p[field + "Source"] = macro.get(source)
    return patch


def success_email(out, info, published):
    """Step 6: (subject, plain-text body) of the market-updated email. Market figures only."""
    L = out.get("latest") or {}
    ix = (L.get("index") or {}).get("EGX30CAPPED") or {}
    close_date = ix.get("date") or max((d for H in out.get("histories") or [] for d in (H.get("days") or {})), default=None) or (L.get("asOf") or "")[:10]
    pol = (L.get("rates") or {}).get("policy") or {}
    bench = out.get("bench") or {}
    pct = lambda v: f"{v * 100:.2f}%" if isnum(v) else "n/a"
    fe, miss = sorted(out.get("fillErrors") or {}), L.get("missing") or []
    names = {"cpi": "CPI", "usdegp": "USD/EGP", "cashRate": "CBE rate"}
    filled = [f"{names[k]} {', '.join(v)}" for k, v in info["marksFilled"].items() if v and k in names]
    lines = [f"Close date: {close_date} (as of {L.get('asOf')})",
             f"Quotes: {len(L.get('quotes') or {})}",
             f"EGX30 Capped: {ix['close']:,.2f} ({ix.get('chg', 0):+.2f}% on the day)" if isnum(ix.get("close")) else "EGX30 Capped: n/a",
             f"CBE policy rate: {pct(pol.get('rate'))}" + (f" (since {pol['date']})" if pol.get("date") else ""),
             f"Index dividend yield: {pct(bench.get('divYield'))}",
             f"History written: {', '.join(info['historyMonths']) or 'none'} ({info['sessions']} sessions)",
             f"Fill errors or missing symbols: {', '.join(fe + list(miss)) or 'none'}",
             f"New index members added: {info['newAssets'] or 'none'}",
             f"CPI / USD/EGP / CBE-rate months filled: {'; '.join(filled) or 'none'}",
             "The live site is updated." if published else "The live site data was already current."]
    return f"Portfolio: market updated {close_date}", "\n".join(lines) + "\n"


def build_writes(data_dir, out):
    """Step 4 as store writes, pinned to the versions in the materialized data_dir. Returns (writes, info)."""
    ver = jc.versions_of(data_dir)
    V = lambda k: ver.get(k, 0)
    D = lambda c, d: jc.load_data(os.path.join(data_dir, c, d + ".json"))
    w, info = [], {}
    # a. market/latest
    w.append({"op": "set", "collection": "market", "doc_id": "latest", "data": out["latest"], "if_version": V("market/latest")})
    # b. history months
    info["historyMonths"] = []
    sessions = set()
    for H in out.get("histories") or []:
        k = f"history/{H['month']}"
        if k in ver:
            w.append({"op": "update", "collection": "history", "doc_id": H["month"], "data": {"days": H["days"]}, "if_version": ver[k]})
        else:
            w.append({"op": "set", "collection": "history", "doc_id": H["month"], "data": H, "if_version": 0})
        info["historyMonths"].append(H["month"])
        sessions.update(H["days"])
    info["sessions"] = len(sessions)
    # c. bench/egx30
    b = out.get("bench") or {}
    bu = {"members": b.get("members"), "asOf": b.get("asOf")}
    if isnum(b.get("divYield")):
        bu["divYield"], bu["divYieldAsOf"] = b["divYield"], b.get("divYieldAsOf")
    w.append({"op": "update", "collection": "bench", "doc_id": "egx30", "data": bu, "if_version": V("bench/egx30")})
    # d. marks
    mp = marks_patch(D("portfolio", "marks"), out)
    info["marksFilled"] = {f: sorted(k for k, v in mp.items() if f in v) for f in ("benchClose", "cpi", "usdegp", "cashRate")}
    if mp:
        w.append({"op": "update", "collection": "portfolio", "doc_id": "marks", "data": {"months": mp}, "if_version": V("portfolio/marks")})
    # e. new index members as watch entries
    items = (D("portfolio", "assets") or {}).get("items") or {}
    new = {n: e for n, e in (out.get("newAssets") or {}).items() if n not in items}
    info["newAssets"] = len(new)
    if new:
        w.append({"op": "update", "collection": "portfolio", "doc_id": "assets", "data": {"items": new}, "if_version": V("portfolio/assets")})
    return w, info


def fetch_prices(ctx, assets_path, out_path):
    script = os.path.join(ctx.code, "src", "jobs", "fetch_prices.py")
    if not os.path.exists(script):
        script = os.path.join(ctx.code, "tools", "fetch_prices.py")
    last = None
    for attempt in range(4):
        if attempt:
            time.sleep(int(os.environ.get("JOBS_RETRY_WAIT", "30")))
        try:
            jc.run([sys.executable, script, assets_path], "fetch prices", stdout=out_path, timeout=600)
            with open(out_path) as f:
                out = json.load(f)
            if not isinstance(out.get("latest"), dict) or not out["latest"].get("quotes"):
                raise jc.JobError("fetch prices", "no quotes in the output")
            return out
        except (jc.JobError, ValueError) as e:
            last = e
    raise last if isinstance(last, jc.JobError) else jc.JobError("fetch prices", str(last))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--engine", required=True)
    ap.add_argument("--code")
    ap.add_argument("--manual", action="store_true", help="started by hand: skip the time gate")
    ap.add_argument("--force-publish", action="store_true")
    ap.add_argument("--prices", help="use this fetch_prices.py output instead of fetching (tests)")
    ap.add_argument("--now", help="override the clock (tests)")
    ap.add_argument("--no-publish", action="store_true")
    ap.add_argument("--site-remote")
    a = ap.parse_args(argv)
    ctx, step = None, "setup"
    try:
        ctx = jc.Ctx(a.engine, a.code, a.now)
        jc.engine_refresh(ctx)
        plan = ctx.plan()
        state = jc.jobs_state(ctx)
        ms = state.setdefault("market", {})
        if not a.manual and not plan["isEgxSession"]:
            jc.log(f"market: skipped ({plan['weekday']} is not an EGX session day)")
            return 0
        slot, why = jc.gate(plan, WINDOW, {"day": ms.get("lastRun")}, a.manual)
        if not slot:
            jc.log(f"market: skipped ({why}; Cairo {plan['nowCairo'][11:16]})")
            return 0
        jc.log(f"market: {why}, {plan['today']} Cairo {plan['nowCairo'][11:16]}, mode {ctx.mode}")
        work = ctx.workdir()
        data = os.path.join(work, "data")
        step = "decrypt"
        ctx.materialize(data)
        assets = os.path.join(data, "portfolio", "assets.json")
        if not os.path.exists(assets):
            raise jc.JobError("decrypt", "portfolio/assets is missing")
        step = "fetch prices"
        if a.prices:
            with open(a.prices) as f:
                out = json.load(f)
        else:
            out = fetch_prices(ctx, assets, os.path.join(work, "out.json"))
        step = "write"
        for attempt in range(2):
            if attempt:
                jc.log("market: the data changed meanwhile; recomputing on the fresh documents")
                jc.engine_refresh(ctx)
                ctx.materialize(data)
            writes, info = build_writes(data, out)
            try:
                res, head = jc.apply_and_commit(ctx, writes, f"Market update {plan['today']}")
                break
            except (store.VersionConflict, jc.PushRejected) as e:
                if attempt:
                    raise jc.JobError("write", f"the data kept changing while writing ({type(e).__name__})")
        st = {r["status"] for r in res["results"]}
        jc.log(f"market: asOf {out['latest'].get('asOf')}, {len(out['latest'].get('quotes') or {})} quotes, "
               f"{len(out['latest'].get('index') or {})} indices, history {','.join(info['historyMonths'])} "
               f"({info['sessions']} sessions), fillErrors {len(out.get('fillErrors') or {})}, "
               f"missing {len(out['latest'].get('missing') or [])}, new index members {info['newAssets']}, "
               f"filled benchClose {info['marksFilled']['benchClose']} cpi {info['marksFilled']['cpi']} "
               f"usdegp {info['marksFilled']['usdegp']} cashRate {info['marksFilled']['cashRate']}; "
               f"{len(res['changed'])} documents changed ({'/'.join(sorted(st))}), engine commit {head or 'none'}")
        step = "publish"
        r = None
        if not a.no_publish:
            import publish
            r = publish.publish(ctx, f"Daily data update {plan['today']}", push=ctx.live, remote=a.site_remote, force=a.force_publish)
            jc.log(f"publish: {'pushed' if r['pushed'] else 'committed locally (shadow)' if r['committed'] else 'nothing to publish'}"
                   f"{', data unchanged' if r['dataUnchanged'] else ''}, head {r['head']}, {len(r['files'])} files")
        if slot != "manual" and ctx.config.get("marketEmail", True) is not False:
            try:
                import mail_send
                subj, body = success_email(out, info, bool(r and r["pushed"]))
                jc.log("email: " + mail_send.send(ctx, subj, body))
            except Exception as e:     # the update itself succeeded; a missing notice is not a failed job
                jc.log(f"email: not sent ({type(e).__name__}: {jc.redact(str(e))[:200]})")
        step = "record"
        state = jc.jobs_state(ctx)
        ms = state.setdefault("market", {})
        if slot != "manual":
            ms["lastRun"] = plan["today"]
        ms.update({"at": jc.now_iso(), "status": "ok", "slot": slot})
        jc.save_jobs_state(ctx, state)
        for attempt in range(3):
            try:
                jc.engine_commit(ctx, ["jobs.json"] + list(getattr(ctx, "outbox_files", [])), f"jobs: market {plan['today']}")
                break
            except jc.PushRejected:
                jc.engine_refresh(ctx)
                state = jc.jobs_state(ctx)
                state.setdefault("market", {}).update(ms)
                jc.save_jobs_state(ctx, state)
        jc.log("market: done")
        return 0
    except jc.JobError as e:
        jc.report_failure(ctx, "market", e.step, e.detail, a.engine, a.code)
        return 1
    except Exception as e:     # anything unexpected still alerts the owner
        jc.report_failure(ctx, "market", step, f"{type(e).__name__}: {e}", a.engine, a.code)
        return 1
    finally:
        if ctx:
            ctx.cleanup()


if __name__ == "__main__":
    sys.exit(main())
