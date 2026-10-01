#!/usr/bin/env python3
"""Thndr inbox sync for ONE portfolio's engine repository (the Claude routine "Portfolio: Thndr inbox sync", plus the
11th-of-the-month statement backstop reminder, turned into code).

    python3 run_sync.py --engine DIR [--code DIR] [--manual] [--force-publish] [--now ISO] [--no-publish]
                        [--site-remote URL|PATH]

Schedule: the workflow fires at 18:17 and 22:17 Cairo in both UTC offsets (15:17, 16:17, 19:17, 20:17 UTC); a run
goes ahead only inside a slot window - "afternoon" 16:15-18:14, "evening" 18:15-22:59, "night" 23:00-23:59 and "after
midnight" 00:00-06:59 Cairo (a late-started 11 pm run) - when jobs.json has no run of
that slot today. --manual (workflow_dispatch, e.g. "Check inbox now" on the site) always runs and is not recorded as
a scheduled slot.

Steps (routine step numbers in brackets):
 [1,2] decrypt this portfolio's documents; PLAN = plan.js --lastRun <sync/state.lastRun>.
 [3,4] imap_fetch.py: Gmail X-GM-RAW search after PLAN.gmailAfter, new ids only -> inbox/<id>.json + manifest.json.
 [6,7] node src/tools/sync.js --data <docs> --inbox <inbox> --out <run> --today PLAN.today.
 [8]   run/write/* in ONE all-or-nothing write pinned to the versions read: ledger_yYYYY -> set ledger/yYYYY,
       marks -> set portfolio/marks, settings -> set portfolio/settings, assets_update -> update portfolio/assets,
       import_M -> set imports/M, sync_state -> set sync/state; committed and pushed to the engine repo. On a version
       conflict / rejected push: redo decrypt + sync.js + write once with the same inbox; then FAILED.
 [9]   summary.email with notify -> email to settings.factsheetEmail (subject/text from sync.js).
 [9b]  Weekly email: PLAN.weekday Thu and PLAN.hour >= 21, once per week-ending date (jobs.json), when the portfolio has
       it (config.weeklyEmail, default on for portfolioId "khaled" only - the routine sent it for Khaled only):
       weekly.js --week-ending PLAN.today; exit 2 = no closing prices, skipped. Failure is reported, not FAILED.
 [11]  For each month M in summary.monthlyPending: build the desk page from src/ (src/build.py), factsheet.js
       (--overlay run/write) -> HTML + PDF, excel.js + excel.py -> workbook, both encrypted with the site key as
       exports/<Prefix>-Portfolio-<Mon-YY>.{xlsx,pdf}.enc.json with an exports/index.json entry (without "pdf" when only
       the PDF failed), and the factsheet email (HTML + the sync text + where to download). The other portfolio's
       month-end files are made by its own engine repo, never here.
 [12]  Publish this portfolio's site folder with those files (publish.py) - always, so the heartbeat shows. Must succeed.
 [12b] Only after the publish: imports/M update {"reports": {factsheetSentAt, workbooksPublishedAt}, "reportsPending":
       {"__delete__": true}} for every month whose email went out and whose workbook was published.
 Backstop (the old 11th-of-the-month reminder): the first run on/after the 11th checks imports/<PLAN.prevMonth>; when
       last month's statement is not posted, it emails a reminder saying whether that month's marks are provisional or
       missing. Once per month (jobs.json).
 Token check: once a day, when SITE_TOKEN's expiry (GitHub's token-expiration header) is 14 days away or less, one
       email with the renewal steps.
Output: one line of counts per step; nothing that carries a figure. Any failure: email "Portfolio: inbox sync FAILED
<date>" with the step and error, exit 1.
"""
import os, re, sys, json, shutil, argparse, datetime, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import jobs_common as jc  # noqa: E402
import store  # noqa: E402

# the email run's three checks (4:15 pm, 6:15 pm, 11 pm Cairo), each window lasting until the next; GitHub starts scheduled
# runs hours late at times, so a run after midnight still counts once as last night's check
WINDOWS = [("afternoon", 16 * 60 + 15, 18 * 60 + 15), ("evening", 18 * 60 + 15, 23 * 60), ("night", 23 * 60, 24 * 60), ("after midnight", 0, 7 * 60)]
JOB = "inbox sync"


