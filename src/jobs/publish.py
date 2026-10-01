#!/usr/bin/env python3
"""Publish ONE portfolio's encrypted data (and month-end report files) to the public site repository.

    python3 publish.py --engine DIR [--code DIR] [--message MSG] [--force] [--no-push] [--remote URL|PATH]
                       [--exports DIR --index FILE]

1. Decrypts the engine repo's documents into a temporary folder (store.materialize) and encrypts them for the site
   with tools/export.py (the bundle the site decrypts), unless the documents are unchanged since the
   last publish (<siteFolder>/data.fingerprint; --force re-encrypts anyway).
2. Clones the site repository (config.siteRepo, main) over HTTPS with SITE_TOKEN (sent as an HTTP header, never in a
   URL or a log), writes ONLY <siteFolder>/data.enc.json, <siteFolder>/data.fingerprint and, with --exports,
   <siteFolder>/exports/<name>.enc.json + <siteFolder>/exports/index.json (--index = a JSON list of entries; each
   replaces the entry for the same month, the list is kept sorted by month, newest first).
3. Refuses (nothing committed) when any changed path is outside <siteFolder>/, is not *.enc.json / exports/index.json /
   data.fingerprint, or a *.enc.json is not an encrypted envelope.
4. Commits as SITE_COMMIT_AUTHOR ("Name <email>", set in the private workflow) and pushes to main. When the push is
   rejected (someone pushed meanwhile) or the network fails, it re-clones the state of origin/main, re-writes the
   files and tries again (waits 2, 4, 8, 16 s).
Only this portfolio's folder is ever touched; the other portfolio's files are never read or written.
--no-push stops after the local commit. --remote overrides the clone source (tests: a local bare repo).
Prints ONE JSON line {"ok", "committed", "pushed", "dataUnchanged", "head", "files"}; exit 1 with {"ok": false, "error"}.
"""
import os, re, sys, json, time, base64, shutil, argparse, importlib.util, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import jobs_common as jc  # noqa: E402

ALLOWED = re.compile(r"^(data\.enc\.json|data\.fingerprint|exports/[A-Za-z0-9][A-Za-z0-9._-]*\.enc\.json|exports/index\.json)$")
ENC_KEYS = {"v", "at", "name", "bytes", "epk", "iv", "ct"}
B64 = re.compile(r"^[A-Za-z0-9+/_-]+=*$")
COLLECTIONS = ["portfolio", "ledger", "market", "history", "bench", "imports", "sync"]   # what tools/export.py reads


def is_envelope(path):
    try:
        with open(path, encoding="utf-8") as f:
            e = json.load(f)
    except Exception:
        return False
    return (isinstance(e, dict) and {"v", "epk", "iv", "ct"} <= set(e) and set(e) <= ENC_KEYS
            and all(isinstance(e[k], str) and B64.match(e[k]) for k in ("epk", "iv", "ct")) and len(e["ct"]) >= 16)


