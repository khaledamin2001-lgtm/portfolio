#!/usr/bin/env python3
"""Shared plumbing for the engine-repo jobs (run_market.py, run_sync.py, publish.py, mail_send.py, imap_fetch.py).

The jobs run inside a PRIVATE engine repository's GitHub Actions workflow with two checkouts:
    engine/   the private repo: config.json, jobs.json, db/<collection>/<doc>.enc.json (see store.py)
    code/     the public site repo at main: src/tools/* (plan.js, sync.js, ...), src/jobs/* (this code), tools/*, p/<id>/keys.json
Nothing here holds private data, and nothing any job prints carries a portfolio figure or a secret: logs are counts and
statuses only. Plaintext documents exist only in a temporary work directory that is removed when the job ends.

config.json (plain, in the engine repo):
    {"portfolioId", "name", "siteRepo", "siteFolder", "timezone", "mode"?, "recipient"?, "marketEmail"?}
    recipient     the one address every email goes to (default: portfolio/settings.factsheetEmail)
    marketEmail   false = the market job sends no "market updated" email (default true)
    mode "live"   emails go out through Gmail and the site is pushed;
         "shadow" (the default when absent) the job does everything else - fetches, writes and commits the engine
                  repo's own data, builds reports, prepares the site commit - but sends no email (each one is saved
                  encrypted under outbox/ in the engine repo instead) and never pushes the site. Used for the side-by-side
                  weeks; switching over = setting "mode": "live". Env JOBS_MODE overrides (tests).
jobs.json (plain, in the engine repo): when each scheduled job last ran (dates and statuses only, never figures).

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
    """Someone else pushed to the engine repo meanwhile (e.g. an edit from the site): redo from fresh data."""


def short(m):
    """'2026-09' -> 'Sep-26'."""
    return f"{MON[int(m[5:7]) - 1]}-{m[2:4]}"


# ---------------------------------------------------------------- masking (logs only)
_SECRET_ENVS = ("SETUP_KEY", "GMAIL_APP_PASSWORD", "SITE_TOKEN", "GITHUB_TOKEN")


def redact(s):
    s = str(s)
    for k in _SECRET_ENVS:
        v = os.environ.get(k, "").strip()
        if len(v) >= 6:
            s = s.replace(v, "***")
            if k == "GMAIL_APP_PASSWORD":
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
class Ctx:
    """Everything a job needs about its engine repo, code checkout and keys."""
    def __init__(self, engine, code=None, now=None):
        self.engine = os.path.abspath(engine)
        self.code = os.path.abspath(code or CODE_DEFAULT)
        self.now = now or os.environ.get("JOBS_NOW") or None
        p = os.path.join(self.engine, "config.json")
        if not os.path.exists(p):
            raise JobError("config", "config.json is missing in the engine repository")
        with open(p, encoding="utf-8") as f:
            self.config = json.load(f)
        for k in ("portfolioId", "siteRepo", "siteFolder"):
            if not self.config.get(k):
                raise JobError("config", f"config.json has no {k}")
        if not re.match(r"^p/[a-z0-9_-]+$", self.config["siteFolder"]):
            raise JobError("config", "config.json siteFolder must look like p/<id>")
        self.mode = (os.environ.get("JOBS_MODE") or self.config.get("mode") or "shadow").strip().lower()
        if self.mode not in ("live", "shadow"):
            raise JobError("config", "mode must be live or shadow")
        self.keys_path = os.path.join(self.code, *self.config["siteFolder"].split("/"), "keys.json")
        if not os.path.exists(self.keys_path):
            raise JobError("config", f"{self.config['siteFolder']}/keys.json not found in the code checkout")
        self.keys = store.load_keys(self.keys_path)
        self._priv = None
        self.tmp = None
        self.plan_cache = None

    @property
    def live(self):
        return self.mode == "live"

    @property
    def priv(self):
        if self._priv is None:
            key = os.environ.get("SETUP_KEY", "").strip()
            if not key:
                raise JobError("unlock", "SETUP_KEY is not set")
            try:
                self._priv = store.unlock(self.keys, key)
            except store.StoreError as e:
                raise JobError("unlock", str(e)) from None
        return self._priv

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

    # ---- documents
    def materialize(self, out):
        if os.path.isdir(out):
            shutil.rmtree(out)
        try:
            return store.materialize(self.engine, self.keys, self.priv, out)
        except store.StoreError as e:
            raise JobError("decrypt", str(e)) from None

    def read(self, coll, doc):
        try:
            d = store.read_doc(self.engine, self.keys, self.priv, coll, doc)
        except store.StoreError as e:
            raise JobError("decrypt", str(e)) from None
        return d

    def settings(self):
        d = self.read("portfolio", "settings")
        return (d or {}).get("data") or {}

    def recipient(self):
        """The one address any job may email: config.json "recipient" when set (a portfolio whose owner does not get the
        emails himself, e.g. Yassin's: they go to Khaled), else portfolio/settings.factsheetEmail."""
        to = str(self.config.get("recipient") or self.settings().get("factsheetEmail") or "").strip()
        if not re.match(r"^[^@\s,;<>]+@[^@\s,;<>]+\.[A-Za-z]{2,}$", to):
            raise JobError("email", "portfolio/settings has no valid factsheetEmail")
        return to

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
    """Commit the given engine-repo paths (db files, jobs.json, outbox) and push. Returns the short head or None when
    there was nothing to commit. Raises PushRejected when origin moved meanwhile (the caller redoes its work)."""
    paths = sorted(set(paths))
    if not paths:
        return None
    for p in paths:
        if not (p.startswith("db/") or p == "jobs.json" or p.startswith("outbox/")):
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


def apply_and_commit(ctx, writes, message):
    """store.apply_writes + commit/push. Returns (result, head). VersionConflict/PushRejected propagate."""
    if not writes:
        return {"changed": [], "results": []}, None
    hook = os.environ.pop("JOBS_TEST_HOOK", None)      # tests only: simulate a concurrent edit, once per process
    if hook:
        subprocess.run(["bash", "-c", hook], check=True, capture_output=True)
    try:
        res = store.apply_writes(ctx.engine, ctx.keys, writes, ctx.priv)
    except store.VersionConflict:
        raise
    except store.StoreError as e:
        raise JobError("write", str(e)) from None
    head = engine_commit(ctx, res["changed"], message)
    return res, head


def versions_of(data_dir):
    """{'coll/doc': version} of a materialized directory."""
    out = {}
    for c in sorted(os.listdir(data_dir)):
        cd = os.path.join(data_dir, c)
        if not os.path.isdir(cd):
            continue
        for f in os.listdir(cd):
            if f.endswith(".json"):
                with open(os.path.join(cd, f), encoding="utf-8") as fh:
                    out[f"{c}/{f[:-5]}"] = json.load(fh).get("version", 1)
    return out


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
    """Email 'Portfolio: <job> FAILED <date>' (step and error in the body) to settings.factsheetEmail, print the masked
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
