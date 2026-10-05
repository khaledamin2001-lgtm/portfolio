#!/usr/bin/env python3
"""Shared plumbing for the jobs (run_account_mail.py, run_shared_market.py, run_morning.py, email_gate.py, mail_send.py, ...).

The jobs run inside the PRIVATE engine repository's GitHub Actions workflows with two checkouts:
    engine/   the private repo: config.json, jobs.json, shared/ (the public market data every account reads)
    code/     the public site repo at main: src/tools/* (plan.js, sync.js, ...), src/jobs/* (this code), keys/mail.json
Every portfolio lives in its owner's site account (Firestore), encrypted to that account's key; a job opens one only
through the account's own mail package (run_account_mail.py). Nothing any job prints carries a portfolio figure or a
secret: logs are counts and statuses only. Plaintext documents exist only in a temporary work directory that is removed
when the job ends.

config.json (plain, in the engine repo): {"siteRepo", "timezone", "ownerEmail"}
    siteRepo    the public site repository ("owner/name")
    ownerEmail  where the site owner's notices go (job FAILED, key and token reminders); default: the GMAIL_ADDRESS secret
jobs.json (plain, in the engine repo): when each scheduled job last ran (dates and statuses only, never figures).
keys/mail.json (in the site repo): the MAIL key's public half and its private half wrapped by SETUP_KEY (the
KHALED_SETUP_KEY secret); accounts seal their mail packages to it.

Times: every Cairo date/hour comes from src/tools/plan.js (env JOBS_NOW / --now overrides the clock, tests only).
"""
import os, re, sys, json, time, shutil, base64, tempfile, subprocess, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import store  # noqa: E402  (src/jobs/store.py)

CODE_DEFAULT = os.path.dirname(os.path.dirname(HERE))      # src/jobs/ -> repository root
MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def log(*a):
    print(*a, flush=True)


class JobError(Exception):
    """A step failed. `step` names it; the message is for the owner's FAILED email (the log gets a masked copy)."""
    def __init__(self, step, msg):
        super().__init__(f"{step}: {msg}")
        self.step, self.detail = step, msg


class PushRejected(Exception):
    """Someone else pushed to the engine repo meanwhile: redo from fresh data."""


def short(m):
    """'2026-09' -> 'Sep-26'."""
    return f"{MON[int(m[5:7]) - 1]}-{m[2:4]}"


# ---------------------------------------------------------------- masking (logs only)
_SECRET_ENVS = ("SETUP_KEY", "GMAIL_APP_PASSWORD", "SENDER_APP_PASSWORD", "SITE_TOKEN", "GITHUB_TOKEN")


def redact(s):
    s = str(s)
    for k in _SECRET_ENVS:
        v = os.environ.get(k, "").strip()
        if len(v) >= 6:
            s = s.replace(v, "***")
            if k in ("GMAIL_APP_PASSWORD", "SENDER_APP_PASSWORD"):
                s = s.replace(v.replace(" ", ""), "***")
            if k == "SITE_TOKEN":
                s = s.replace(base64.b64encode(f"x-access-token:{v}".encode()).decode(), "***")
    return s


def mask(s, limit=300):
    """For logs: secrets removed, money-looking numbers (4+ digits or decimals) replaced by #, one line, capped."""
    s = redact(s)
    s = re.sub(r"\d[\d,]*\.\d+|\d{4,}", "#", s)
    s = " ".join(s.split())
    return s[:limit]


# ---------------------------------------------------------------- context
EMAIL_RE = re.compile(r"^[^@\s,;<>]+@[^@\s,;<>]+\.[A-Za-z]{2,}$")


class Ctx:
    """The engine checkout, the code checkout and the clock."""
    def __init__(self, engine, code=None, now=None):
        self.engine = os.path.abspath(engine)
        self.code = os.path.abspath(code or CODE_DEFAULT)
        self.now = now or os.environ.get("JOBS_NOW") or None
        p = os.path.join(self.engine, "config.json")
        self.config = {}
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                self.config = json.load(f)
        self.tmp = None
        self.plan_cache = None

    def tool(self, *p):
        return os.path.join(self.code, "src", "tools", *p)

    def workdir(self):
        if self.tmp is None:
            base = os.environ.get("RUNNER_TEMP") or None
            self.tmp = tempfile.mkdtemp(prefix="pjob-", dir=base)
            os.chmod(self.tmp, 0o700)
        return self.tmp

    def cleanup(self):
        if self.tmp and os.path.isdir(self.tmp) and not os.environ.get("JOBS_KEEP_WORKDIR"):
            shutil.rmtree(self.tmp, ignore_errors=True)
        self.tmp = None

    def recipient(self):
        """The site owner's address: config.json "ownerEmail", else the GMAIL_ADDRESS secret."""
        to = str(self.config.get("ownerEmail") or os.environ.get("GMAIL_ADDRESS") or "").strip()
        if not EMAIL_RE.match(to):
            raise JobError("email", "no owner address (config.json ownerEmail or GMAIL_ADDRESS)")
        return to

    def failure_recipient(self):
        return self.recipient()

    # ---- plan.js
    def plan(self, last_run=None):
        cmd = ["node", self.tool("plan.js")]
        if last_run:
            cmd += ["--lastRun", last_run]
        if self.now:
            cmd += ["--now", self.now]
        out = run(cmd, "plan")
        try:
            p = json.loads(out.strip().splitlines()[-1])
        except Exception:
            raise JobError("plan", "plan.js printed no JSON") from None
        m = re.match(r"^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})", p.get("nowCairo", ""))
        p["minuteOfDay"] = int(m.group(1)) * 60 + int(m.group(2)) if m else p["hour"] * 60
        self.plan_cache = p
        return p

    def today(self):
        """Cairo date for subjects; plan.js when possible, else zoneinfo (failure path only)."""
        if self.plan_cache:
            return self.plan_cache["today"]
        try:
            return self.plan()["today"]
        except Exception:
            return cairo_today()