def fingerprint(ctx, src):
    """sha256 of the export's documents (as tools/export.py reads them), key-sorted; version stamps are ignored. Equal
    fingerprints mean the published data would not change, so nothing is re-encrypted or pushed."""
    import hashlib
    docs = {}
    for c in COLLECTIONS:
        d = os.path.join(src, c)
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            if f.endswith(".json"):
                x = json.load(open(os.path.join(d, f)))
                docs[f"{c}/{f[:-5]}"] = x.get("data", x) if isinstance(x, dict) else x
    return hashlib.sha256(json.dumps(docs, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _auth_env():
    tok = os.environ.get("SITE_TOKEN", "").strip()
    if not tok:
        return {}
    hdr = "AUTHORIZATION: basic " + base64.b64encode(f"x-access-token:{tok}".encode()).decode()
    # GIT_CONFIG_* passes the header to git without it appearing on a command line or in .git/config
    return {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader", "GIT_CONFIG_VALUE_0": hdr}


def clone(ctx, remote, dest):
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    env = _auth_env() if remote.startswith("https://github.com/") else {}
    if remote.startswith("https://github.com/") and not env:
        raise jc.JobError("publish", "SITE_TOKEN is not set")
    last = ""
    for wait in (0, 2, 4, 8):
        if wait:
            time.sleep(wait)
        r = subprocess.run(["git", "clone", "-q", "--depth", "30", "--branch", "main", remote, dest], capture_output=True,
                           text=True, env=dict(os.environ, GIT_TERMINAL_PROMPT="0", **env))
        if r.returncode == 0:
            return env
        last = r.stderr.strip()
        shutil.rmtree(dest, ignore_errors=True)
    raise jc.JobError("publish", "could not clone the site repository: " + jc.redact(last)[-300:])


def write_files(ctx, site, export_dir, fp, exports, index_entries, force):
    """Write this portfolio's files into the site clone. Returns dataUnchanged (bool)."""
    folder = os.path.join(site, *ctx.config["siteFolder"].split("/"))
    keys = os.path.join(folder, "keys.json")
    if not os.path.exists(keys):
        raise jc.JobError("publish", f"{ctx.config['siteFolder']}/keys.json is missing in the site repository")
    with open(keys) as f:
        if json.load(f).get("pub") != ctx.keys.get("pub"):
            raise jc.JobError("publish", "the site's keys.json is not the key the engine data is locked with")
    out, fpf = os.path.join(folder, "data.enc.json"), os.path.join(folder, "data.fingerprint")
    unchanged = (not force and os.path.exists(out) and os.path.exists(fpf) and open(fpf).read().strip() == fp)
    if not unchanged:
        res = jc.run([sys.executable, os.path.join(ctx.code, "tools", "export.py"), export_dir, keys, out], "publish: encrypt")
        if '"ok": true' not in res:
            raise jc.JobError("publish: encrypt", "export.py did not report ok")
        with open(fpf, "w") as f:
            f.write(fp + "\n")
    if exports:
        ed = os.path.join(folder, "exports")
        os.makedirs(ed, exist_ok=True)
        for name in sorted(os.listdir(exports)):
            src = os.path.join(exports, name)
            if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.enc\.json$", name) or not is_envelope(src):
                raise jc.JobError("publish", f"refusing to publish {name}: not an encrypted .enc.json file")
            shutil.copyfile(src, os.path.join(ed, name))
    if index_entries:
        ip = os.path.join(folder, "exports", "index.json")
        cur = []
        if os.path.exists(ip):
            with open(ip, encoding="utf-8") as f:
                cur = json.load(f)
            if not isinstance(cur, list):
                raise jc.JobError("publish", "exports/index.json is not a list")
        months = {e["month"] for e in index_entries}
        cur = [e for e in cur if e.get("month") not in months] + list(index_entries)
        cur.sort(key=lambda e: e.get("month", ""), reverse=True)
        with open(ip, "w", encoding="utf-8") as f:
            json.dump(cur, f, separators=(",", ":"), ensure_ascii=False)
    return unchanged


def check_changes(ctx, site):
    """Every changed path must be one this job may publish; returns the list."""
    r = jc.git(site, "status", "--porcelain", "-uall", "--no-renames")
    paths = [l[3:].strip().strip('"') for l in r.stdout.splitlines() if l.strip()]
    pre = ctx.config["siteFolder"].rstrip("/") + "/"
    bad = [p for p in paths if not p.startswith(pre) or not ALLOWED.match(p[len(pre):])]
    bad += [p for p in paths if p.endswith(".enc.json") and os.path.exists(os.path.join(site, p)) and not is_envelope(os.path.join(site, p))]
    if bad:
        raise jc.JobError("publish", f"refusing to publish {len(bad)} file(s) that are not this portfolio's encrypted files: {', '.join(sorted(set(bad))[:5])}")
    return sorted(paths)


def publish(ctx, message, exports=None, index_entries=None, push=True, remote=None, force=False):
    work = ctx.workdir()
    export_dir = os.path.join(work, "publish-export")
    ctx.materialize(export_dir)
    for c in os.listdir(export_dir):         # only what export.py reads; nothing else leaves the engine
        if c not in COLLECTIONS:
            shutil.rmtree(os.path.join(export_dir, c))
    fp = fingerprint(ctx, export_dir)
    remote = remote or os.environ.get("SITE_REMOTE") or f"https://github.com/{ctx.config['siteRepo']}.git"
    site = os.path.join(work, "site")
    author = jc.author_args("SITE_COMMIT_AUTHOR", "Portfolio jobs <noreply@github.com>")
    last = None
    try:
        for attempt, wait in enumerate((0, 2, 4, 8, 16)):
            if wait:
                time.sleep(wait)
            env = clone(ctx, remote, site)
            unchanged = write_files(ctx, site, export_dir, fp, exports, index_entries, force)
            paths = check_changes(ctx, site)
            if not paths:
                return {"ok": True, "committed": False, "pushed": False, "dataUnchanged": unchanged,
                        "head": jc.git(site, "rev-parse", "--short", "HEAD").stdout.strip(), "files": []}
            jc.git(site, "add", "--", *paths)
            staged = sorted(jc.git(site, "diff", "--cached", "--name-only").stdout.split())
            if staged != paths:
                raise jc.JobError("publish", "staged files differ from the checked list")
            jc.git(site, *author, "commit", "-q", "-m", message)
            head = jc.git(site, "rev-parse", "HEAD").stdout.strip()
            if not push:
                return {"ok": True, "committed": True, "pushed": False, "dataUnchanged": unchanged, "head": head[:7], "files": paths}
            hook = os.environ.pop("JOBS_TEST_SITE_HOOK", None)     # tests only: someone pushes to the site meanwhile
            if hook:
                subprocess.run(["bash", "-c", hook], check=True, capture_output=True)
            r = subprocess.run(["git", "-C", site, "push", "-q", "origin", "HEAD:main"], capture_output=True, text=True,
                               env=dict(os.environ, GIT_TERMINAL_PROMPT="0", **env))
            if r.returncode == 0:
                jc.git(site, "fetch", "-q", "origin", "main", env=env)
                remote_head = jc.git(site, "rev-parse", "origin/main").stdout.strip()
                if remote_head != head:
                    raise jc.JobError("publish", f"push did not land: origin/main {remote_head[:7]} != {head[:7]}")
                return {"ok": True, "committed": True, "pushed": True, "dataUnchanged": unchanged, "head": head[:7], "files": paths}
            last = jc.redact(r.stderr.strip())[-300:]
        raise jc.JobError("publish", f"push failed after retries: {last}")
    finally:
        shutil.rmtree(export_dir, ignore_errors=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Publish this portfolio's encrypted data to the site repository.")
    ap.add_argument("--engine", required=True)
    ap.add_argument("--code")
    ap.add_argument("--message")
    ap.add_argument("--force", action="store_true", help="re-encrypt even when the documents are unchanged")
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--remote")
    ap.add_argument("--exports", help="folder of *.enc.json report files to add under <siteFolder>/exports/")
    ap.add_argument("--index", help="JSON list of exports/index.json entries to merge")
    ap.add_argument("--now")
    ap.add_argument("--job", default="publish", help="name used in the FAILED email")
    a = ap.parse_args(argv)
    ctx = None
    try:
        ctx = jc.Ctx(a.engine, a.code, a.now)
        jc.engine_refresh(ctx)      # publish the newest data, not the checkout as it was when this workflow started
        plan = ctx.plan()
        idx = json.load(open(a.index)) if a.index else None
        push = not a.no_push
        r = publish(ctx, a.message or f"Data update {plan['today']}", a.exports, idx, push=push, remote=a.remote, force=a.force)
        st = jc.jobs_state(ctx)
        st.setdefault("publish", {}).update({"lastRun": plan["today"], "at": jc.now_iso(), "status": "ok", "head": r.get("head")})
        jc.save_jobs_state(ctx, st)
        try:
            jc.engine_commit(ctx, ["jobs.json"], f"jobs: publish {plan['today']}")
        except jc.PushRejected:
            pass        # bookkeeping only; the next job records it
        print(json.dumps(r))
        return 0
    except jc.JobError as e:
        jc.report_failure(ctx, a.job, e.step, e.detail, a.engine, a.code)
        print(json.dumps({"ok": False, "error": jc.mask(str(e))}))
        return 1
    finally:
        if ctx:
            ctx.cleanup()


if __name__ == "__main__":
    sys.exit(main())