# ---------------------------------------------------------------- step 8: sync.js write/ -> store writes
def writes_from_plan(write_dir, versions):
    """Every file sync.js wrote, as store writes pinned to the versions read (0 = the document did not exist)."""
    V = lambda k: versions.get(k, 0)
    out = []
    for f in sorted(os.listdir(write_dir)):
        with open(os.path.join(write_dir, f), encoding="utf-8") as fh:
            data = json.load(fh)
        m = re.match(r"^ledger_(y\d{4})\.json$", f)
        mi = re.match(r"^import_(\d{4}-\d{2})\.json$", f)
        if m:
            w = ("set", "ledger", m.group(1))
        elif f == "marks.json":
            w = ("set", "portfolio", "marks")
        elif f == "settings.json":
            w = ("set", "portfolio", "settings")
        elif f == "assets_update.json":
            w = ("update", "portfolio", "assets")
        elif mi:
            w = ("set", "imports", mi.group(1))
        elif f == "sync_state.json":
            w = ("set", "sync", "state")
        else:
            raise jc.JobError("write", f"sync.js wrote an unknown file {f}")
        out.append({"op": w[0], "collection": w[1], "doc_id": w[2], "data": data, "if_version": V(f"{w[1]}/{w[2]}")})
    return out


def run_sync_js(ctx, data, inbox, run, plan):
    shutil.rmtree(run, ignore_errors=True)
    os.makedirs(run)
    jc.run(["node", ctx.tool("sync.js"), "--data", data, "--inbox", inbox, "--out", run, "--today", plan["today"]], "sync.js")
    with open(os.path.join(run, "summary.json"), encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------- step 11: month-end reports
def prefix(ctx):
    return ctx.config.get("filePrefix") or ctx.config["portfolioId"].capitalize()


def site_url(ctx):
    owner, repo = ctx.config["siteRepo"].split("/", 1)
    return f"https://{owner}.github.io/{repo}/"


def portfolio_label(ctx):
    try:
        with open(os.path.join(ctx.code, "portfolios.json"), encoding="utf-8") as f:
            for p in json.load(f):
                if p.get("id") == ctx.config["portfolioId"]:
                    return p.get("name") or ctx.config["portfolioId"]
    except Exception:
        pass
    return ctx.config.get("name") or ctx.config["portfolioId"]


def desk_page(ctx, work):
    """Build the desk page from the public repo's src/ (never a Claude page); returns its path."""
    b = os.path.join(work, "page")
    if not os.path.isdir(b):
        os.makedirs(b)
        for f in ("app.html", "engine.js", "engine2.js", "statement.js", "app2.js", "build.py"):
            shutil.copy(os.path.join(ctx.code, "src", f), b)
        jc.run([sys.executable, os.path.join(b, "build.py")], "month-end: build page", cwd=b)
    name = "yassin-desk.html" if ctx.config["portfolioId"] == "yassin" else "portfolio-desk.html"
    return os.path.join(b, name)


def ensure_playwright(ctx):
    """factsheet.js needs Playwright + Chromium; the workflow installs them only when a month-end report is due."""
    cmd = os.environ.get("JOBS_PLAYWRIGHT_SETUP")
    if not cmd or getattr(ctx, "_pw", False):
        return
    jc.run(["bash", "-c", cmd], "month-end: install Playwright", timeout=900)
    ctx._pw = True


def month_end(ctx, M, data, write_dir, summary, reports, exports_dir, work):
    """Returns a dict: {month, emailed, workbook, pdf, error?, entry?}."""
    S = jc.short(M)
    base = f"{prefix(ctx)}-Portfolio-{S}"
    res = {"month": M, "emailed": False, "workbook": False, "pdf": False}
    keys = ctx.keys_path
    enc = os.path.join(ctx.code, "tools", "encrypt_file.py")
    html_path = os.path.join(reports, f"factsheet-{M}.html")
    pdf_path, xlsx_path = os.path.join(reports, base + ".pdf"), os.path.join(reports, base + ".xlsx")
    # a. factsheet HTML + PDF from the page's own code
    errors = []
    try:
        ensure_playwright(ctx)
        page = desk_page(ctx, work)
        fs = ["node", ctx.tool("factsheet.js"), "--page", page, "--data", data, "--overlay", write_dir, "--month", M, "--out", html_path]
        try:
            jc.run(fs + ["--pdf", pdf_path], "month-end: factsheet", timeout=600)
            res["pdf"] = os.path.exists(pdf_path)
        except jc.JobError as e:
            res["pdfError"] = e.detail                     # retry without the PDF: the email only needs the HTML
            jc.run(fs, "month-end: factsheet", timeout=600)
    except jc.JobError as e:
        errors.append(f"{e.step}: {e.detail}")
    # b. workbook, then both files encrypted for the site
    try:
        xl = os.path.join(reports, f"xl-{M}.json")
        jc.run(["node", ctx.tool("excel.js"), "--data", data, "--overlay", write_dir, "--month", M, "--out", xl], "month-end: excel.js")
        jc.run([sys.executable, ctx.tool("excel.py"), xl, xlsx_path], "month-end: excel.py")
        jc.run([sys.executable, enc, xlsx_path, keys, os.path.join(exports_dir, base + ".xlsx.enc.json")], "month-end: encrypt workbook")
        res["workbook"] = True
        entry = {"month": M, "name": base + ".xlsx", "file": f"exports/{base}.xlsx.enc.json"}
        if res["pdf"]:
            try:
                jc.run([sys.executable, enc, pdf_path, keys, os.path.join(exports_dir, base + ".pdf.enc.json")], "month-end: encrypt PDF")
                entry["pdf"] = f"exports/{base}.pdf.enc.json"
            except jc.JobError as e:
                res["pdf"], res["pdfError"] = False, e.detail
        entry["publishedAt"] = None          # filled in by the caller (PLAN.today)
        res["entry"] = entry
    except jc.JobError as e:
        errors.append(f"{e.step}: {e.detail}")
    # d. the factsheet email (needs the factsheet HTML and the published workbook)
    try:
        if errors or not res["workbook"] or not os.path.exists(html_path):
            raise jc.JobError("month-end: email", "not sent because an earlier month-end step failed")
        with open(html_path, encoding="utf-8") as f:
            html = f.read()
        text = ((summary.get("email") or {}).get("text") or "").rstrip()
        what = "Excel workbook and PDF factsheet" if res["pdf"] else "Excel workbook"
        buttons = "Download Excel or Download PDF" if res["pdf"] else "Download Excel"
        lines = (f"{what} for {S}: open {site_url(ctx)}, pick {portfolio_label(ctx)}, open the Reports tab, choose {S} and press "
                 f"{buttons} (Excel sheets: Summary, Monthly, Holdings, Ledger, Closed trades, Income, Attribution, Marks & inputs).")
        body = (text + "\n\n" if text else "") + lines
        name = ctx.settings().get("name") or ctx.config.get("name") or "Portfolio"
        import mail_send
        mail_send.send(ctx, f"{name} · factsheet {S}", body, html)
        res["emailed"] = True
    except jc.JobError as e:
        errors.append(f"{e.step}: {e.detail}")
    if errors:
        res["error"] = "; ".join(errors)
    return res


# ---------------------------------------------------------------- backstop and token check
def backstop(ctx, plan, data, write_dir, jobs):
    """The 11th-of-the-month reminder. Returns a status string or None when not due."""
    P = plan["prevMonth"]
    bs = jobs.setdefault("sync", {}).setdefault("backstop", {})
    if plan["dayOfMonth"] < 11 or P in bs:
        return None
    posted = os.path.exists(os.path.join(data, "imports", P + ".json")) or os.path.exists(os.path.join(write_dir, f"import_{P}.json"))
    bs[P] = plan["today"]
    for k in sorted(bs)[:-12]:        # keep a year of entries
        bs.pop(k, None)
    if posted:
        return f"{jc.short(P)} statement already posted"
    mp = os.path.join(write_dir, "marks.json")
    marks = jc.load_data(mp if os.path.exists(mp) else os.path.join(data, "portfolio", "marks.json"), {}) or {}
    mk = (marks.get("months") or {}).get(P)
    state = ("not set yet" if not mk else "an estimate for now" if mk.get("provisional") else f"taken from {mk.get('source') or 'an unknown source'}")
    name = ctx.settings().get("name") or ctx.config.get("name") or "Portfolio"
    mon = datetime.date(int(P[:4]), int(P[5:]), 1).strftime("%B")
    text = (f"Your {jc.short(P)} Thndr monthly statement has not been posted to {name} yet.\n\n"
            f"The inbox sync posts it by itself as soon as the email arrives in Gmail. If it is already in your inbox, it may be "
            f"held for review (see the \"needs your review\" email), or it may not have arrived: request it in the Thndr app.\n\n"
            f"{mon}'s month-end value is {state}; the statement replaces it with Thndr's own figures.\n\n{site_url(ctx)}")
    import mail_send
    return "reminder " + mail_send.send(ctx, f"{name}: {jc.short(P)} Thndr statement not posted yet", text)


def token_check(ctx, plan, jobs):
    tok = os.environ.get("SITE_TOKEN", "").strip()
    sj = jobs.setdefault("sync", {})
    if not tok or sj.get("tokenCheckedOn") == plan["today"]:
        return None
    sj["tokenCheckedOn"] = plan["today"]
    try:
        req = urllib.request.Request(f"https://api.github.com/repos/{ctx.config['siteRepo']}",
                                     headers={"Authorization": f"Bearer {tok}", "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            exp = r.headers.get("github-authentication-token-expiration")
    except Exception as e:
        return f"token check skipped ({type(e).__name__})"
    if not exp:
        return "token has no expiry"
    try:
        d = datetime.datetime.strptime(exp.strip()[:10], "%Y-%m-%d").date()
    except ValueError:
        return "token expiry unreadable"
    today = datetime.date.fromisoformat(plan["today"])
    if (d - today).days > 14:
        return f"token valid until {d}"
    if sj.get("tokenWarned") == str(d):
        return f"token expires {d} (already warned)"
    text = (f"The publishing token the portfolio jobs use (GitHub secret SITE_TOKEN) expires on {d}.\n\n"
            "To renew it: GitHub -> Settings -> Developer settings -> Personal access tokens -> Fine-grained tokens -> "
            "Generate new token; repository access: only the site repository; permissions: Contents read and write. "
            "Then in the engine repository: Settings -> Secrets and variables -> Actions -> SITE_TOKEN -> Update, paste it, "
            "and run the Setup check workflow once to confirm.")
    import mail_send
    mail_send.send(ctx, f"Portfolio: publishing token expires {d}", text)
    sj["tokenWarned"] = str(d)
    return f"token expires {d}: reminder emailed"


# ---------------------------------------------------------------- main
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--engine", required=True)
    ap.add_argument("--code")
    ap.add_argument("--manual", action="store_true")
    ap.add_argument("--force-publish", action="store_true")
    ap.add_argument("--now")
    ap.add_argument("--no-publish", action="store_true")
    ap.add_argument("--site-remote")
    a = ap.parse_args(argv)
    ctx, step, notes = None, "setup", []
    try:
        ctx = jc.Ctx(a.engine, a.code, a.now)
        jc.engine_refresh(ctx)
        plan0 = ctx.plan()
        jobs = jc.jobs_state(ctx)
        done = (jobs.get("sync") or {}).get("slots") or {}
        slot, why = jc.gate(plan0, WINDOWS, done, a.manual)
        if slot == "after midnight":   # only for a late-started 11 pm check: last night's check must be missing
            yday = (datetime.date.fromisoformat(plan0["today"]) - datetime.timedelta(days=1)).isoformat()
            if done.get("night") == yday or (done.get("after midnight") or "") >= plan0["today"]:
                slot, why = None, "last night's check already happened"
        # the email run's later steps (friends, Yassin's reports) follow this decision
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as fh:
                fh.write(f"ran={'true' if slot else 'false'}\n")
        if not slot:
            jc.log(f"sync: skipped ({why}; Cairo {plan0['nowCairo'][11:16]})")
            return 0
        jc.log(f"sync: {why}, {plan0['today']} Cairo {plan0['nowCairo'][11:16]}, mode {ctx.mode}")
        work = ctx.workdir()
        data, inbox, run = (os.path.join(work, x) for x in ("data", "inbox", "run"))
        # [1,2] documents and PLAN
        step = "decrypt"
        ctx.materialize(data)
        st = jc.load_data(os.path.join(data, "sync", "state.json"), {}) or {}
        step = "plan"
        plan = ctx.plan(st.get("lastRun"))
        # [3,4] inbox
        step = "Gmail fetch"
        import imap_fetch
        try:
            c = imap_fetch.fetch(plan["gmailAfter"], set(st.get("seen") or {}), inbox)
        except imap_fetch.FetchError as e:
            raise jc.JobError("Gmail fetch", str(e)) from None
        jc.log(f"gmail: after {plan['gmailAfter']}: {c['found']} found, {c['kept']} new, {c['seen']} already seen, {c['otherSubject']} other subjects")
        # [6,7,8] sync.js and the pinned write, redone once on a conflict
        for attempt in range(2):
            if attempt:
                jc.log("sync: the data changed meanwhile; redoing sync.js on the fresh documents with the same inbox")
                jc.engine_refresh(ctx)
                step = "decrypt"
                ctx.materialize(data)
            step = "sync.js"
            summary = run_sync_js(ctx, data, inbox, run, plan)
            step = "write"
            writes = writes_from_plan(os.path.join(run, "write"), jc.versions_of(data))
            try:
                res, head = jc.apply_and_commit(ctx, writes, f"Thndr sync {plan['today']} ({slot})")
                break
            except (store.VersionConflict, jc.PushRejected) as e:
                if attempt:
                    raise jc.JobError("write", f"the data changed again while writing ({type(e).__name__}); nothing more was done")
        write_dir = os.path.join(run, "write")
        jc.log(f"sync.js: status {summary.get('status')}, {summary.get('processed')} processed, {summary.get('applied')} applied, "
               f"{summary.get('held')} held, months posted {summary.get('monthlyPosted')}, pending reports {summary.get('monthlyPending')}, "
               f"heads-up {len((summary.get('digest') or {}).get('items') or [])} ({len((summary.get('digest') or {}).get('emailed') or [])} new), "
               f"{len(res['changed'])} documents changed, engine commit {head or 'none'}")
        import mail_send
        # [9] heads-up / summary email
        step = "email"
        em = summary.get("email")
        if em and em.get("notify"):
            jc.log("email: " + mail_send.send(ctx, em["subject"], em["text"]))
        else:
            jc.log("email: none due")
        # [9b] weekly email (Thursday late run)
        weekly_on = ctx.config.get("weeklyEmail", ctx.config["portfolioId"] == "khaled")
        sj = jobs.setdefault("sync", {})
        if weekly_on and plan["weekday"] == "Thu" and plan["hour"] >= 21:
            if sj.get("weeklySent") == plan["today"]:
                jc.log("weekly: already sent for this week")
            else:
                try:
                    wk = [os.path.join(work, f) for f in ("weekly.html", "weekly.txt", "weekly.json")]
                    jc.run(["node", ctx.tool("weekly.js"), "--data", data, "--overlay", write_dir, "--week-ending", plan["today"],
                            "--today", plan["today"], "--out", wk[0], "--text", wk[1], "--json", wk[2]], "weekly", ok=(0, 2))
                    if jc.run.last_code == 2:
                        jc.log("weekly: skipped (no closing prices this week)")
                        notes.append("weekly skipped: no closing prices")
                    else:
                        w = json.load(open(wk[2]))
                        jc.log("weekly: " + mail_send.send(ctx, w["subject"], open(wk[1], encoding="utf-8").read(), open(wk[0], encoding="utf-8").read()))
                        sj["weeklySent"] = plan["today"]
                except jc.JobError as e:
                    jc.log(f"weekly: FAILED (not fatal): {e.step}: {jc.mask(e.detail)}")
                    notes.append(f"weekly email failed: {e.step}")
        else:
            jc.log("weekly: not due")
        # [11] month-end reports
        step = "month-end"
        pending = summary.get("monthlyPending") or []
        exports_dir, reports = os.path.join(work, "exports"), os.path.join(work, "reports")
        os.makedirs(exports_dir, exist_ok=True)
        os.makedirs(reports, exist_ok=True)
        results = []
        for M in pending:
            r = month_end(ctx, M, data, write_dir, summary, reports, exports_dir, work)
            if r.get("entry"):
                r["entry"]["publishedAt"] = plan["today"]
            results.append(r)
            jc.log(f"month-end {M}: workbook {'ok' if r['workbook'] else 'no'}, PDF {'ok' if r['pdf'] else 'no'}, "
                   f"email {'sent' if r['emailed'] else 'no'}{', error ' + jc.mask(r['error']) if r.get('error') else ''}"
                   f"{', PDF error ' + jc.mask(r['pdfError']) if r.get('pdfError') else ''}")
        entries = [r["entry"] for r in results if r.get("entry")]
        # [12] publish (always)
        step = "publish"
        published = False
        if not a.no_publish:
            import publish
            idx = entries or None
            pr = publish.publish(ctx, f"Thndr sync {plan['today']}", exports=exports_dir if entries else None,
                                 index_entries=idx, push=ctx.live, remote=a.site_remote, force=a.force_publish)
            published = True
            jc.log(f"publish: {'pushed' if pr['pushed'] else 'committed locally (shadow)' if pr['committed'] else 'nothing to publish'}"
                   f"{', data unchanged' if pr['dataUnchanged'] else ''}, head {pr['head']}, {len(pr['files'])} files")
        # [12b] stamp only after the publish succeeded
        step = "stamp reports"
        done = [r["month"] for r in results if r["emailed"] and r["workbook"]]
        if done and published:
            for attempt in range(3):
                now = jc.now_iso()
                stamps = [{"op": "update", "collection": "imports", "doc_id": M,
                           "data": {"reports": {"factsheetSentAt": now, "workbooksPublishedAt": now}, "reportsPending": {"__delete__": True}}}
                          for M in done]
                try:
                    _, h = jc.apply_and_commit(ctx, stamps, f"Month-end reports {','.join(done)} published")
                    jc.log(f"stamped {','.join(done)} (engine commit {h or 'none'})")
                    break
                except jc.PushRejected:
                    jc.engine_refresh(ctx)
            else:
                raise jc.JobError("stamp reports", "the engine repository kept changing")
        unfinished = [r["month"] for r in results if r["month"] not in done or not published]
        if unfinished:
            notes.append(f"month-end still pending: {','.join(unfinished)}")
        # backstop + token check + bookkeeping
        step = "backstop"
        b = backstop(ctx, plan, data, write_dir, jobs)
        if b:
            jc.log("backstop: " + b)
        step = "token check"
        t = token_check(ctx, plan, jobs)
        if t:
            jc.log(t)
        step = "record"
        slots = sj.setdefault("slots", {})
        if slot != "manual":
            slots[slot] = plan["today"]
        sj.update({"at": jc.now_iso(), "status": "ok", "lastSlot": slot})
        rec = dict(sj)
        for attempt in range(3):
            j2 = jc.jobs_state(ctx)
            j2["sync"] = rec
            jc.save_jobs_state(ctx, j2)
            try:
                jc.engine_commit(ctx, ["jobs.json"] + list(getattr(ctx, "outbox_files", [])), f"jobs: sync {plan['today']} {slot}")
                break
            except jc.PushRejected:
                jc.engine_refresh(ctx)
        jc.log("sync: done" + (" - " + "; ".join(notes) if notes else ""))
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