def mail_keys_path(code):
    return os.path.join(code, "keys", "mail.json")


def mail_key(code):
    """The MAIL key's private half (keys/mail.json unwrapped with SETUP_KEY): opens the accounts' mail packages."""
    key = os.environ.get("SETUP_KEY", "").strip()
    if not key:
        raise JobError("mail key", "SETUP_KEY is not set")
    try:
        return store.unlock(store.load_keys(mail_keys_path(code)), key)
    except store.StoreError as e:
        raise JobError("mail key", str(e)) from None


def cairo_today():
    try:
        import zoneinfo
        return datetime.datetime.now(zoneinfo.ZoneInfo("Africa/Cairo")).strftime("%Y-%m-%d")
    except Exception:
        return datetime.datetime.utcnow().strftime("%Y-%m-%d")


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# ---------------------------------------------------------------- subprocess
def run(cmd, step, cwd=None, env=None, ok=(0,), timeout=900, stdout=None):
    """Run a tool quietly. Returns stdout (text) unless `stdout` is a path (then it is written there). On a bad exit code
    raises JobError(step, ...) with the tail of stderr (for the owner's email; the log masks it)."""
    e = dict(os.environ)
    if env:
        e.update(env)
    try:
        if stdout:
            with open(stdout, "wb") as fo:
                r = subprocess.run(cmd, cwd=cwd, env=e, stdout=fo, stderr=subprocess.PIPE, timeout=timeout)
            out = ""
        else:
            r = subprocess.run(cmd, cwd=cwd, env=e, capture_output=True, timeout=timeout)
            out = r.stdout.decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        raise JobError(step, f"timed out after {timeout} s") from None
    except FileNotFoundError as ex:
        raise JobError(step, f"cannot run {cmd[0]}: {ex}") from None
    if r.returncode not in ok:
        err = r.stderr.decode("utf-8", "replace").strip()
        # pdf.js "Cannot polyfill" warnings are noise; keep the meaningful tail
        err = "\n".join(l for l in err.splitlines() if "polyfill" not in l.lower())[-800:]
        raise JobError(step, f"exit {r.returncode}: {redact(err) or '(no error text)'}")
    run.last_code = r.returncode
    return out


run.last_code = 0


def git(repo, *args, check=True, env=None):
    e = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    if env:
        e.update(env)
    r = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, env=e)
    if check and r.returncode != 0:
        raise JobError("git", f"git {args[0]}: {redact((r.stderr or r.stdout).strip())[-400:]}")
    return r


def author_args(env_name, fallback):
    """git -c user.name/-c user.email from env '<Name> <email>' (set in the private workflow), else the fallback."""
    v = os.environ.get(env_name, "").strip() or fallback
    m = re.match(r"^\s*(.+?)\s*<([^<>\s]+@[^<>\s]+)>\s*$", v)
    name, email = (m.group(1), m.group(2)) if m else ("Portfolio jobs", "noreply@github.com")
    return ["-c", f"user.name={name}", "-c", f"user.email={email}"]


ENGINE_AUTHOR = "github-actions[bot] <github-actions[bot]@users.noreply.github.com>"


def has_origin(repo):
    return git(repo, "remote", check=False).stdout.split().count("origin") > 0


def engine_refresh(ctx):
    """Bring the engine checkout to origin/main (a scheduled run's checkout may be older than a queued run's start)."""
    if not has_origin(ctx.engine):
        return
    for i, wait in enumerate((0, 3, 6)):
        if wait:
            time.sleep(wait)
        r = git(ctx.engine, "fetch", "-q", "origin", "main", check=False)
        if r.returncode == 0:
            git(ctx.engine, "reset", "-q", "--hard", "origin/main")
            return
    raise JobError("git", "could not fetch the engine repository: " + redact(r.stderr.strip())[-300:])


