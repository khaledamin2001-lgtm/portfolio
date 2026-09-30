#!/usr/bin/env python3
"""Month-end reports for ONE portfolio that has no inbox sync (Yassin's): the Excel workbook and the PDF factsheet for
last month, published encrypted on the site (Reports tab), plus the factsheet email.

    python3 run_reports.py --engine DIR [--code DIR] [--month YYYY-MM] [--manual] [--now ISO] [--no-publish] [--site-remote URL|PATH]

For a portfolio with the inbox sync, run_sync.py makes these reports when the monthly statement is posted. A portfolio
without it runs this job instead (from the 3rd of the month; the workflow fires daily 3rd-15th): M = last month (Cairo),
or --month. It does nothing when the site already lists M in <siteFolder>/exports/index.json, or when portfolio/marks
has no entry for M yet (the month-end values are still to be typed). Otherwise it makes the reports exactly like
run_sync.py's step 11 (month_end), publishes them with the data, and records the month in jobs.json.
Output: log lines of counts and statuses only. Any failure: email "Portfolio: reports FAILED <date>" and exit 1.
"""
import os, sys, json, argparse

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import jobs_common as jc  # noqa: E402

JOB = "reports"


def published_months(ctx):
    p = os.path.join(ctx.code, *ctx.config["siteFolder"].split("/"), "exports", "index.json")
    try:
        with open(p, encoding="utf-8") as f:
            return {e.get("month") for e in json.load(f) if isinstance(e, dict)}
    except (OSError, ValueError):
        return set()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--engine", required=True)
    ap.add_argument("--code")
    ap.add_argument("--month")
    ap.add_argument("--manual", action="store_true")
    ap.add_argument("--now")
    ap.add_argument("--no-publish", action="store_true")
    ap.add_argument("--site-remote")
    a = ap.parse_args(argv)
    ctx, step = None, "setup"
    try:
        ctx = jc.Ctx(a.engine, a.code, a.now)
        jc.engine_refresh(ctx)
        plan = ctx.plan()
        M = a.month or plan["prevMonth"]
        if not (a.month or a.manual) and plan["dayOfMonth"] < 3:
            jc.log(f"reports: not due before the 3rd (Cairo {plan['today']})")
            return 0
        if M in published_months(ctx):
            jc.log(f"reports: {M} is already published")
            return 0
        work = ctx.workdir()
        data = os.path.join(work, "data")
        step = "decrypt"
        ctx.materialize(data)
        marks = (jc.load_data(os.path.join(data, "portfolio", "marks.json"), {}) or {}).get("months") or {}
        if M not in marks:
            jc.log(f"reports: {M} has no month-end marks yet; nothing to do")
            return 0
        step = "month-end"
        import run_sync
        write_dir, exports_dir, reports = (os.path.join(work, x) for x in ("nowrite", "exports", "reports"))
        for d in (write_dir, exports_dir, reports):
            os.makedirs(d, exist_ok=True)
        r = run_sync.month_end(ctx, M, data, write_dir, {}, reports, exports_dir, work)
        jc.log(f"month-end {M}: workbook {'ok' if r['workbook'] else 'no'}, PDF {'ok' if r['pdf'] else 'no'}, "
               f"email {'sent' if r['emailed'] else 'no'}{', error ' + jc.mask(r['error']) if r.get('error') else ''}"
               f"{', PDF error ' + jc.mask(r['pdfError']) if r.get('pdfError') else ''}")
        if not r.get("entry"):
            raise jc.JobError("month-end", r.get("error") or "the workbook could not be made")
        r["entry"]["publishedAt"] = plan["today"]
        step = "publish"
        if not a.no_publish:
            import publish
            pr = publish.publish(ctx, f"Month-end reports {jc.short(M)}", exports=exports_dir, index_entries=[r["entry"]],
                                 push=ctx.live, remote=a.site_remote)
            jc.log(f"publish: {'pushed' if pr['pushed'] else 'committed locally (shadow)' if pr['committed'] else 'nothing to publish'}, "
                   f"head {pr['head']}, {len(pr['files'])} files")
        step = "record"
        for attempt in range(3):
            st = jc.jobs_state(ctx)
            st.setdefault("reports", {}).update({"at": jc.now_iso(), "status": "ok", "lastMonth": M})
            jc.save_jobs_state(ctx, st)
            try:
                jc.engine_commit(ctx, ["jobs.json"] + list(getattr(ctx, "outbox_files", [])), f"jobs: reports {M}")
                break
            except jc.PushRejected:
                jc.engine_refresh(ctx)
        if r.get("error"):
            raise jc.JobError("month-end", r["error"])     # published, but the email (or the PDF) failed: say so
        jc.log("reports: done")
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