def engine_commit(ctx, paths, message):
    """Commit the given engine-repo paths (jobs.json) and push. Returns the short head or None when
    there was nothing to commit. Raises PushRejected when origin moved meanwhile (the caller redoes its work)."""
    paths = sorted(set(paths))
    if not paths:
        return None
    for p in paths:
        if p != "jobs.json":
            raise JobError("git", f"refusing to commit {p} to the engine repository")
    git(ctx.engine, "add", "-A", "--", *paths)
    if not git(ctx.engine, "diff", "--cached", "--name-only").stdout.strip():
        return None
    git(ctx.engine, *author_args("ENGINE_COMMIT_AUTHOR", ENGINE_AUTHOR), "commit", "-q", "-m", message)
    head = git(ctx.engine, "rev-parse", "--short", "HEAD").stdout.strip()
    if not has_origin(ctx.engine):
        return head
    last = ""
    for wait in (0, 2, 4, 8):
        if wait:
            time.sleep(wait)
        r = git(ctx.engine, "push", "-q", "origin", "HEAD:main", check=False)
        if r.returncode == 0:
            return head
        last = r.stderr.strip()
        if "rejected" in last or "non-fast-forward" in last or "fetch first" in last:
            raise PushRejected()
    raise JobError("git", "push to the engine repository failed: " + redact(last)[-300:])


def load_data(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        x = json.load(f)
    return x.get("data", x) if isinstance(x, dict) and isinstance(x.get("data"), dict) else x


# ---------------------------------------------------------------- jobs.json (plain: dates and statuses only)
def jobs_state(ctx):
    p = os.path.join(ctx.engine, "jobs.json")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_jobs_state(ctx, st):
    def clean(v):  # only dates, statuses, month keys and small counts belong here
        if isinstance(v, dict):
            return {k: clean(x) for k, x in v.items()}
        if isinstance(v, (list, tuple)):
            return [clean(x) for x in v]
        if isinstance(v, float):
            raise JobError("jobs.json", "refusing to store a figure in jobs.json")
        return v
    with open(os.path.join(ctx.engine, "jobs.json"), "w", encoding="utf-8") as f:
        json.dump(clean(st), f, indent=1, sort_keys=True)
        f.write("\n")


def record_job(ctx, section, updates, message):
    """Merge `updates` into jobs.json[section] and push it at once (redone on a moved origin). For marks that must survive
    a later failure in the same run, e.g. "this month-end report was emailed" before the site publish."""
    for attempt in range(3):
        st = jobs_state(ctx)
        st.setdefault(section, {}).update(updates)
        save_jobs_state(ctx, st)
        try:
            engine_commit(ctx, ["jobs.json"], message)
            return
        except PushRejected:
            engine_refresh(ctx)
    raise JobError("record", "the engine repository kept changing")


# ---------------------------------------------------------------- time gate
def gate(plan, windows, done, manual):
    """windows: [(slot, from_minute, to_minute)] in Cairo local time; done: {slot: 'YYYY-MM-DD'} of runs already made.
    Returns (slot, reason): slot None = do not run. A manual run (workflow_dispatch) always runs, slot 'manual'."""
    if manual:
        return "manual", "started by hand"
    for slot, a, b in windows:
        if a <= plan["minuteOfDay"] < b:
            if done.get(slot) == plan["today"]:
                return None, f"the {slot} run already happened today"
            return slot, f"{slot} run"
    return None, "not the scheduled Cairo time"


# ---------------------------------------------------------------- failure handling
def failure_mark():
    return os.environ.get("JOBS_FAILURE_MARK") or os.path.join(os.environ.get("RUNNER_TEMP") or tempfile.gettempdir(), "portfolio-job-failure-mailed")


def report_failure(ctx_or_none, job, step, detail, engine=None, code=None):
    """Email 'Portfolio: <job> FAILED <date>' (step and error in the body) to the site owner, print the masked
    FAILED line, and leave a marker so the workflow's own failure step does not email twice."""
    import mail_send
    date = ctx_or_none.today() if ctx_or_none else cairo_today()
    import emails
    u = run_url()
    subj, body, html = emails.failure(job, date, step, detail, u[len("Run log: "):] if u.startswith("Run log: http") else None)
    try:
        sent = mail_send.send_failure(ctx_or_none, engine, code, subj, body, html)
        log(f"failure email: {sent}")
    except Exception as e:
        log(f"failure email could not be sent: {mask(e)}")
    try:
        open(failure_mark(), "w").write(job)
    except OSError:
        pass
    log(f"FAILED: {step}: {mask(detail)}")


def run_url():
    s, r, i = os.environ.get("GITHUB_SERVER_URL"), os.environ.get("GITHUB_REPOSITORY"), os.environ.get("GITHUB_RUN_ID")
    return f"Run log: {s}/{r}/actions/runs/{i}" if s and r and i else "Run log: (local run)"
